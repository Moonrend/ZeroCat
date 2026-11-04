/**
 * Embedding 向量生成 Worker
 *
 * 处理两类任务：
 * 1. post_embedding  — 为帖子生成向量 → 存入 pgvector → 同步到 Gorse
 * 2. user_embedding  — 为用户生成向量 → 存入 pgvector → 同步到 Gorse
 *
 * 用户向量采用“基础语料 + 互动兴趣”融合策略：
 * - 基础语料：同名 README 项目源码 + 昵称/简介 + 用户作品标题/简介
 * - 互动兴趣：帖子/点赞/收藏/转贴 + 作品(自有/收藏)向量，按行为权重 + 热度增强 + 时间衰减合并
 * - 融合结果写入 pgvector，同时记录 ow_user_embedding_updates 追踪兴趣变化
 */
import { Worker } from 'bullmq';
import { createConnection } from '../redisConnectionFactory.js';
import { QUEUE_NAMES } from '../queues.js';
import zcconfig from '../../config/zcconfig.js';
import logger from '../../logger.js';
import { prisma } from '../../prisma.js';
import { hydrateProjectFile } from '../../projectFileStorage.js';
import embeddingService from '../../embedding.js';
import gorseService from '../../gorse.js';
import { visibleWhere, canViewContent } from '../../moderation/visibility.js';

let worker = null;

function previewText(value, max = 220) {
    const text = String(value || '').replace(/[\n\r\t]+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ======================== 帖子向量生成 ========================

async function processPostEmbedding(job) {
    const { postId, force = false } = job.data;
    await job.log(`开始处理帖子 ${postId} 的向量生成 (force=${force})`);

    // 查询帖子
    const post = await prisma.ow_posts.findUnique({
        where: { id: postId },
        select: {
            id: true,
            author_id: true,
            post_type: true,
            content: true,
            embed: true,
            is_deleted: true,
            retweet_post_id: true,
            created_at: true,
        },
    });

    if (!post) {
        await job.log(`帖子 ${postId} 不存在，跳过`);
        return { skipped: true, reason: 'not_found' };
    }

    // 纯转推不生成向量
    if (post.post_type === 'retweet') {
        await job.log(`帖子 ${postId} 是纯转推，跳过`);
        return { skipped: true, reason: 'retweet' };
    }

    if (post.is_deleted || !await canViewContent('post', post, null)) {
        await job.log(`帖子 ${postId} 已删除，跳过`);
        return { skipped: true, reason: 'deleted' };
    }

    if (!force) {
        const existedVector = await embeddingService.getEmbedding('post', postId);
        if (Array.isArray(existedVector) && existedVector.length > 0) {
            await job.log(`帖子 ${postId} 已有向量，按固定策略不重算`);
            return { skipped: true, reason: 'already_embedded' };
        }
    }

    // 构建文本
    const text = embeddingService.buildPostText(post);
    if (!text || text.trim().length === 0) {
        await job.log(`帖子 ${postId} 无有效文本，跳过`);
        return { skipped: true, reason: 'empty_text' };
    }
    logger.debug(`[embedding-worker] post=${postId} textLen=${text.length} preview="${previewText(text)}"`);

    // 检查文本是否已变化（change detection）
    const newHash = embeddingService.hashText(text);
    if (!force) {
        const oldHash = await embeddingService.getTextHash('post', postId);
        logger.debug(`[embedding-worker] post=${postId} hash old=${oldHash || 'none'} new=${newHash}`);
        if (oldHash === newHash) {
            await job.log(`帖子 ${postId} 文本未变化 (hash=${newHash})，跳过`);
            return { skipped: true, reason: 'unchanged' };
        }
    }

    // 生成向量
    const config = await getModelInfo();
    const vector = await embeddingService.generateEmbedding(text);
    if (!vector) {
        throw new Error(`帖子 ${postId} 向量生成返回空`);
    }

    await job.log(`帖子 ${postId} 向量已生成 (dim=${vector.length})`);

    // 存入 pgvector
    await embeddingService.saveEmbedding('post', postId, vector, newHash, config.model);
    await job.log(`帖子 ${postId} 向量已存入 PostgreSQL`);

    // 更新帖子的 embedding_at 时间戳
    await prisma.ow_posts.update({
        where: { id: postId },
        data: { embedding_at: new Date() },
    });

    // 同步到 Gorse
    await syncPostToGorse(post, vector);
    await job.log(`帖子 ${postId} 向量已同步到 Gorse`);

    return { postId, dimensions: vector.length, hash: newHash };
}

// ======================== 项目向量生成（Scratch） ========================

function addClean(str, set) {
    if (typeof str !== 'string') return;
    const clean = str.replace(/[\n\r\t]+/g, ' ').trim();
    if (clean) set.add(clean);
}

function extractScratchMetadata(data, result = new Set()) {
    if (!data || typeof data !== 'object') return result;

    for (const key in data) {
        const value = data[key];

        if (['name', 'text', 'spriteName', 'proccode'].includes(key) && typeof value === 'string') {
            addClean(value, result);
        }

        if (key === 'variables' && value && typeof value === 'object') {
            for (const id in value) {
                if (Array.isArray(value[id]) && value[id][0]) addClean(value[id][0], result);
            }
        }

        if (key === 'lists' && value && typeof value === 'object') {
            for (const id in value) {
                if (Array.isArray(value[id]) && value[id][0]) addClean(value[id][0], result);
            }
        }

        if (key === 'broadcasts' && value && typeof value === 'object') {
            for (const id in value) {
                if (typeof value[id] === 'string') addClean(value[id], result);
            }
        }

        if (value && typeof value === 'object') {
            extractScratchMetadata(value, result);
        }
    }

    return result;
}

function ensureWebpSuffix(path) {
    const raw = String(path || '').trim();
    if (!raw) return raw;

    const [pathname, query = ''] = raw.split('?');
    const normalized = /\.webp$/i.test(pathname)
        ? pathname
        : `${pathname.replace(/\.[a-z0-9]{2,6}$/i, '')}.webp`;

    return query ? `${normalized}?${query}` : normalized;
}

function buildAssetUrl(staticBase, value) {
    const raw = String(value || '').trim();
    if (!raw || !staticBase) return null;
    const baseName = raw.replace(/\.[a-z0-9]{2,6}$/i, '');
    const p1 = baseName.substring(0, 2);
    const p2 = baseName.substring(2, 4);
    const filename = `${baseName}.webp`;
    return `${staticBase}/assets/${p1}/${p2}/${filename}`;
}

async function fetchProjectLatestSource(projectId) {
    const rows = await prisma.$queryRawUnsafe(`
        SELECT pf.sha256, pf.source, pf.create_time, pf.create_userid,
               pf.storage_provider, pf.storage_bucket, pf.storage_key,
               pf.content_size, pf.content_sha256, pf.content_type
        FROM ow_projects_commits pc
        JOIN ow_projects_file pf ON pf.sha256 = pc.commit_file
        WHERE pc.project_id = $1
        ORDER BY pc.commit_date DESC
        LIMIT 1
    `, Number(projectId));

    const file = rows?.[0] ? await hydrateProjectFile(rows[0]) : null;
    return String(file?.source || '');
}

function parseScratchProjectJson(source) {
    if (!source) return null;
    if (typeof source === 'object') return source;
    if (typeof source !== 'string') return null;

    try {
        return JSON.parse(source);
    } catch {
        return null;
    }
}

async function buildProjectCoverUrl(thumbnail) {
    const raw = String(thumbnail || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;

    const staticRaw = String(await zcconfig.get('s3.staticurl') || '').trim();
    if (!staticRaw) return null;
    const staticBase = staticRaw.replace(/\/+$/, '');

    if (raw.includes('/')) {
        const relativePath = ensureWebpSuffix(raw.replace(/^\/+/, ''));
        return `${staticBase}/${relativePath}`;
    }

    const md5 = raw.split('.')[0] || raw;
    logger.debug(`[embedding-worker] buildProjectCoverUrl raw=${raw} md5=${md5}`);
    return buildAssetUrl(staticBase, md5);
}

function buildScratchProjectEmbeddingText(project, metadataList) {
    const parts = [];
    const title = String(project?.title || project?.name || '').trim();
    const description = String(project?.description || '').trim();

    if (title) parts.push(`项目名称: ${title}`);
    if (description) parts.push(`项目简介: ${description}`);

    if (Array.isArray(metadataList) && metadataList.length > 0) {
        parts.push(`提取文本: ${metadataList.join(' | ')}`);
    }

    return parts.join('\n').trim();
}

async function processProjectEmbedding(job) {
    const { projectId, force = false } = job.data;
    await job.log(`开始处理项目 ${projectId} 的向量生成 (force=${force})`);

    const project = await prisma.ow_projects.findUnique({
        where: { id: Number(projectId) },
        select: {
            id: true,
            authorid: true,
            name: true,
            title: true,
            description: true,
            type: true,
            state: true,
            thumbnail: true,
            time: true,
            project_tags: {
                select: { name: true },
            },
        },
    });

    if (!project) {
        await job.log(`项目 ${projectId} 不存在，跳过`);
        return { skipped: true, reason: 'not_found' };
    }

    if (project.state !== 'public' || !await canViewContent('project', project, null)) {
        await job.log(`项目 ${projectId} 已删除，跳过`);
        return { skipped: true, reason: 'deleted' };
    }

    if (!force) {
        const existedVector = await embeddingService.getEmbedding('project', project.id);
        if (Array.isArray(existedVector) && existedVector.length > 0) {
            await job.log(`项目 ${projectId} 已有向量，按一次性策略不再重复计算`);
            return { skipped: true, reason: 'already_embedded' };
        }
    }

    const source = await fetchProjectLatestSource(project.id);
    const projectJson = parseScratchProjectJson(source);
    const metadataList = Array.from(extractScratchMetadata(projectJson)).slice(0, 1200);
    const text = buildScratchProjectEmbeddingText(project, metadataList);
    logger.debug(`[embedding-worker] project=${project.id} sourceLen=${source?.length || 0} extracted=${metadataList.length} title="${previewText(project?.title || project?.name || '')}"`);

    if (!text) {
        await job.log(`项目 ${projectId} 无可用文本，跳过`);
        return { skipped: true, reason: 'empty_text' };
    }

    const coverUrl = await buildProjectCoverUrl(project.thumbnail);
    logger.debug(`[embedding-worker] project=${project.id} textLen=${text.length} coverUrl=${coverUrl || 'none'} textPreview="${previewText(text)}"`);
    const newHash = embeddingService.hashText(`${text}\ncover:${coverUrl || ''}`);

    const config = await getModelInfo();
    const vector = await embeddingService.generateProjectEmbedding({
        text,
        coverUrl,
    });

    if (!vector) {
        throw new Error(`项目 ${projectId} 向量生成返回空`);
    }

    await embeddingService.saveEmbedding('project', project.id, vector, newHash, config.model);
    logger.debug(`[embedding-worker] project=${project.id} vectorDim=${vector.length} model=${config.model}`);
    await job.log(`项目 ${projectId} 向量已存入 PostgreSQL`);

    await gorseService.upsertProject(project);
    await job.log(`项目 ${projectId} 向量更新后已自动同步到 Gorse`);

    return {
        projectId: project.id,
        dimensions: vector.length,
        hash: newHash,
        extractedTextCount: metadataList.length,
        usedCover: Boolean(coverUrl),
    };
}

async function processProjectGorseSync(job) {
    const { projectId, reason = 'manual' } = job.data;
    const nProjectId = Number(projectId);
    await job.log(`开始处理项目 ${nProjectId} 的 Gorse 同步 (reason=${reason})`);

    if (!Number.isInteger(nProjectId) || nProjectId <= 0) {
        return { skipped: true, reason: 'invalid_project_id' };
    }

    const project = await prisma.ow_projects.findUnique({
        where: { id: nProjectId },
        select: {
            id: true,
            authorid: true,
            type: true,
            state: true,
            title: true,
            name: true,
            description: true,
            time: true,
            project_tags: {
                select: { name: true },
            },
        },
    });

    if (!project) {
        await job.log(`项目 ${nProjectId} 不存在，跳过 Gorse 同步`);
        return { skipped: true, reason: 'not_found' };
    }

    if (project.state !== 'public' || !await canViewContent('project', project, null)) {
        await gorseService.hideProject(nProjectId);
        await job.log(`项目 ${nProjectId} 已删除，已在 Gorse 隐藏`);
        return { projectId: nProjectId, hidden: true };
    }

    await gorseService.upsertProject(project);
    await job.log(`项目 ${nProjectId} 已同步到 Gorse`);

    return { projectId: nProjectId, synced: true, reason };
}

// ======================== 用户向量生成 ========================

const USER_INTEREST_ALGO = 'interest_decay_v2_events';

function normName(value) {
    return String(value || '').trim().toLowerCase();
}

function calcHotScore(post) {
    const likeCount = Number(post?.like_count) || 0;
    const bookmarkCount = Number(post?.bookmark_count) || 0;
    const retweetCount = Number(post?.retweet_count) || 0;
    const replyCount = Number(post?.reply_count) || 0;
    const engagement = likeCount + (bookmarkCount * 1.6) + (retweetCount * 1.2) + (replyCount * 0.8);
    return Math.log1p(Math.max(0, engagement));
}

function calcProjectHotScore(project) {
    const likeCount = Number(project?.like_count) || 0;
    const starCount = Number(project?.star_count) || 0;
    const favoCount = Number(project?.favo_count) || 0;
    const viewCount = Number(project?.view_count) || 0;
    const engagement = (likeCount * 1.1) + (starCount * 1.4) + (favoCount * 1.2) + (Math.log1p(Math.max(0, viewCount)) * 0.35);
    return Math.log1p(Math.max(0, engagement));
}

function calcDecayFactor(timestamp, halfLifeDays = 30) {
    if (!timestamp) return 1;
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts) || ts <= 0) return 1;
    const ageMs = Math.max(0, Date.now() - ts);
    const halfLifeMs = Math.max(1, halfLifeDays) * 24 * 60 * 60 * 1000;
    return Math.pow(0.5, ageMs / halfLifeMs);
}

async function fetchLatestProjectSource(projectId) {
    return fetchProjectLatestSource(projectId);
}

async function fetchUserReadmeLikeSource(user, authoredProjects) {
    const usernameKey = normName(user?.username);
    const displayNameKey = normName(user?.display_name);

    const sameNameProject = authoredProjects.find((project) => {
        const nameKey = normName(project?.name);
        const titleKey = normName(project?.title);
        return (usernameKey && (nameKey === usernameKey || titleKey === usernameKey))
            || (displayNameKey && (nameKey === displayNameKey || titleKey === displayNameKey));
    });

    const fallbackReadmeProject = authoredProjects.find((project) => {
        const text = `${project?.name || ''} ${project?.title || ''}`.toLowerCase();
        return text.includes('readme');
    });

    const candidate = sameNameProject || fallbackReadmeProject;
    if (!candidate?.id) return '';

    return fetchLatestProjectSource(candidate.id);
}

function mergeWeightedVectors(baseVector, interactionVector, baseWeight, interactionWeight) {
    if (!baseVector && !interactionVector) return null;
    if (!baseVector) return interactionVector;
    if (!interactionVector) return baseVector;
    if (baseVector.length !== interactionVector.length) return interactionVector;

    const dim = interactionVector.length;
    const merged = new Array(dim).fill(0);
    const safeBase = Number(baseWeight) || 0;
    const safeInteraction = Number(interactionWeight) || 0;
    const total = safeBase + safeInteraction;

    if (total <= 0) return interactionVector;

    for (let i = 0; i < dim; i++) {
        merged[i] = ((baseVector[i] * safeBase) + (interactionVector[i] * safeInteraction)) / total;
    }

    return embeddingService.normalizeVector(merged);
}

function collapseInteractionEntries(entries, maxPerSourceWeight = 2.6) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const map = new Map();

    for (const entry of entries) {
        if (!entry?.vector || !entry?.sourceKey) continue;

        const existed = map.get(entry.sourceKey);
        if (!existed) {
            map.set(entry.sourceKey, {
                vector: entry.vector,
                weight: Math.min(maxPerSourceWeight, Math.max(0, Number(entry.weight) || 0)),
                timestamp: entry.timestamp,
            });
            continue;
        }

        existed.weight = Math.min(
            maxPerSourceWeight,
            existed.weight + Math.max(0, (Number(entry.weight) || 0) * 0.55)
        );

        const existedTs = new Date(existed.timestamp).getTime();
        const currentTs = new Date(entry.timestamp).getTime();
        if (Number.isFinite(currentTs) && (!Number.isFinite(existedTs) || currentTs > existedTs)) {
            existed.timestamp = entry.timestamp;
        }
    }

    return Array.from(map.values());
}

async function processUserEmbedding(job) {
    const { userId, force = false, triggerType = 'scheduled' } = job.data;
    await job.log(`开始处理用户 ${userId} 的向量生成 (force=${force})`);

    // 查询用户
    const user = await prisma.ow_users.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            display_name: true,
            bio: true,
        },
    });

    if (!user || !await canViewContent('profile', user, null)) {
        await job.log(`用户 ${userId} 不存在，跳过`);
        return { skipped: true, reason: 'not_found' };
    }

    // 用户基础语料：同名 readme 项目 + 昵称简介 + 作品名称简介
    const authoredProjects = await prisma.ow_projects.findMany({
        where: { authorid: userId, state: 'public', AND: [await visibleWhere('project')] },
        select: {
            id: true,
            name: true,
            title: true,
            description: true,
            time: true,
            like_count: true,
            star_count: true,
            favo_count: true,
            view_count: true,
        },
        orderBy: { time: 'desc' },
        take: 120,
    });

    const readmeProjectSource = await fetchUserReadmeLikeSource(user, authoredProjects);
    const seedText = embeddingService.buildUserSeedText({
        user,
        readmeProjectSource,
        projects: authoredProjects,
    });
    const profileTextHash = embeddingService.hashText(seedText);
    logger.debug(`[embedding-worker] user=${userId} seedLen=${seedText.length} seedHash=${profileTextHash} readmeSourceLen=${readmeProjectSource?.length || 0}`);

    // 收集用户交互的帖子向量（行为权重 + 热度增强 + 时间衰减）
    const entries = [];
    const interactionSignature = [];
    const eventBreakdown = {};
    let hotScore = 0;
    let decayScore = 0;
    let interactionWithVector = 0;
    let postInteractionCount = 0;
    let projectInteractionCount = 0;

    const markEventTotal = (action) => {
        if (!eventBreakdown[action]) eventBreakdown[action] = { total: 0, withVector: 0 };
        eventBreakdown[action].total += 1;
    };

    const markEventWithVector = (action) => {
        if (!eventBreakdown[action]) eventBreakdown[action] = { total: 0, withVector: 0 };
        eventBreakdown[action].withVector += 1;
    };

    const pushEntry = ({ action, sourceType, sourceId, vector, actionAt, hot = 0, baseTimestamp = null, signatureExtra = '' }) => {
        if (!vector) return;

        const actionWeightMap = {
            post: 1.0,
            like: 0.65,
            bookmark: 0.85,
            repost: 0.75,
            project_author: 0.95,
            project_star: 0.8,
        };

        const actionWeight = actionWeightMap[action] || 0.5;
        const freshness = calcDecayFactor(baseTimestamp || actionAt, sourceType === 'project' ? 30 : 14);
        const hotBoost = Math.min(2.2, Math.max(0, hot * 0.35 * freshness));
        const boostedWeight = actionWeight * (1 + hotBoost);

        entries.push({
            vector,
            weight: boostedWeight,
            timestamp: actionAt,
            sourceKey: `${sourceType}:${sourceId}`,
        });

        const interactionDecay = calcDecayFactor(actionAt, 30);
        hotScore += hot;
        decayScore += interactionDecay;
        interactionWithVector += 1;

        if (sourceType === 'project') {
            projectInteractionCount += 1;
        } else {
            postInteractionCount += 1;
        }

        const ts = new Date(actionAt).getTime();
        interactionSignature.push(`${action}:${sourceType}:${sourceId}:${Number.isFinite(ts) ? ts : 0}:${signatureExtra}`);
    };

    const publicPostWhere = await visibleWhere('post');
    const publicProjectWhere = await visibleWhere('project');

    // 1. 用户自己发的帖子（高权重）
    const userPosts = await prisma.ow_posts.findMany({
        where: {
            author_id: userId,
            AND: [publicPostWhere],
            is_deleted: false,
            post_type: { not: 'retweet' }, // 排除纯转推
        },
        select: {
            id: true,
            created_at: true,
            like_count: true,
            bookmark_count: true,
            retweet_count: true,
            reply_count: true,
        },
        orderBy: { created_at: 'desc' },
        take: 240,
    });

    if (userPosts.length > 0) {
        const postIds = userPosts.map(p => p.id);
        const postVectors = await embeddingService.getEmbeddings('post', postIds);
        for (const post of userPosts) {
            const vec = postVectors.get(post.id);
            markEventTotal('post');
            if (vec) {
                markEventWithVector('post');
                const hot = calcHotScore(post);
                pushEntry({
                    action: 'post',
                    sourceType: 'post',
                    sourceId: post.id,
                    vector: vec,
                    actionAt: post.created_at,
                    hot,
                    baseTimestamp: post.created_at,
                    signatureExtra: `${Number(post?.like_count) || 0}:${Number(post?.bookmark_count) || 0}:${Number(post?.retweet_count) || 0}:${Number(post?.reply_count) || 0}`,
                });
            }
        }
        await job.log(`用户帖子向量: ${interactionWithVector}/${userPosts.length} 有向量`);
    }

    // 2. 用户点赞的帖子（中权重）
    const likedPosts = await prisma.ow_posts_like.findMany({
        where: { user_id: userId, post: { is: publicPostWhere } },
        select: {
            post_id: true,
            created_at: true,
            post: {
                select: {
                    created_at: true,
                    like_count: true,
                    bookmark_count: true,
                    retweet_count: true,
                    reply_count: true,
                },
            },
        },
        orderBy: { created_at: 'desc' },
        take: 160,
    });

    if (likedPosts.length > 0) {
        const likePostIds = likedPosts.map(l => l.post_id);
        const likeVectors = await embeddingService.getEmbeddings('post', likePostIds);
        let likeCount = 0;
        for (const like of likedPosts) {
            const vec = likeVectors.get(like.post_id);
            markEventTotal('like');
            if (vec) {
                markEventWithVector('like');
                const hot = calcHotScore(like.post);
                pushEntry({
                    action: 'like',
                    sourceType: 'post',
                    sourceId: like.post_id,
                    vector: vec,
                    actionAt: like.created_at,
                    hot,
                    baseTimestamp: like.post?.created_at,
                    signatureExtra: `${Number(like.post?.like_count) || 0}:${Number(like.post?.bookmark_count) || 0}:${Number(like.post?.retweet_count) || 0}:${Number(like.post?.reply_count) || 0}`,
                });
                likeCount++;
            }
        }
        await job.log(`用户点赞帖子向量: ${likeCount}/${likedPosts.length} 有向量`);
    }

    // 3. 用户收藏的帖子（较高权重）
    const bookmarkedPosts = await prisma.ow_posts_bookmark.findMany({
        where: { user_id: userId, post: { is: publicPostWhere } },
        select: {
            post_id: true,
            created_at: true,
            post: {
                select: {
                    created_at: true,
                    like_count: true,
                    bookmark_count: true,
                    retweet_count: true,
                    reply_count: true,
                },
            },
        },
        orderBy: { created_at: 'desc' },
        take: 160,
    });

    if (bookmarkedPosts.length > 0) {
        const bmPostIds = bookmarkedPosts.map(b => b.post_id);
        const bmVectors = await embeddingService.getEmbeddings('post', bmPostIds);
        let bmCount = 0;
        for (const bm of bookmarkedPosts) {
            const vec = bmVectors.get(bm.post_id);
            markEventTotal('bookmark');
            if (vec) {
                markEventWithVector('bookmark');
                const hot = calcHotScore(bm.post);
                pushEntry({
                    action: 'bookmark',
                    sourceType: 'post',
                    sourceId: bm.post_id,
                    vector: vec,
                    actionAt: bm.created_at,
                    hot,
                    baseTimestamp: bm.post?.created_at,
                    signatureExtra: `${Number(bm.post?.like_count) || 0}:${Number(bm.post?.bookmark_count) || 0}:${Number(bm.post?.retweet_count) || 0}:${Number(bm.post?.reply_count) || 0}`,
                });
                bmCount++;
            }
        }
        await job.log(`用户收藏帖子向量: ${bmCount}/${bookmarkedPosts.length} 有向量`);
    }

    // 4. 用户转贴的原帖（作为兴趣表达）
    const repostPosts = await prisma.ow_posts.findMany({
        where: {
            author_id: userId,
            AND: [publicPostWhere],
            is_deleted: false,
            post_type: 'retweet',
            retweet_post_id: { not: null },
        },
        select: {
            id: true,
            retweet_post_id: true,
            created_at: true,
            retweet_post: {
                select: {
                    created_at: true,
                    like_count: true,
                    bookmark_count: true,
                    retweet_count: true,
                    reply_count: true,
                },
            },
        },
        orderBy: { created_at: 'desc' },
        take: 160,
    });

    if (repostPosts.length > 0) {
        const repostTargetIds = repostPosts.map(r => Number(r.retweet_post_id)).filter(id => Number.isInteger(id));
        const repostVectors = await embeddingService.getEmbeddings('post', repostTargetIds);
        let repostWithVector = 0;

        for (const repost of repostPosts) {
            const targetId = Number(repost.retweet_post_id);
            markEventTotal('repost');
            if (!Number.isInteger(targetId)) continue;

            const vec = repostVectors.get(targetId);
            if (vec) {
                markEventWithVector('repost');
                const hot = calcHotScore(repost.retweet_post);
                pushEntry({
                    action: 'repost',
                    sourceType: 'post',
                    sourceId: targetId,
                    vector: vec,
                    actionAt: repost.created_at,
                    hot,
                    baseTimestamp: repost.retweet_post?.created_at,
                    signatureExtra: `${Number(repost.retweet_post?.like_count) || 0}:${Number(repost.retweet_post?.bookmark_count) || 0}:${Number(repost.retweet_post?.retweet_count) || 0}:${Number(repost.retweet_post?.reply_count) || 0}`,
                });
                repostWithVector++;
            }
        }

        await job.log(`用户转贴目标帖子向量: ${repostWithVector}/${repostPosts.length} 有向量`);
    }

    // 5. 用户自己的作品（project embedding）
    if (authoredProjects.length > 0) {
        const authoredProjectIds = authoredProjects.map(p => p.id);
        const authoredProjectVectors = await embeddingService.getEmbeddings('project', authoredProjectIds);
        let authoredWithVector = 0;

        for (const project of authoredProjects) {
            const vec = authoredProjectVectors.get(project.id);
            markEventTotal('project_author');
            if (vec) {
                markEventWithVector('project_author');
                const hot = calcProjectHotScore(project);
                pushEntry({
                    action: 'project_author',
                    sourceType: 'project',
                    sourceId: project.id,
                    vector: vec,
                    actionAt: project.time,
                    hot,
                    baseTimestamp: project.time,
                    signatureExtra: `${Number(project?.like_count) || 0}:${Number(project?.star_count) || 0}:${Number(project?.favo_count) || 0}:${Number(project?.view_count) || 0}`,
                });
                authoredWithVector++;
            }
        }

        await job.log(`用户作品向量: ${authoredWithVector}/${authoredProjects.length} 有向量`);
    }

    // 6. 用户收藏(Star)的作品（project embedding）
    const starredProjects = await prisma.ow_projects_stars.findMany({
        where: { userid: userId, project: { is: publicProjectWhere } },
        select: {
            projectid: true,
            createTime: true,
            project: {
                select: {
                    time: true,
                    like_count: true,
                    star_count: true,
                    favo_count: true,
                    view_count: true,
                },
            },
        },
        orderBy: { createTime: 'desc' },
        take: 180,
    });

    if (starredProjects.length > 0) {
        const starredProjectIds = starredProjects.map(s => Number(s.projectid)).filter(id => Number.isInteger(id));
        const starredProjectVectors = await embeddingService.getEmbeddings('project', starredProjectIds);
        let starredWithVector = 0;

        for (const star of starredProjects) {
            const projectId = Number(star.projectid);
            markEventTotal('project_star');
            if (!Number.isInteger(projectId)) continue;

            const vec = starredProjectVectors.get(projectId);
            if (vec) {
                markEventWithVector('project_star');
                const hot = calcProjectHotScore(star.project);
                pushEntry({
                    action: 'project_star',
                    sourceType: 'project',
                    sourceId: projectId,
                    vector: vec,
                    actionAt: star.createTime,
                    hot,
                    baseTimestamp: star.project?.time,
                    signatureExtra: `${Number(star.project?.like_count) || 0}:${Number(star.project?.star_count) || 0}:${Number(star.project?.favo_count) || 0}:${Number(star.project?.view_count) || 0}`,
                });
                starredWithVector++;
            }
        }

        await job.log(`用户收藏作品向量: ${starredWithVector}/${starredProjects.length} 有向量`);
    }

    const mergedEntries = collapseInteractionEntries(entries);
    const interactionHash = embeddingService.hashText(interactionSignature.join('|'));
    const textHash = embeddingService.hashText(`seed:${profileTextHash}|interest:${interactionHash}|algo:${USER_INTEREST_ALGO}`);
    logger.debug(`[embedding-worker] user=${userId} rawEntries=${entries.length} mergedEntries=${mergedEntries.length} interactionWithVector=${interactionWithVector} interactionHash=${interactionHash} textHash=${textHash}`);

    if (!force) {
        const oldHash = await embeddingService.getTextHash('user', userId);
        if (oldHash === textHash) {
            await job.log(`用户 ${userId} 语料与互动摘要未变化，跳过`);
            return { skipped: true, reason: 'unchanged' };
        }
    }

    let baseVector = null;
    if (seedText && seedText.length > 1) {
        baseVector = await embeddingService.generateEmbedding(seedText);
        logger.debug(`[embedding-worker] user=${userId} baseVectorDim=${baseVector?.length || 0}`);
        await job.log(`用户 ${userId} 已按资料+README+作品生成基础向量`);
    }

    let interactionVector = null;
    if (mergedEntries.length > 0) {
        interactionVector = embeddingService.timeWeightedMerge(mergedEntries);
        logger.debug(`[embedding-worker] user=${userId} interactionVectorDim=${interactionVector?.length || 0}`);
        await job.log(`用户 ${userId} 通过 ${mergedEntries.length} 个兴趣点生成兴趣向量 (原始事件${entries.length}条)`);
    }

    if (!baseVector && !interactionVector) {
        await job.log(`用户 ${userId} 缺少可用语料和互动向量，跳过`);
        return { skipped: true, reason: 'no_data' };
    }

    const sourceKinds = new Set();
    if (postInteractionCount > 0) sourceKinds.add('post');
    if (projectInteractionCount > 0) sourceKinds.add('project');

    let interactionBlend = mergedEntries.length > 0
        ? Math.min(0.82, 0.32 + (Math.log1p(mergedEntries.length) / 8) + (sourceKinds.size > 1 ? 0.06 : 0))
        : 0;

    if (baseVector && mergedEntries.length < 4) {
        interactionBlend = Math.min(interactionBlend, 0.55);
    }

    const baseBlend = baseVector ? Math.max(0, 1 - interactionBlend) : 0;

    const finalVector = mergeWeightedVectors(baseVector, interactionVector, baseBlend, interactionBlend);
    if (!finalVector) {
        return { skipped: true, reason: 'no_vector' };
    }
    logger.debug(`[embedding-worker] user=${userId} blend base=${baseBlend.toFixed(4)} interaction=${interactionBlend.toFixed(4)} finalDim=${finalVector.length}`);

    // 存入 pgvector
    const config = await getModelInfo();
    await embeddingService.saveEmbedding('user', userId, finalVector, textHash, config.model);
    await job.log(`用户 ${userId} 向量已存入 PostgreSQL`);

    await embeddingService.saveUserEmbeddingUpdate({
        userId,
        triggerType,
        algorithm: USER_INTEREST_ALGO,
        profileTextHash,
        interactionHash,
        interactionCount: interactionWithVector,
        baseWeight: baseBlend,
        interactionWeight: interactionBlend,
        hotScore,
        decayScore,
        metadata: {
            userPostCount: userPosts.length,
            likedCount: likedPosts.length,
            bookmarkedCount: bookmarkedPosts.length,
            repostedCount: repostPosts.length,
            authoredProjectCount: authoredProjects.length,
            starredProjectCount: starredProjects.length,
            rawInteractionEntryCount: entries.length,
            mergedInteractionEntryCount: mergedEntries.length,
            eventBreakdown,
            seedTextLength: seedText.length,
            hasReadmeSource: Boolean(readmeProjectSource),
        },
    });
    await job.log(`用户 ${userId} embedding 更新记录已写入`);

    // 更新用户的 embedding_at 时间戳
    await prisma.ow_users.update({
        where: { id: userId },
        data: { embedding_at: new Date() },
    });

    // 同步到 Gorse
    await syncUserToGorse(userId, user, finalVector);
    await job.log(`用户 ${userId} 向量已同步到 Gorse`);

    return {
        userId,
        dimensions: finalVector.length,
        interactionCount: interactionWithVector,
        seedTextLength: seedText.length,
        hasReadmeSource: Boolean(readmeProjectSource),
    };
}

// ======================== Gorse 同步 ========================

async function syncPostToGorse(post, vector) {
    try {
        if (!gorseService.isEnabled()) return;

        // 纯转推不推送给 Gorse
        if (post.post_type === 'retweet') return;
        if (!await canViewContent('post', post, null)) {
            await gorseService.hidePost(post.id);
            return;
        }

        const client = await getGorseClient();
        if (!client) return;

        const categories = buildPostCategoriesInternal(post);
        const labels = buildPostLabelsInternal(post);
        labels.embedding = vector;

        await client.upsertItem({
            ItemId: `post_${post.id}`,
            Comment: (post.content || '').substring(0, 200),
            IsHidden: post.is_deleted || false,
            Timestamp: post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString(),
            Categories: categories,
            Labels: labels,
        });
    } catch (error) {
        logger.warn(`[embedding-worker] 同步帖子 ${post.id} 向量到 Gorse 失败:`, error.message);
    }
}

async function syncUserToGorse(userId, user, vector) {
    try {
        if (!gorseService.isEnabled()) return;
        if (!await canViewContent('profile', user, null)) return;

        const client = await getGorseClient();
        if (!client) return;

        // insertUser 携带 embedding 向量
        await client.insertUser({
            UserId: String(userId),
            Comment: (user.username || user.display_name || '').substring(0, 200),
            Labels: { embedding: vector },
        });

        // upsertItem（ItemId: user_X）供 follow feedback 挂载
        await client.upsertItem({
            ItemId: `user_${userId}`,
            Comment: (user.username || user.display_name || '').substring(0, 200),
            IsHidden: false,
            Categories: ['user'],
            Labels: { embedding: vector },
        });
    } catch (error) {
        logger.warn(`[embedding-worker] 同步用户 ${userId} 向量到 Gorse 失败:`, error.message);
    }
}

// ======================== Gorse 辅助（避免循环依赖） ========================

let _gorseClient = null;

async function getGorseClient() {
    if (_gorseClient) return _gorseClient;
    try {
        const { Gorse } = await import('gorsejs');
        const endpoint = await zcconfig.get('gorse.endpoint');
        const secret = await zcconfig.get('gorse.secret');
        if (!endpoint) return null;
        _gorseClient = new Gorse({ endpoint, secret: secret || '' });
        return _gorseClient;
    } catch (e) {
        return null;
    }
}

function buildPostCategoriesInternal(post) {
    const categories = ['post'];
    if (post.post_type) categories.push(`type:${post.post_type}`);
    if (post.embed && typeof post.embed === 'object' && post.embed.type) {
        categories.push(`embed:${post.embed.type}`);
    }
    return categories;
}

function buildPostLabelsInternal(post) {
    const labels = {};
    if (post.author_id) labels.author = String(post.author_id);
    if (post.post_type) labels.type = post.post_type;
    if (post.embed && typeof post.embed === 'object') {
        if (post.embed.type) labels.embed_type = post.embed.type;
        if (post.embed.type === 'project' && post.embed.id) {
            labels.project = String(post.embed.id);
        }
    }
    return labels;
}

async function getModelInfo() {
    const model = await zcconfig.get('embedding.model');
    return { model: model || 'unknown' };
}

// ======================== Worker 创建 ========================

async function createEmbeddingWorker() {
    const concurrency = (await zcconfig.get('embedding.concurrency')) || 2;
    const connection = await createConnection('worker-embedding');

    worker = new Worker(
        QUEUE_NAMES.EMBEDDING,
        async (job) => {
            const { type } = job.data;

            switch (type) {
                case 'post_embedding':
                    return processPostEmbedding(job);
                case 'user_embedding':
                    return processUserEmbedding(job);
                case 'project_embedding':
                    return processProjectEmbedding(job);
                case 'project_gorse_sync':
                    return processProjectGorseSync(job);
                case 'batch_post_embedding':
                    return processBatchPostEmbedding(job);
                case 'batch_user_embedding':
                    return processBatchUserEmbedding(job);
                case 'batch_project_embedding':
                    return processBatchProjectEmbedding(job);
                default:
                    throw new Error(`未知的 embedding 任务类型: ${type}`);
            }
        },
        {
            connection,
            concurrency,
            limiter: {
                max: 10,
                duration: 60000, // 每分钟最多 10 个请求（避免 API 限流）
            },
        },
    );

    worker.on('completed', (job, result) => {
        if (result?.skipped) {
            logger.debug(`[embedding-worker] Job ${job.id} 跳过: ${result.reason}`);
        } else {
            logger.debug(`[embedding-worker] Job ${job.id} 完成`);
        }
    });

    worker.on('failed', (job, err) => {
        logger.error(`[embedding-worker] Job ${job?.id} 失败:`, err.message);
    });

    worker.on('error', (err) => {
        logger.error('[embedding-worker] Worker error:', err.message);
    });

    logger.info(`[embedding-worker] Worker 已创建 (concurrency=${concurrency})`);
    return worker;
}

function getEmbeddingWorker() {
    return worker;
}

// ======================== 批量处理 ========================

async function processBatchPostEmbedding(job) {
    const { postIds, force = false } = job.data;
    await job.log(`批量处理 ${postIds.length} 个帖子的向量`);

    const config = await getModelInfo();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 批量查询帖子
    const posts = await prisma.ow_posts.findMany({
        where: { id: { in: postIds }, AND: [await visibleWhere('post')] },
        select: {
            id: true,
            author_id: true,
            post_type: true,
            content: true,
            embed: true,
            is_deleted: true,
            retweet_post_id: true,
            created_at: true,
        },
    });

    // 过滤掉转推和删除的
    const validPosts = posts.filter(p => p.post_type !== 'retweet' && !p.is_deleted);

    // 构建文本并校验变化
    const textsToEmbed = [];
    const postsToProcess = [];

    const existingVectors = force
        ? new Map()
        : await embeddingService.getEmbeddings('post', validPosts.map(p => p.id));

    const existingHashes = force
        ? new Map()
        : await embeddingService.getTextHashes('post', validPosts.map(p => p.id));

    for (const post of validPosts) {
        if (!force && existingVectors.has(post.id)) {
            skipped++;
            continue;
        }

        const text = embeddingService.buildPostText(post);
        if (!text || text.trim().length === 0) {
            skipped++;
            continue;
        }
        const hash = embeddingService.hashText(text);
        if (!force && existingHashes.get(post.id) === hash) {
            skipped++;
            continue;
        }
        textsToEmbed.push(text);
        postsToProcess.push({ post, hash });
    }

    skipped += (posts.length - validPosts.length);

    // 批量生成向量
    const batchSize = (await zcconfig.get('embedding.batch_size')) || 20;
    for (let i = 0; i < textsToEmbed.length; i += batchSize) {
        const batchTexts = textsToEmbed.slice(i, i + batchSize);
        const batchPosts = postsToProcess.slice(i, i + batchSize);

        try {
            const vectors = await embeddingService.generateEmbeddings(batchTexts);

            for (let j = 0; j < vectors.length; j++) {
                const { post, hash } = batchPosts[j];
                const vector = vectors[j];

                try {
                    await embeddingService.saveEmbedding('post', post.id, vector, hash, config.model);
                    await prisma.ow_posts.update({
                        where: { id: post.id },
                        data: { embedding_at: new Date() },
                    });
                    await syncPostToGorse(post, vector);
                    processed++;
                } catch (e) {
                    logger.warn(`[embedding-worker] 帖子 ${post.id} 存储失败:`+ e);
                    failed++;
                }
            }
        } catch (e) {
            logger.error(`[embedding-worker] 批量向量生成失败:`+ e);
            failed += batchTexts.length;
        }

        await job.updateProgress(Math.round(((i + batchTexts.length) / textsToEmbed.length) * 100));
    }

    return { processed, skipped, failed, total: postIds.length };
}

async function processBatchUserEmbedding(job) {
    const { userIds, force = false } = job.data;
    await job.log(`批量处理 ${userIds.length} 个用户的向量`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < userIds.length; i++) {
        try {
            const result = await processUserEmbedding({
                data: { userId: userIds[i], force },
                log: async (msg) => job.log(`[user_${userIds[i]}] ${msg}`),
                updateProgress: async () => {},
            });

            if (result?.skipped) {
                skipped++;
            } else {
                processed++;
            }
        } catch (e) {
            logger.warn(`[embedding-worker] 用户 ${userIds[i]} 向量生成失败:`+ e);
            failed++;
        }

        await job.updateProgress(Math.round(((i + 1) / userIds.length) * 100));
    }

    return { processed, skipped, failed, total: userIds.length };
}

async function processBatchProjectEmbedding(job) {
    const { projectIds, force = false } = job.data;
    await job.log(`批量处理 ${projectIds.length} 个项目的向量`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < projectIds.length; i++) {
        try {
            const result = await processProjectEmbedding({
                data: { projectId: projectIds[i], force },
                log: async (msg) => job.log(`[project_${projectIds[i]}] ${msg}`),
                updateProgress: async () => { },
            });

            if (result?.skipped) skipped++;
            else processed++;
        } catch (e) {
            logger.warn(`[embedding-worker] 项目 ${projectIds[i]} 向量生成失败:${e}`);
            failed++;
        }

        await job.updateProgress(Math.round(((i + 1) / projectIds.length) * 100));
    }

    return { processed, skipped, failed, total: projectIds.length };
}

export { createEmbeddingWorker, getEmbeddingWorker };
