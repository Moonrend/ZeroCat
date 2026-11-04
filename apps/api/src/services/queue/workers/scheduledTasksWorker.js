import { Worker } from 'bullmq';
import { createConnection } from '../redisConnectionFactory.js';
import { QUEUE_NAMES } from '../queues.js';
import memoryCache from '../../memoryCache.js';
import logger from '../../logger.js';
import zcconfig from '../../config/zcconfig.js';

let worker = null;

const taskHandlers = new Map();

const REMOTE_VIEW_COUNT_KEYS = ['mirror.remote_view_count', 'mirror40.remote_view_count'];

// Register built-in task handlers
taskHandlers.set('hourly-cleanup', async (data, job) => {
    await job.log('Executing hourly cleanup');
});

taskHandlers.set('daily-stats', async (data, job) => {
    await job.log('Executing daily stats');

    const { prisma } = await import('../../prisma.js');

    const updatedRows = await prisma.$queryRawUnsafe(
        `
        WITH local_pageviews AS (
            SELECT
                e.target_id AS project_id,
                COUNT(*)::bigint AS pageviews
            FROM ow_analytics_event e
            WHERE e.target_type = 'project'
            GROUP BY e.target_id
        ),
        local_visitors AS (
            SELECT
                e.target_id AS project_id,
                COUNT(
                    DISTINCT COALESCE(
                        e.device_id::text,
                        CASE WHEN e.user_id IS NOT NULL THEN 'u:' || e.user_id::text ELSE NULL END,
                        CASE WHEN e.ip_address IS NOT NULL AND e.ip_address <> '' THEN 'ip:' || e.ip_address ELSE NULL END,
                        'ev:' || e.id::text
                    )
                )::bigint AS visitors
            FROM ow_analytics_event e
            WHERE e.target_type = 'project'
            GROUP BY e.target_id
        ),
        remote_views AS (
            SELECT
                tc.target_id::int AS project_id,
                MAX(
                    CASE
                        WHEN tc.value ~ '^[0-9]+$' THEN tc.value::bigint
                        ELSE 0
                    END
                )::bigint AS remote_view_count
            FROM project_config tc
            WHERE tc.target_type = 'project'
              AND tc.key = ANY($1::text[])
              AND tc.target_id ~ '^[0-9]+$'
            GROUP BY tc.target_id
        ),
        aggregated AS (
            SELECT
                p.id AS project_id,
                LEAST(
                    2147483647,
                    GREATEST(
                        0,
                        COALESCE(lp.pageviews, 0) + COALESCE(lv.visitors, 0) + COALESCE(rv.remote_view_count, 0)
                    )
                )::int AS total_view_count
            FROM ow_projects p
            LEFT JOIN local_pageviews lp ON lp.project_id = p.id
            LEFT JOIN local_visitors lv ON lv.project_id = p.id
            LEFT JOIN remote_views rv ON rv.project_id = p.id
        )
        UPDATE ow_projects p
        SET view_count = a.total_view_count
        FROM aggregated a
        WHERE p.id = a.project_id
          AND p.view_count IS DISTINCT FROM a.total_view_count
        RETURNING p.id
        `,
        REMOTE_VIEW_COUNT_KEYS
    );

    const updatedCount = Array.isArray(updatedRows) ? updatedRows.length : 0;
    await job.log(`Daily stats sync done: updated ${updatedCount} project view_count records`);
});

taskHandlers.set('memory-cache-cleanup', async (data, job) => {
    await job.log('Executing memory cache cleanup');
    memoryCache.cleanup();
    await job.log('Memory cache cleanup done');
});

taskHandlers.set('extension-sync', async (data, job) => {
    await job.log('Executing extension sync');
    try {
        const { getAllApprovedProjectIds } = await import('../../extensionReview.js');
        const { prisma } = await import('../../prisma.js');
        const approvedIds = await getAllApprovedProjectIds();
        await job.log(`Found ${approvedIds.length} approved extensions`);

        let synced = 0;
        for (let offset = 0; offset < approvedIds.length; offset += 1000) {
            const batch = approvedIds.slice(offset, offset + 1000);
            const projects = await prisma.ow_projects.findMany({
                where: { id: { in: batch } },
                select: { id: true, default_branch: true },
            });
            const projectById = new Map(projects.map(project => [project.id, project]));
            for (const projectId of batch) {
                const project = projectById.get(projectId);
                if (!project) continue;

                // Keep ordered upserts: an error still leaves only preceding entries synced.
                await prisma.ow_scratch_extensions.upsert({
                    where: { projectid: projectId },
                    update: { status: 'verified', commit: 'latest' },
                    create: {
                        projectid: projectId,
                        status: 'verified',
                        commit: 'latest',
                        branch: project.default_branch || '',
                        image: '',
                    },
                });
                synced++;
            }
        }

        await job.log(`Synced ${synced} extensions`);
    } catch (err) {
        await job.log(`ERROR: extension-sync failed: ${err.message}`);
        throw err;
    }
});

taskHandlers.set('sitemap-auto-update', async (data, job) => {
    await job.log('Executing sitemap auto update');
    try {
        const sitemapService = (await import('../../sitemap.js')).default;
        await sitemapService.generateIncrementalSitemap();
        await job.log('Sitemap updated successfully');
    } catch (err) {
        await job.log(`ERROR: sitemap-auto-update failed: ${err.message}`);
        throw err;
    }
});

taskHandlers.set('embedding-daily-project-check', async (data, job) => {
    await job.log('Executing embedding daily project check (fill missing project embeddings only)');

    const embeddingEnabled = await zcconfig.get('embedding.enabled', false);
    if (!embeddingEnabled) {
        await job.log('Embedding disabled, skip daily project check');
        return;
    }

    const minViewCount = Math.max(0, Number(await zcconfig.get('embedding.periodic.project_check.min_view_count', 100)) || 100);
    const minStarCount = Math.max(0, Number(await zcconfig.get('embedding.periodic.project_check.min_star_count', 10)) || 10);
    const scanLimit = Math.max(1, Number(await zcconfig.get('embedding.periodic.project_check.scan_limit', 2000)) || 2000);

    const [{ prisma }, { getEmbeddingQueue }] = await Promise.all([
        import('../../prisma.js'),
        import('../queues.js'),
    ]);

    const embeddingQueue = getEmbeddingQueue();
    if (!embeddingQueue) {
        await job.log('Embedding queue unavailable, skip daily project check');
        return;
    }

    const candidates = await prisma.$queryRawUnsafe(
        `
        SELECT p.id
        FROM ow_projects p
        LEFT JOIN ow_embeddings e
            ON e.entity_type = 'project'
         AND e.entity_id = p.id
        LEFT JOIN (
                SELECT
                target_id AS project_id,
                        COUNT(*)::int AS local_view_count
                FROM ow_analytics_event
                WHERE target_type = 'project'
                GROUP BY target_id
        ) av
            ON av.project_id = p.id
        LEFT JOIN LATERAL (
                SELECT
                        CASE
                                WHEN tc.value ~ '^[0-9]+$' THEN tc.value::int
                                ELSE 0
                        END AS remote_view_count
                FROM project_config tc
                WHERE tc.target_type = 'project'
                    AND tc.target_id = p.id::text
                    AND tc.key IN ('mirror.remote_view_count', 'mirror40.remote_view_count')
                ORDER BY tc.updated_at DESC
                LIMIT 1
        ) rv ON true
        LEFT JOIN (
                SELECT
                        projectid AS project_id,
                        COUNT(*)::int AS star_count
                FROM ow_projects_stars
                WHERE projectid IS NOT NULL
                GROUP BY projectid
        ) ps
            ON ps.project_id = p.id
        WHERE e.id IS NULL
            AND COALESCE(p.type, '') = 'scratch'
            AND COALESCE(p.state, '') <> 'deleted'
            AND (
                (COALESCE(av.local_view_count, 0) + COALESCE(rv.remote_view_count, 0)) > $1
                OR COALESCE(ps.star_count, 0) > $2
            )
        ORDER BY
            (COALESCE(av.local_view_count, 0) + COALESCE(rv.remote_view_count, 0)) DESC,
            COALESCE(ps.star_count, 0) DESC,
            p.id DESC
        LIMIT $3
        `,
        Number(minViewCount),
        Number(minStarCount),
        Number(scanLimit)
    );

    const projectIds = (Array.isArray(candidates) ? candidates : [])
        .map((item) => Number(item?.id))
        .filter((id) => Number.isFinite(id) && id > 0);

    await job.log(`Found ${projectIds.length} projects missing embeddings (first-time fill only)`);

    let enqueued = 0;
    let duplicated = 0;
    let failed = 0;

    for (const projectId of projectIds) {
        const jobId = `emb-project-${projectId}`;
        try {
            await embeddingQueue.add('embedding', {
                type: 'project_embedding',
                projectId,
                force: false,
                triggerType: 'daily-project-check',
            }, {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 15000 },
                removeOnComplete: { age: 86400 },
                removeOnFail: { age: 604800 },
                deduplication: { id: jobId },
            });
            enqueued += 1;
        } catch (error) {
            if (String(error?.message || '').includes('Job is already waiting')) {
                duplicated += 1;
            } else {
                failed += 1;
                logger.warn(`[scheduled-worker] embedding-daily-project-check enqueue failed project=${projectId} error=${error.message}`);
            }
        }
    }

    await job.log(`Embedding daily project check done: enqueued=${enqueued}, duplicated=${duplicated}, failed=${failed}`);
});

taskHandlers.set('embedding-user-refresh', async (data, job) => {
    await job.log('Executing embedding user refresh (higher frequency local algorithm updates)');

    const embeddingEnabled = await zcconfig.get('embedding.enabled', false);
    if (!embeddingEnabled) {
        await job.log('Embedding disabled, skip user refresh');
        return;
    }

    const lookbackHours = Math.max(1, Number(await zcconfig.get('embedding.periodic.user_refresh.lookback_hours', 24)) || 24);
    const scanLimit = Math.max(1, Number(await zcconfig.get('embedding.periodic.user_refresh.scan_limit', 1200)) || 1200);

    const [{ prisma }, { getEmbeddingQueue }] = await Promise.all([
        import('../../prisma.js'),
        import('../queues.js'),
    ]);

    const embeddingQueue = getEmbeddingQueue();
    if (!embeddingQueue) {
        await job.log('Embedding queue unavailable, skip user refresh');
        return;
    }

    const activeUsers = await prisma.$queryRawUnsafe(
        `
        WITH active_users AS (
            SELECT p.author_id AS user_id
            FROM ow_posts p
            WHERE p.author_id IS NOT NULL
              AND p.created_at >= (NOW() - ($1::text || ' hours')::interval)
            UNION
            SELECT pl.user_id AS user_id
            FROM ow_posts_like pl
            WHERE pl.user_id IS NOT NULL
              AND pl.created_at >= (NOW() - ($1::text || ' hours')::interval)
            UNION
            SELECT pb.user_id AS user_id
            FROM ow_posts_bookmark pb
            WHERE pb.user_id IS NOT NULL
              AND pb.created_at >= (NOW() - ($1::text || ' hours')::interval)
            UNION
            SELECT ps.userid AS user_id
            FROM ow_projects_stars ps
            WHERE ps.userid IS NOT NULL
              AND ps.createTime >= (NOW() - ($1::text || ' hours')::interval)
        )
        SELECT DISTINCT au.user_id AS id
        FROM active_users au
        WHERE au.user_id > 0
        ORDER BY au.user_id DESC
        LIMIT $2
        `,
        Number(lookbackHours),
        Number(scanLimit)
    );

    const userIds = (Array.isArray(activeUsers) ? activeUsers : [])
        .map((item) => Number(item?.id))
        .filter((id) => Number.isFinite(id) && id > 0);

    await job.log(`Found ${userIds.length} active users for embedding refresh`);

    let enqueued = 0;
    let duplicated = 0;
    let failed = 0;

    for (const userId of userIds) {
        const jobId = `emb-user-${userId}`;
        try {
            await embeddingQueue.add('embedding', {
                type: 'user_embedding',
                userId,
                force: false,
                triggerType: 'periodic-user-refresh',
            }, {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 15000 },
                removeOnComplete: { age: 86400 },
                removeOnFail: { age: 604800 },
                deduplication: { id: jobId },
            });
            enqueued += 1;
        } catch (error) {
            if (String(error?.message || '').includes('Job is already waiting')) {
                duplicated += 1;
            } else {
                failed += 1;
                logger.warn(`[scheduled-worker] embedding-user-refresh enqueue failed user=${userId} error=${error.message}`);
            }
        }
    }

    await job.log(`Embedding user refresh done: enqueued=${enqueued}, duplicated=${duplicated}, failed=${failed}`);
});

taskHandlers.set('embedding-project-gorse-sync', async (data, job) => {
    await job.log('Executing high-frequency project gorse sync');

    const embeddingEnabled = await zcconfig.get('embedding.enabled', false);
    if (!embeddingEnabled) {
        await job.log('Embedding disabled, skip project gorse sync');
        return;
    }

    const scanLimit = Math.max(1, Number(await zcconfig.get('embedding.periodic.project_gorse_sync.scan_limit', 800)) || 800);

    const [{ prisma }, { getEmbeddingQueue }] = await Promise.all([
        import('../../prisma.js'),
        import('../queues.js'),
    ]);

    const embeddingQueue = getEmbeddingQueue();
    if (!embeddingQueue) {
        await job.log('Embedding queue unavailable, skip project gorse sync');
        return;
    }

    const rows = await prisma.$queryRawUnsafe(
        `
        SELECT p.id
        FROM ow_projects p
        JOIN ow_embeddings e
          ON e.entity_type = 'project'
         AND e.entity_id = p.id
        WHERE COALESCE(p.state, '') <> 'deleted'
        ORDER BY p.time DESC, p.id DESC
        LIMIT $1
        `,
        Number(scanLimit)
    );

    const projectIds = (Array.isArray(rows) ? rows : [])
        .map((item) => Number(item?.id))
        .filter((id) => Number.isFinite(id) && id > 0);

    await job.log(`Found ${projectIds.length} projects for gorse sync`);

    const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
    let enqueued = 0;
    let duplicated = 0;
    let failed = 0;

    for (const projectId of projectIds) {
        const jobId = `gorse-project-${projectId}-${bucket}`;
        try {
            await embeddingQueue.add('embedding', {
                type: 'project_gorse_sync',
                projectId,
                reason: 'periodic-project-gorse-sync',
            }, {
                jobId,
                attempts: 5,
                backoff: { type: 'exponential', delay: 20000 },
                removeOnComplete: { age: 86400 },
                removeOnFail: { age: 604800 },
                deduplication: { id: jobId },
            });
            enqueued += 1;
        } catch (error) {
            if (String(error?.message || '').includes('Job is already waiting')) {
                duplicated += 1;
            } else {
                failed += 1;
                logger.warn(`[scheduled-worker] embedding-project-gorse-sync enqueue failed project=${projectId} error=${error.message}`);
            }
        }
    }

    await job.log(`Embedding project gorse sync done: enqueued=${enqueued}, duplicated=${duplicated}, failed=${failed}`);
});

function registerTaskHandler(name, handler) {
    taskHandlers.set(name, handler);
    logger.info(`[scheduled-worker] Task handler "${name}" registered`);
}

async function createScheduledTasksWorker() {
    const connection = await createConnection('worker-scheduled');

    worker = new Worker(
        QUEUE_NAMES.SCHEDULED_TASKS,
        async (job) => {
            const taskName = job.name;
            await job.log(`Starting task "${taskName}"`);

            const handler = taskHandlers.get(taskName);
            if (!handler) {
                await job.log(`ERROR: No handler registered for task "${taskName}"`);
                throw new Error(`No handler registered for task "${taskName}"`);
            }

            await handler(job.data, job);
            await job.log(`Task "${taskName}" completed`);
            return { task: taskName, completedAt: new Date().toISOString() };
        },
        {
            connection,
            concurrency: 1,
        }
    );

    worker.on('completed', (job) => {
        logger.debug(`[scheduled-worker] Job ${job.id} (${job.name}) completed`);
    });

    worker.on('failed', (job, err) => {
        logger.error(`[scheduled-worker] Job ${job?.id} (${job?.name}) failed:`, err.message);
    });

    worker.on('error', (err) => {
        logger.error('[scheduled-worker] Worker error:', err.message);
    });

    logger.info('[scheduled-worker] Scheduled tasks worker started');
    return worker;
}

function getScheduledTasksWorker() {
    return worker;
}

export { createScheduledTasksWorker, getScheduledTasksWorker, registerTaskHandler };
