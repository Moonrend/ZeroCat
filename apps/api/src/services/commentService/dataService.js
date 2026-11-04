import { prisma } from '../prisma.js';
import redisClient from '../redis.js';
import logger from '../logger.js';
import zcconfig from '../config/zcconfig.js';
import { assertCanWrite, visibleWhere } from '../moderation/visibility.js';
import { getCommentProfileVisibility } from './profileVisibility.js';
import { sanitizeComment } from './sanitizer.js';

const TASK_TTL = 86400; // 24h
const DATA_TTL = 3600;  // 1h (导出数据)

const WALINE_VERSION = '1.39.0';

// ============================================================
// 任务追踪 (Redis)
// ============================================================

/**
 * 创建任务记录
 */
export async function createTask(taskId, spaceId, userId, type, meta = {}) {
    const task = {
        id: taskId,
        space_id: spaceId,
        user_id: userId,
        type, // 'export' | 'import'
        status: 'pending',
        progress: 0,
        total: 0,
        processed: 0,
        created_at: new Date().toISOString(),
        completed_at: null,
        error: null,
        ...meta,
    };

    await redisClient.set(`cs:datatask:${taskId}`, task, TASK_TTL);

    // 追加到空间任务列表
    const listKey = `cs:datatask:space:${spaceId}`;
    let list = await redisClient.get(listKey);
    if (!Array.isArray(list)) list = [];
    list.unshift(taskId);
    if (list.length > 50) list.length = 50;
    await redisClient.set(listKey, list, TASK_TTL);

    return task;
}

/**
 * 更新任务状态
 */
export async function updateTask(taskId, updates) {
    const task = await redisClient.get(`cs:datatask:${taskId}`);
    if (!task) return null;

    Object.assign(task, updates);
    await redisClient.set(`cs:datatask:${taskId}`, task, TASK_TTL);
    return task;
}

/**
 * 获取任务
 */
export async function getTask(taskId) {
    return await redisClient.get(`cs:datatask:${taskId}`);
}

/**
 * 列出空间的数据任务
 */
export async function listTasks(spaceId) {
    const listKey = `cs:datatask:space:${spaceId}`;
    let taskIds = await redisClient.get(listKey);
    if (!Array.isArray(taskIds)) return [];

    const tasks = [];
    for (const id of taskIds) {
        const task = await getTask(id);
        if (task) tasks.push(task);
    }
    return tasks;
}

// ============================================================
// 导出 (Waline JSON 格式)
// ============================================================

async function getTaskActor(taskId, spaceId, type) {
    const task = await getTask(taskId);
    if (!task?.user_id || task.space_id !== spaceId || task.type !== type) {
        throw Object.assign(new Error('数据任务不存在或无权限'), { statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
    }
    const space = await prisma.ow_comment_spaces.findUnique({
        where: { id: Number(spaceId) },
        select: { owner_id: true },
    });
    if (!space || space.owner_id !== Number(task.user_id)) {
        throw Object.assign(new Error('空间不存在或无权限'), { statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
    }
    return Number(task.user_id);
}

/**
 * 导出空间数据为 Waline JSON 格式
 */
export async function exportSpaceData(spaceId, spaceCuid, spaceName, taskId, progressCb, { download = false } = {}) {
    const userId = await getTaskActor(taskId, spaceId, 'export');
    const [comments, counters, spaceUsers] = await Promise.all([
        prisma.ow_comment_service.findMany({
            where: { space_id: spaceId, AND: [await visibleWhere('comment_service', userId)] },
            orderBy: { id: 'asc' },
        }),
        prisma.ow_comment_service_counter.findMany({
            where: { space_id: spaceId },
            orderBy: { id: 'asc' },
        }),
        prisma.ow_comment_service_users.findMany({
            where: { space_id: spaceId, user: { is: await visibleWhere('profile', userId) } },
            orderBy: { user_id: 'asc' },
            include: {
                user: {
                    select: {
                        id: true, username: true, display_name: true,
                        email: true, avatar: true, url: true,
                    },
                },
            },
        }),
    ]);

    const { hiddenUserIds: hiddenProfiles } = await getCommentProfileVisibility(
        comments.map(comment => comment.account_user_id), userId,
    );

    const total = comments.length + counters.length + spaceUsers.length;
    let processed = 0;
    if (progressCb) await progressCb(0, total);

    // 获取静态资源和前端地址
    const [staticUrl, frontendUrl] = await Promise.all([
        zcconfig.get('s3.staticurl'),
        zcconfig.get('urls.frontend'),
    ]);

    // 构建 DB id → 顺序 objectId 映射
    const idMap = {};
    comments.forEach((c, i) => { idMap[c.id] = i + 1; });

    // ── Comment ──
    const commentData = comments.map((c, i) => {
        if (progressCb && i > 0 && i % 100 === 0) progressCb(processed + i, total);

        const pid = c.pid ? (idMap[Number(c.pid)] ?? null) : null;
        const rid = c.rid ? (idMap[Number(c.rid)] ?? null) : null;

        return {
            user_id: hiddenProfiles.has(c.account_user_id) ? null : (c.account_user_id || null),
            comment: c.comment || '',
            ip: c.ip || '',
            link: hiddenProfiles.has(c.account_user_id) ? null : (c.link || null),
            mail: hiddenProfiles.has(c.account_user_id) ? null : (c.mail || null),
            nick: hiddenProfiles.has(c.account_user_id) ? '用户' : (c.nick || null),
            pid,
            rid,
            sticky: c.sticky ? true : null,
            status: c.status || 'approved',
            like: c.like || null,
            ua: c.ua || null,
            url: c.url || '/',
            objectId: idMap[c.id],
            insertedAt: c.insertedAt?.toISOString() || null,
            createdAt: c.createdAt?.toISOString() || null,
            updatedAt: c.updatedAt?.toISOString() || null,
        };
    });
    processed += comments.length;
    if (progressCb) await progressCb(processed, total);

    // ── Counter ──
    const counterData = counters.map((c, i) => ({
        time: c.time || null,
        reaction0: c.reaction0 || null,
        reaction1: c.reaction1 || null,
        reaction2: c.reaction2 || null,
        reaction3: c.reaction3 || null,
        reaction4: c.reaction4 || null,
        reaction5: c.reaction5 || null,
        reaction6: c.reaction6 || null,
        reaction7: c.reaction7 || null,
        reaction8: c.reaction8 || null,
        url: c.url,
        objectId: i + 1,
        createdAt: c.created_at?.toISOString() || null,
        updatedAt: c.updated_at?.toISOString() || null,
    }));
    processed += counters.length;
    if (progressCb) await progressCb(processed, total);

    // ── Users ──
    const userData = spaceUsers.map((su, i) => {
        const zcUser = su.user; // 关联的 ZeroCat 用户

        const displayName = su.display_name || zcUser?.display_name || zcUser?.username || '';
        const email = su.email || zcUser?.email || '';

        // 头像: 优先空间用户头像 hash，其次 ZeroCat 用户头像 hash，拼接完整 URL
        const rawAvatar = su.avatar || zcUser?.avatar || '';
        const avatarUrl = rawAvatar
            ? `${staticUrl}/assets/${rawAvatar.substring(0, 2)}/${rawAvatar.substring(2, 4)}/${rawAvatar}.webp`
            : null;

        // URL: 优先空间用户自定义 url，其次 ZeroCat 用户 url，兜底拼接用户主页
        const userUrl = su.url || zcUser?.url || (zcUser?.username ? `${frontendUrl}/user/${zcUser.username}` : null);

        return {
            display_name: displayName,
            email,
            password: null,
            type: su.type || 'guest',
            label: su.label || null,
            url: userUrl,
            avatar: avatarUrl,
            github: null,
            twitter: null,
            facebook: null,
            google: null,
            weibo: null,
            qq: null,
            oidc: null,
            '2fa': null,
            objectId: i + 1,
            createdAt: su.created_at?.toISOString() || null,
            updatedAt: su.updated_at?.toISOString() || null,
        };
    });
    processed += spaceUsers.length;
    if (progressCb) await progressCb(total, total);

    // 构建 Waline JSON
    const walineJson = {
        __version: WALINE_VERSION,
        type: 'waline',
        version: 1,
        time: Date.now(),
        tables: ['Comment', 'Counter', 'Users'],
        data: {
            Comment: commentData,
            Counter: counterData,
            Users: userData,
        },
    };

    if (download) return JSON.stringify(walineJson);

    // 缓存仅控制下载有效期，下载时重新构建当前可见数据。
    await redisClient.set(`cs:datatask:data:${taskId}`, JSON.stringify(walineJson), DATA_TTL);

    return {
        commentCount: comments.length,
        counterCount: counters.length,
        userCount: spaceUsers.length,
    };
}

/**
 * 获取导出数据 (JSON 字符串)
 */
export async function getExportData(taskId) {
    const data = await redisClient.get(`cs:datatask:data:${taskId}`);
    if (!data) return null;
    const task = await getTask(taskId);
    if (!task || task.type !== 'export' || task.status !== 'completed') return null;
    return exportSpaceData(task.space_id, task.spaceCuid, task.spaceName, taskId, null, { download: true });
}

// ============================================================
// 导入 (Waline JSON 格式)
// ============================================================

// DB VarChar 字段长度限制
const COL_LIMITS = {
    user_id: 64,
    nick: 128,
    mail: 255,
    link: 255,
    url: 1024,
    ip: 100,
    status: 32,
    pid: 64,
    rid: 64,
};

const VALID_STATUS = new Set(['approved', 'waiting', 'spam']);

/**
 * 截断字符串到指定长度
 */
function truncate(val, max) {
    if (!val) return null;
    const str = String(val).trim();
    if (str.length === 0) return null;
    return str.length > max ? str.slice(0, max) : str;
}

/**
 * 解析日期字符串 → Date 对象
 * 支持 ISO 格式 "2026-01-01T12:00:00.000Z" 和 "2026-01-01 12:00:00"
 */
function parseDate(val) {
    if (!val) return new Date();
    if (val instanceof Date) return isNaN(val.getTime()) ? new Date() : val;
    const str = String(val).trim();
    if (!str) return new Date();
    const iso = str.includes('T') ? str : str.replace(' ', 'T') + '.000Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * 预处理 Waline JSON Comment 数组为可插入格式
 *
 * Waline JSON 字段:
 *   objectId - 顺序编号 (1,2,3...)，仅用于 pid/rid 映射
 *   pid/rid  - 引用其他 Comment 的 objectId
 *   user_id  - 外部显示字段，不用于本站账号归属
 *   日期字段  - ISO 8601 字符串
 */
function normalizeComments(input) {
    if (!Array.isArray(input)) {
        throw new Error('Comment 数据必须是数组');
    }

    return input.map((row, idx) => {
        const objectId = String(row.objectId ?? idx + 1);

        return {
            _obj_id: objectId,
            _obj_pid: row.pid != null ? String(row.pid).trim() : null,
            _obj_rid: row.rid != null ? String(row.rid).trim() : null,
            _waline_user_id: row.user_id != null ? String(row.user_id) : null,
            nick: truncate(row.nick, COL_LIMITS.nick) || 'Anonymous',
            mail: truncate(row.mail, COL_LIMITS.mail),
            link: truncate(row.link, COL_LIMITS.link),
            comment: row.comment || '',
            url: truncate(row.url, COL_LIMITS.url) || '/',
            ua: row.ua && String(row.ua).trim() !== '' ? String(row.ua).trim() : null,
            ip: truncate(row.ip, COL_LIMITS.ip),
            status: VALID_STATUS.has(row.status) ? row.status : 'approved',
            like: typeof row.like === 'number' ? row.like : 0,
            sticky: row.sticky === true,
            insertedAt: parseDate(row.insertedAt),
            createdAt: parseDate(row.createdAt),
            updatedAt: parseDate(row.updatedAt),
        };
    });
}

/**
 * 导入 Waline JSON 数据到空间
 * @param {number} spaceId
 * @param {object} data - Waline JSON 的 data 部分 { Comment, Counter?, Users? }
 * @param {string} taskId
 * @param {function} progressCb
 */
export async function importSpaceData(spaceId, data, taskId, progressCb) {
    const userId = await getTaskActor(taskId, spaceId, 'import');
    await assertCanWrite(userId, 'comments', 'manage');
    const commentInput = Array.isArray(data.Comment) ? data.Comment : [];
    const counterInput = Array.isArray(data.Counter) ? data.Counter : [];

    const comments = normalizeComments(commentInput);

    const total = comments.length + counterInput.length;
    let processed = 0;
    if (progressCb) await progressCb(0, total);

    // ── 阶段 0: 清空空间已有数据 ──
    logger.info(`[data-import] Clearing existing data for space ${spaceId}...`);
    const [deletedComments, deletedCounters] = await prisma.$transaction([
        prisma.ow_comment_service.deleteMany({ where: { space_id: spaceId } }),
        prisma.ow_comment_service_counter.deleteMany({ where: { space_id: spaceId } }),
    ]);
    logger.info(
        `[data-import] Cleared ${deletedComments.count} comments and ${deletedCounters.count} counters for space ${spaceId}`,
    );

    // ── 阶段 2: 插入评论 (objectId → DB id 重映射) ──
    const objIdToDbId = new Map();

    const rootComments = comments.filter(c => !c._obj_pid);
    const childComments = comments.filter(c => c._obj_pid);

    // 先插入根评论
    for (const c of rootComments) {
        const record = await _createComment(spaceId, c, null, null);
        objIdToDbId.set(c._obj_id, record.id);
        processed++;
        if (progressCb && processed % 50 === 0) await progressCb(processed, total);
    }

    // 多轮插入子评论 (处理嵌套)
    let remaining = [...childComments];
    let maxPasses = 20;

    while (remaining.length > 0 && maxPasses > 0) {
        const stillRemaining = [];

        for (const c of remaining) {
            const newPid = objIdToDbId.get(c._obj_pid);
            if (newPid === undefined) {
                stillRemaining.push(c);
                continue;
            }

            const newRid = c._obj_rid ? (objIdToDbId.get(c._obj_rid) ?? newPid) : newPid;

            const record = await _createComment(spaceId, c, newPid, newRid);
            objIdToDbId.set(c._obj_id, record.id);
            processed++;
            if (progressCb && processed % 50 === 0) await progressCb(processed, total);
        }

        if (stillRemaining.length === remaining.length) {
            // 无法解析父级，降级为根评论
            for (const c of stillRemaining) {
                const record = await _createComment(spaceId, c, null, null);
                objIdToDbId.set(c._obj_id, record.id);
                processed++;
            }
            break;
        }

        remaining = stillRemaining;
        maxPasses--;
    }

    // ── 阶段 3: 导入计数器 ──
    let counterCount = 0;
    for (const counter of counterInput) {
        if (!counter.url) continue;

        const url = String(counter.url).slice(0, 1024);
        await prisma.ow_comment_service_counter.upsert({
            where: {
                space_id_url: { space_id: spaceId, url },
            },
            update: {
                time: counter.time ?? 0,
                reaction0: counter.reaction0 ?? 0,
                reaction1: counter.reaction1 ?? 0,
                reaction2: counter.reaction2 ?? 0,
                reaction3: counter.reaction3 ?? 0,
                reaction4: counter.reaction4 ?? 0,
                reaction5: counter.reaction5 ?? 0,
                reaction6: counter.reaction6 ?? 0,
                reaction7: counter.reaction7 ?? 0,
                reaction8: counter.reaction8 ?? 0,
            },
            create: {
                space_id: spaceId,
                url,
                time: counter.time ?? 0,
                reaction0: counter.reaction0 ?? 0,
                reaction1: counter.reaction1 ?? 0,
                reaction2: counter.reaction2 ?? 0,
                reaction3: counter.reaction3 ?? 0,
                reaction4: counter.reaction4 ?? 0,
                reaction5: counter.reaction5 ?? 0,
                reaction6: counter.reaction6 ?? 0,
                reaction7: counter.reaction7 ?? 0,
                reaction8: counter.reaction8 ?? 0,
            },
        });
        counterCount++;
        processed++;
        if (progressCb && processed % 50 === 0) await progressCb(processed, total);
    }

    if (progressCb) await progressCb(total, total);

    return {
        commentCount: comments.length,
        counterCount,
        usersMapped: 0,
    };
}

/**
 * 内部: 创建单条评论
 * @param {number} spaceId
 * @param {object} c - normalizeComments 产出的评论对象
 * @param {number|null} pid - 已映射的新 DB pid
 * @param {number|null} rid - 已映射的新 DB rid
 */
async function _createComment(spaceId, c, pid, rid) {
    // 导入文件中的邮箱和用户 ID 未经过本站认证，不能作为账号归属凭据。
    return prisma.ow_comment_service.create({
        data: {
            space_id: spaceId,
            user_id: null,
            account_user_id: null,
            nick: c.nick,
            mail: c.mail,
            link: c.link,
            comment: sanitizeComment(c.comment),
            url: c.url,
            ua: c.ua,
            ip: c.ip,
            status: c.status,
            pid: pid != null ? truncate(String(pid), COL_LIMITS.pid) : null,
            rid: rid != null ? truncate(String(rid), COL_LIMITS.rid) : null,
            like: c.like,
            sticky: c.sticky,
            insertedAt: c.insertedAt,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
        },
    });
}

// ============================================================
// 站内信通知
// ============================================================

/**
 * 任务完成后发送站内信
 */
export async function notifyTaskComplete(userId, type, spaceName, result, error = null) {
    const isExport = type === 'export';

    const title = error
        ? `评论数据${isExport ? '导出' : '导入'}失败`
        : `评论数据${isExport ? '导出' : '导入'}完成`;

    let content;
    if (error) {
        content = `空间「${spaceName}」的数据${isExport ? '导出' : '导入'}任务失败: ${error}`;
    } else if (isExport) {
        content = `空间「${spaceName}」的数据导出已完成，共导出 ${result.commentCount} 条评论、${result.counterCount} 条计数器、${result.userCount} 位用户。请在 1 小时内下载导出文件。`;
    } else {
        content = `空间「${spaceName}」的数据导入已完成（已清空原有数据），共导入 ${result.commentCount} 条评论、${result.counterCount} 条计数器，关联 ${result.usersMapped} 位用户。`;
    }

    try {
        await prisma.ow_notifications.create({
            data: {
                user_id: userId,
                title,
                content,
                notification_type: 'comment_data_task',
                high_priority: false,
            },
        });
    } catch (err) {
        logger.error('[data-task] Failed to create notification:', err.message);
    }
}
