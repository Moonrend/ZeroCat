import { prisma } from '../prisma.js';
import redisClient from '../redis.js';
import logger from '../logger.js';
import zcconfig from '../config/zcconfig.js';
import { formatComment, formatCommentsWithChildren } from './walineFormatter.js';
import { getSpaceUser } from './spaceManager.js';
import { sanitizeComment } from './sanitizer.js';
import { checkAkismetSpam } from './akismetService.js';
import { batchGetUserLevels } from './levelService.js';
import { renderMarkdown } from './markdown.js';
import { visibleWhere, visibleSql, canViewContent, assertCanWrite } from '../moderation/visibility.js';
import { getCommentProfileVisibility } from './profileVisibility.js';
import { authorizeResourceOperation } from '../auth/resourceOperation.js';

async function authorizeCommentOperation(spaceId, commentId, action, userId, options = {}) {
    const { authorizationContext, spaceCuid } = options;
    if (!authorizationContext) return { principalId: Number(userId), delegationId: null };
    const decision = await authorizeResourceOperation(userId, 'comment', spaceCuid || commentId, action, authorizationContext);
    if (spaceCuid) {
        const space = await prisma.ow_comment_spaces.findUnique({ where: { cuid: spaceCuid } });
        if (!space || space.id !== Number(spaceId) || space.status !== 'active'
            || ((!decision.resourceGrant || decision.delegationId != null) && space.owner_id !== decision.principalId)) {
            throw Object.assign(new Error('空间不存在或无权限'), { statusCode: 404, code: 'NOT_FOUND' });
        }
    } else {
        const space = await prisma.ow_comment_spaces.findUnique({ where: { id: Number(spaceId) } });
        if (!space || space.status !== 'active') {
            throw Object.assign(new Error('空间不存在'), { statusCode: 404, code: 'NOT_FOUND' });
        }
    }
    return decision;
}

async function loadCommentUsers(spaceId, userIds, viewerId = null) {
    const spaceUsersMap = new Map();
    const zcUsersMap = new Map();
    const profileVisibility = await getCommentProfileVisibility(userIds, viewerId);
    if (userIds.length) {
        const [spaceUsers, zcUsers] = await Promise.all([
            prisma.ow_comment_service_users.findMany({
                where: { space_id: spaceId, user_id: { in: userIds } },
            }),
            prisma.ow_users.findMany({
                where: { id: { in: userIds } },
                select: { id: true, username: true, display_name: true, avatar: true, url: true, label: true },
            }),
        ]);
        for (const user of spaceUsers) spaceUsersMap.set(user.user_id, user);
        for (const user of zcUsers) {
            zcUsersMap.set(user.id, profileVisibility.hiddenUserIds.has(user.id) ? null : user);
        }
    }
    return { spaceUsersMap, zcUsersMap, profileVisibility };
}

async function getModerationCounts(spaceId, commentVisibility) {
    const groups = await prisma.ow_comment_service.groupBy({
        by: ['status'],
        where: { space_id: spaceId, status: { in: ['spam', 'waiting'] }, AND: [commentVisibility] },
        _count: { _all: true },
    });
    const counts = new Map(groups.map(group => [group.status, group._count._all]));
    return { spamCount: counts.get('spam') || 0, waitingCount: counts.get('waiting') || 0 };
}

async function buildVisibleCommentWhere(userId = null) {
    return {
        AND: [
            await visibleWhere('comment_service', userId),
            userId ? { OR: [{ status: 'approved' }, { account_user_id: Number(userId) }] } : { status: 'approved' },
        ],
    };
}

/**
 * IP 频率检查
 * @param {number} spaceId
 * @param {string} ip
 * @param {number} ipqps - 限制秒数
 * @returns {Promise<boolean>} true=允许, false=拒绝
 */
export async function checkIpRate(spaceId, ip, ipqps) {
    if (!ip || !ipqps || ipqps <= 0) return true;

    const key = `comment:ipqps:${spaceId}:${ip}`;
    const exists = await redisClient.exists(key);
    if (exists) return false;

    await redisClient.set(key, '1', ipqps);
    return true;
}

/**
 * 重复内容检测
 */
export async function checkDuplicate(spaceId, ip, comment) {
    const recent = await prisma.ow_comment_service.findFirst({
        where: {
            space_id: spaceId,
            ip,
            comment,
            insertedAt: { gte: new Date(Date.now() - 60000) },
        },
    });
    return !!recent;
}

/**
 * 敏感词检查
 * @param {string} text
 * @param {string} forbiddenWords - 逗号分隔的敏感词列表
 * @returns {boolean} true=包含敏感词
 */
export function checkForbiddenWords(text, forbiddenWords) {
    if (!forbiddenWords) return false;
    const words = forbiddenWords.split(',').map(w => w.trim()).filter(Boolean);
    const lower = text.toLowerCase();
    return words.some(word => lower.includes(word.toLowerCase()));
}

/**
 * 创建评论
 */
export async function createComment(spaceId, data, config, userInfo = null) {
    const { comment, url, pid, rid, nick, mail, link, ua, ip } = data;
    if (userInfo?.userId) await assertCanWrite(Number(userInfo.userId), 'comments', 'create');
    for (const parentId of new Set([pid, rid].filter(Boolean))) {
        const parent = await prisma.ow_comment_service.findFirst({
            where: { id: Number(parentId), space_id: spaceId, url },
        });
        if (!parent || !await canViewContent('comment_service', parent, userInfo?.userId)) {
            throw Object.assign(new Error('评论不存在'), { statusCode: 404, code: 'NOT_FOUND' });
        }
    }

    // 确定状态
    let status = 'approved';
    if (userInfo) {
        const spaceUser = await getSpaceUser(spaceId, userInfo.userId);

        // 被封禁的用户不能发评论
        if (spaceUser && spaceUser.type === 'banned') {
            throw Object.assign(new Error('您已被该空间封禁'), { statusCode: 403, errno: 1009 });
        }

        if (spaceUser && (spaceUser.type === 'administrator' || spaceUser.type === 'moderator')) {
            status = 'approved';
        } else if (config.audit === 'true') {
            status = 'waiting';
        }
    } else if (config.audit === 'true') {
        status = 'waiting';
    }

    // 敏感词检查
    if (checkForbiddenWords(comment, config.forbiddenWords)) {
        status = 'spam';
    }

    // Akismet 反垃圾检查
    if (status !== 'spam' && config.spamChecker === 'akismet') {
        try {
            const siteUrl = await zcconfig.get('urls.backend') || '';
            const isSpam = await checkAkismetSpam({
                comment, nick, mail, url, ip, ua, siteUrl,
            }, config);
            if (isSpam) {
                status = 'spam';
            }
        } catch (err) {
            logger.warn('[comment] Akismet check error:', err.message);
        }
    }

    // DOMPurify 消毒
    const sanitizedComment = sanitizeComment(comment);

    const record = await prisma.ow_comment_service.create({
        data: {
            space_id: spaceId,
            user_id: userInfo ? String(userInfo.userId) : null,
            account_user_id: userInfo?.userId ? Number(userInfo.userId) : null,
            nick: userInfo?.nick || nick || 'Anonymous',
            mail: userInfo?.mail || mail || null,
            link: userInfo?.link || link || null,
            comment: sanitizedComment,
            url,
            ua: ua || null,
            ip: ip || null,
            status,
            pid: pid ? String(pid) : null,
            rid: rid ? String(rid) : null,
        },
    });

    return record;
}

/**
 * 获取评论列表 (Waline 兼容)
 * @param {number} spaceId
 * @param {object} query - { url, page, pageSize, sortBy }
 * @param {object} options - { isAdmin, config }
 */
export async function getComments(spaceId, query, options = {}) {
    const { url: pageUrl, page = 1, pageSize = 10, sortBy } = query;
    const { isAdmin = false, config = {}, userId = null } = options;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize) || 10));

    const rootWhere = {
        space_id: spaceId,
        url: pageUrl,
        pid: null,
        rid: null,
    };
    const totalWhere = {
        space_id: spaceId,
        url: pageUrl,
    };

    // 公开评论接口始终使用当前访问者的可见性，审核通过专门管理接口访问。
    const commentVisibility = await buildVisibleCommentWhere(userId);
    Object.assign(rootWhere, commentVisibility);
    Object.assign(totalWhere, commentVisibility);

    // 排序
    let orderBy = { insertedAt: 'desc' };
    if (sortBy === 'insertedAt_asc') orderBy = { insertedAt: 'asc' };
    if (sortBy === 'like_desc') orderBy = { like: 'desc' };

    const [rootComments, rootCount, totalCount] = await Promise.all([
        prisma.ow_comment_service.findMany({
            where: rootWhere,
            orderBy,
            skip: (pageNum - 1) * size,
            take: size,
        }),
        prisma.ow_comment_service.count({ where: rootWhere }),
        prisma.ow_comment_service.count({ where: totalWhere }),
    ]);

    // 获取子评论
    const rootIds = rootComments.map(c => String(c.id));
    let childComments = [];
    if (rootIds.length > 0) {
        const childWhere = {
            space_id: spaceId,
            url: pageUrl,
            rid: { in: rootIds },
        };
        Object.assign(childWhere, await buildVisibleCommentWhere(userId));
        childComments = await prisma.ow_comment_service.findMany({
            where: childWhere,
            orderBy: { insertedAt: 'asc' },
        });
    }

    // 收集所有用户ID
    const allComments = [...rootComments, ...childComments];
    const userIds = [...new Set(
        allComments.filter(c => c.account_user_id).map(c => Number(c.account_user_id))
    )];

    // 批量加载空间用户
    const { spaceUsersMap, zcUsersMap, profileVisibility } = await loadCommentUsers(spaceId, userIds, userId);

    const formatOptions = {
        profileVisibility,
        viewerId: userId,
        isAdmin,
        disableUserAgent: config.disableUserAgent === 'true',
        disableRegion: config.disableRegion === 'true',
    };

    // 用户等级
    if (config.levels && userIds.length > 0) {
        const userLevelMap = await batchGetUserLevels(spaceId, userIds, config.levels);
        formatOptions.userLevelMap = userLevelMap;
    }

    const data = await formatCommentsWithChildren(rootComments, childComments, formatOptions, spaceUsersMap, zcUsersMap);

    return {
        page: pageNum,
        totalPages: Math.ceil(rootCount / size),
        pageSize: size,
        count: totalCount,
        data,
    };
}

/**
 * 获取评论数量 (Waline 兼容的 type=count)
 */
export async function getCommentCount(spaceId, urls = null, options = {}) {
    const { userId = null, forceArray = false } = options;
    const visibleWhere = await buildVisibleCommentWhere(userId);

    if (!urls || (Array.isArray(urls) && urls.length === 0)) {
        return prisma.ow_comment_service.count({
            where: { space_id: spaceId, ...visibleWhere },
        });
    }

    if (!Array.isArray(urls)) urls = [urls];

    const groups = await prisma.ow_comment_service.groupBy({
        by: ['url'],
        where: { space_id: spaceId, url: { in: [...new Set(urls)] }, ...visibleWhere },
        _count: { _all: true },
    });
    const countByUrl = new Map(groups.map(group => [group.url, group._count._all]));
    // Waline expects the original order, including duplicate URLs and zero counts.
    const counts = urls.map(url => countByUrl.get(url) || 0);

    return forceArray || counts.length > 1 ? counts : counts[0];
}

/**
 * 获取最新评论 (type=recent)
 */
export async function getRecentComments(spaceId, count = 10, config = {}, options = {}) {
    const { userId = null, isAdmin = false } = options;
    const where = { space_id: spaceId, ...await buildVisibleCommentWhere(userId) };
    const take = Math.max(1, Math.min(50, parseInt(count, 10) || 10));

    const comments = await prisma.ow_comment_service.findMany({
        where,
        orderBy: { insertedAt: 'desc' },
        take,
    });

    const userIds = [...new Set(
        comments.filter(c => c.account_user_id).map(c => Number(c.account_user_id))
    )];
    const { spaceUsersMap, zcUsersMap, profileVisibility } = await loadCommentUsers(spaceId, userIds, userId);

    // 用户等级
    let userLevelMap = null;
    if (config.levels && userIds.length > 0) {
        userLevelMap = await batchGetUserLevels(spaceId, userIds, config.levels);
    }

    return Promise.all(
        comments.map(c =>
            formatComment(c, {
                profileVisibility,
                viewerId: userId,
                isAdmin,
                spaceUser: c.account_user_id ? spaceUsersMap.get(Number(c.account_user_id)) || null : null,
                zcUser: c.account_user_id ? zcUsersMap.get(Number(c.account_user_id)) || null : null,
                disableUserAgent: config.disableUserAgent === 'true',
                disableRegion: config.disableRegion === 'true',
                userLevelMap,
            })
        )
    );
}

/**
 * 管理列表 (type=list, 管理员用)
 * 支持 keyword 参数进行 pg_trgm 搜索
 */
export async function getCommentList(spaceId, query, config = {}, options = {}) {
    const { page = 1, pageSize = 10, status, owner, keyword, userId = null } = query;
    await authorizeCommentOperation(spaceId, null, 'read', userId, options);
    const pageNum = Math.max(1, parseInt(page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize) || 10));

    // 有搜索关键词时使用 pg_trgm
    if (keyword && keyword.trim()) {
        return _searchComments(spaceId, keyword.trim(), { pageNum, size, status, owner, userId: query.userId });
    }

    const commentVisibility = await visibleWhere('comment_service', userId);
    const where = { space_id: spaceId, AND: [commentVisibility] };
    if (status) where.status = status;
    if (owner === 'mine' && query.userId) {
        where.account_user_id = Number(query.userId);
    }

    const [comments, count, statusCounts] = await Promise.all([
        prisma.ow_comment_service.findMany({
            where,
            orderBy: { insertedAt: 'desc' },
            skip: (pageNum - 1) * size,
            take: size,
        }),
        prisma.ow_comment_service.count({ where }),
        getModerationCounts(spaceId, commentVisibility),
    ]);
    const { spamCount, waitingCount } = statusCounts;

    const userIds = [...new Set(
        comments.filter(c => c.account_user_id).map(c => Number(c.account_user_id))
    )];
    const { spaceUsersMap, zcUsersMap, profileVisibility } = await loadCommentUsers(spaceId, userIds);

    // 用户等级 (管理列表)
    let userLevelMap = null;
    if (config.levels && userIds.length > 0) {
        userLevelMap = await batchGetUserLevels(spaceId, userIds, config.levels);
    }

    const data = await Promise.all(
        comments.map(c =>
            formatComment(c, {
                profileVisibility,
                isAdmin: true,
                spaceUser: c.account_user_id ? spaceUsersMap.get(Number(c.account_user_id)) || null : null,
                zcUser: c.account_user_id ? zcUsersMap.get(Number(c.account_user_id)) || null : null,
                userLevelMap,
            })
        )
    );

    return {
        page: pageNum,
        totalPages: Math.ceil(count / size),
        pageSize: size,
        spamCount,
        waitingCount,
        count,
        data,
    };
}

/**
 * pg_trgm 搜索评论 (内部方法)
 */
async function _searchComments(spaceId, keyword, { pageNum, size, status, owner, userId }) {
    const params = [keyword, spaceId];
    const conditions = ['c.space_id = $2'];

    if (status) {
        params.push(status);
        conditions.push(`c.status = $${params.length}`);
    }
    if (owner === 'mine' && userId) {
        params.push(Number(userId));
        conditions.push(`c.account_user_id = $${params.length}`);
    }

    const moderation = await visibleSql('comment_service', 'c', userId);
    const paramOffset = params.length;
    conditions.push(`(${moderation.text.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + paramOffset}`)})`);
    params.push(...moderation.values);
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const scoreExpr = "similarity(COALESCE(c.comment, ''), $1)";

    const dataSql = `
        SELECT c.id, ${scoreExpr} AS score
        FROM ow_comment_service c
        ${whereSql} AND (c.comment ILIKE '%' || $1 || '%' OR ${scoreExpr} > 0.1)
        ORDER BY score DESC, c."insertedAt" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `
        SELECT COUNT(*)::int AS total
        FROM ow_comment_service c
        ${whereSql} AND (c.comment ILIKE '%' || $1 || '%' OR ${scoreExpr} > 0.1)
    `;

    const [rows, countRows, statusCounts] = await Promise.all([
        prisma.$queryRawUnsafe(dataSql, ...params, size, (pageNum - 1) * size),
        prisma.$queryRawUnsafe(countSql, ...params),
        getModerationCounts(spaceId, await visibleWhere('comment_service', userId)),
    ]);
    const { spamCount, waitingCount } = statusCounts;

    const count = countRows[0]?.total || 0;
    const ids = rows.map(r => r.id);

    if (ids.length === 0) {
        return { page: pageNum, totalPages: 0, pageSize: size, spamCount, waitingCount, count: 0, data: [] };
    }

    // 用 Prisma 查出完整记录
    const comments = await prisma.ow_comment_service.findMany({
        where: { id: { in: ids }, AND: [await visibleWhere('comment_service', userId)] },
    });

    // 保持 score 排序
    const commentMap = new Map(comments.map(c => [c.id, c]));
    const sorted = ids.map(id => commentMap.get(id)).filter(Boolean);

    const userIds = [...new Set(sorted.filter(c => c.account_user_id).map(c => Number(c.account_user_id)))];
    const { spaceUsersMap, zcUsersMap, profileVisibility } = await loadCommentUsers(spaceId, userIds);

    const data = await Promise.all(
        sorted.map(c =>
            formatComment(c, {
                profileVisibility,
                isAdmin: true,
                spaceUser: c.account_user_id ? spaceUsersMap.get(Number(c.account_user_id)) || null : null,
                zcUser: c.account_user_id ? zcUsersMap.get(Number(c.account_user_id)) || null : null,
            })
        )
    );

    return { page: pageNum, totalPages: Math.ceil(count / size), pageSize: size, spamCount, waitingCount, count, data };
}

/**
 * 搜索用户自己在所有空间的评论 (pg_trgm)
 */
export async function searchMyComments(userId, keyword, page = 1, pageSize = 10) {
    const params = [keyword, Number(userId)];
    const scoreExpr = "similarity(COALESCE(c.comment, ''), $1)";

    const dataSql = `
        SELECT c.id, ${scoreExpr} AS score
        FROM ow_comment_service c
        WHERE c.account_user_id = $2 AND (c.comment ILIKE '%' || $1 || '%' OR ${scoreExpr} > 0.1)
        ORDER BY score DESC, c."insertedAt" DESC
        LIMIT $3 OFFSET $4
    `;
    const countSql = `
        SELECT COUNT(*)::int AS total
        FROM ow_comment_service c
        WHERE c.account_user_id = $2 AND (c.comment ILIKE '%' || $1 || '%' OR ${scoreExpr} > 0.1)
    `;

    const [rows, countRows] = await Promise.all([
        prisma.$queryRawUnsafe(dataSql, ...params, pageSize, (page - 1) * pageSize),
        prisma.$queryRawUnsafe(countSql, ...params),
    ]);

    const count = countRows[0]?.total || 0;
    const ids = rows.map(r => r.id);

    if (ids.length === 0) {
        return { page, totalPages: 0, pageSize, count: 0, data: [] };
    }

    const comments = await prisma.ow_comment_service.findMany({
        where: { id: { in: ids }, AND: [await visibleWhere('comment_service', userId)] },
        include: { space: { select: { cuid: true, name: true } } },
    });

    const commentMap = new Map(comments.map(c => [c.id, c]));
    const sorted = ids.map(id => commentMap.get(id)).filter(Boolean);

    const data = sorted.map(c => ({
        objectId: String(c.id),
        comment: renderMarkdown(c.comment),
        orig: c.comment,
        url: c.url,
        status: c.status,
        insertedAt: c.insertedAt.toISOString(),
        space: c.space ? { cuid: c.space.cuid, name: c.space.name } : null,
    }));

    return { page, totalPages: Math.ceil(count / pageSize), pageSize, count, data };
}

export async function getComment(commentId, userId, { authorizationContext } = {}) {
    const decision = await authorizeResourceOperation(userId, 'comment', commentId, 'read', authorizationContext);
    const comment = await prisma.ow_comment_service.findUnique({ where: { id: Number(commentId) } });
    const space = comment && await prisma.ow_comment_spaces.findUnique({ where: { id: comment.space_id } });
    if (!comment || !space || space.status !== 'active' || !await canViewContent('comment_service', comment, userId)
        || (comment.status !== 'approved' && (!decision.resourceGrant || decision.delegationId != null)
            && comment.account_user_id !== decision.principalId)) return null;
    return comment;
}

/**
 * 更新评论
 */
export async function updateComment(spaceId, commentId, data, userId = null, isAdmin = false, options = {}) {
    const isLikeOnly = Object.keys(data).length === 1 && data.like !== undefined;
    const action = isLikeOnly ? 'interact' : 'update';
    if (userId) await assertCanWrite(Number(userId), 'comments', action);
    const decision = await authorizeCommentOperation(spaceId, commentId, action, userId, options);
    const spaceAdmin = Boolean(isAdmin && (!options.authorizationContext || options.spaceCuid));
    const comment = await prisma.ow_comment_service.findFirst({
        where: { id: parseInt(commentId), space_id: spaceId },
    });

    if (!comment || !await canViewContent('comment_service', comment, userId)) return null;

    // 仅点赞操作允许匿名，其他编辑需校验归属
    if (!isLikeOnly && !spaceAdmin && (!decision.allowed || decision.delegationId != null)
        && comment.account_user_id !== decision.principalId) {
        return null;
    }

    const updateData = {};
    if (data.comment !== undefined) updateData.comment = sanitizeComment(data.comment);
    if (data.nick !== undefined) updateData.nick = data.nick;
    if (data.mail !== undefined) updateData.mail = data.mail;
    if (data.link !== undefined) updateData.link = data.link;
    if (data.status !== undefined && spaceAdmin) updateData.status = data.status;
    if (data.sticky !== undefined && spaceAdmin) updateData.sticky = data.sticky;
    if (data.like !== undefined) {
        // Waline 客户端发送 like: true/false 表示点赞/取消，转为 increment/decrement
        if (data.like === true) {
            updateData.like = { increment: 1 };
        } else if (data.like === false) {
            updateData.like = { decrement: 1 };
        } else {
            updateData.like = parseInt(data.like) || 0;
        }
    }

    return prisma.ow_comment_service.update({
        where: { id: parseInt(commentId) },
        data: updateData,
    });
}

/**
 * 删除评论
 */
export async function deleteComment(spaceId, commentId, userId = null, isAdmin = false, options = {}) {
    if (userId) await assertCanWrite(Number(userId), 'comments', 'delete');
    const decision = await authorizeCommentOperation(spaceId, commentId, 'delete', userId, options);
    const spaceAdmin = Boolean(isAdmin && (!options.authorizationContext || options.spaceCuid));
    const comment = await prisma.ow_comment_service.findFirst({
        where: { id: parseInt(commentId), space_id: spaceId },
    });

    if (!comment || !await canViewContent('comment_service', comment, userId)) return false;

    // 非管理员只能删除自己的评论
    if (!spaceAdmin && (!decision.allowed || decision.delegationId != null)
        && comment.account_user_id !== decision.principalId) {
        return false;
    }

    // 删除评论及其所有子评论
    await prisma.ow_comment_service.deleteMany({
        where: {
            space_id: spaceId,
            AND: [await visibleWhere('comment_service', userId)],
            OR: [
                { id: parseInt(commentId) },
                ...(!options.authorizationContext || options.spaceCuid ? [{ rid: String(commentId) }] : []),
            ],
        },
    });

    return true;
}

export default {
    checkIpRate,
    checkDuplicate,
    checkForbiddenWords,
    createComment,
    getComments,
    getCommentCount,
    getRecentComments,
    getCommentList,
    getComment,
    searchMyComments,
    updateComment,
    deleteComment,
};
