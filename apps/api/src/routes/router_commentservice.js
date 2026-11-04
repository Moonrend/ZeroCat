import { Router } from 'express';
import crypto from 'crypto';
import logger from '../services/logger.js';
import zcconfig from '../services/config/zcconfig.js';
import { parseToken, needLogin, needAdmin } from '../middleware/auth.js';
import { requireResource, requireScope } from '../middleware/scope.js';
import queueManager from '../services/queue/queueManager.js';
import { prisma } from '../services/prisma.js';
import { createWalineToken } from '../services/commentService/walineAuth.js';
import {
    createSpace,
    getSpaceByGuid,
    listSpaces,
    updateSpace,
    deleteSpace,
    getSpaceConfig,
    updateSpaceConfig,
    getOrCreateSpaceUser,
    listSpaceUsers,
    updateSpaceUser,
    getSpaceStats,
    adminListSpaces,
    adminGetSpace,
    adminUpdateSpaceStatus,
} from '../services/commentService/spaceManager.js';
import {
    getCommentList,
    getComment,
    searchMyComments,
    updateComment,
    deleteComment,
} from '../services/commentService/commentManager.js';
import { toWalineType } from '../services/commentService/walineFormatter.js';
import { renderMarkdown } from '../services/commentService/markdown.js';
import { visibleWhere, assertCanWrite } from '../services/moderation/visibility.js';
import { authorizeResourceOperation, resourceAuthorizationContext } from '../services/auth/resourceOperation.js';
import {
    createTask,
    getTask,
    listTasks,
    getExportData,
} from '../services/commentService/dataService.js';

const router = Router();

/** 剥离敏感字段 */
function sanitizeSpace(space) {
    if (!space) return space;
    const { jwt_secret, ...safe } = space;
    return safe;
}

// 所有路由需要 ZeroCat 认证
router.use(parseToken);

// ============================================================
// 空间管理
// ============================================================

/**
 * POST /commentservice/spaces
 * 创建空间
 */
router.post('/spaces', needLogin, requireScope("comment:manage"), async (req, res, next) => {
    try {
        const { name, domain } = req.body;
        if (!name) {
            return res.status(400).json({ status: 'error', message: '空间名称不能为空' });
        }

        const space = await createSpace(res.locals.userid, name, domain || null);
        return res.json({ status: 'success', data: sanitizeSpace(space) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/spaces
 * 列出我的空间
 */
router.get('/spaces', needLogin, requireScope("comment:read"), async (req, res, next) => {
    try {
        const spaces = await listSpaces(res.locals.userid);
        return res.json({ status: 'success', data: spaces.map(sanitizeSpace) });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/spaces/:cuid
 * 空间详情
 * - 所有者: 返回完整信息
 * - 其他用户: 返回公开信息 (名称、所有者、审核员、域名、创建时间)
 */
router.get('/spaces/:cuid', (req, res, next) => {
    if (req.headers['x-zerocat-delegation'] !== undefined) {
        return res.status(403).json({ status: 'error', code: 'ZC_ERROR_DELEGATION_NOT_SUPPORTED', message: '此操作不支持授权委托' });
    }
    next();
}, async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.status !== 'active') {
            return res.status(404).json({ status: 'error', message: '空间不存在' });
        }

        const isOwner = res.locals.userid && space.owner_id === res.locals.userid;

        // 获取所有者和管理团队信息 (所有人都能看到)
        const profileVisibility = await visibleWhere('profile', res.locals.userid);
        const [owner, staff] = await Promise.all([
            prisma.ow_users.findFirst({
                where: { id: space.owner_id, AND: [profileVisibility] },
                select: { id: true, username: true, display_name: true, avatar: true },
            }),
            prisma.ow_comment_service_users.findMany({
                where: {
                    space_id: space.id,
                    type: { in: ['administrator', 'moderator'] },
                    user: profileVisibility,
                },
                include: {
                    user: {
                        select: { id: true, username: true, display_name: true, avatar: true },
                    },
                },
            }),
        ]);

        const moderators = staff.map(s => ({
            id: s.user_id,
            username: s.user?.username || '',
            display_name: s.user?.display_name || '',
            avatar: s.user?.avatar || '',
            role: s.type,
        }));

        const ownerInfo = owner ? {
            id: owner.id,
            username: owner.username,
            display_name: owner.display_name,
            avatar: owner.avatar,
        } : null;

        if (isOwner) {
            return res.json({
                status: 'success',
                data: { ...sanitizeSpace(space), owner: ownerInfo, moderators },
            });
        }

        // 非所有者: 返回公开信息
        return res.json({
            status: 'success',
            data: {
                cuid: space.cuid,
                name: space.name,
                domain: space.domain,
                created_at: space.created_at,
                owner: ownerInfo,
                moderators,
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/spaces/:cuid
 * 更新空间
 */
router.put('/spaces/:cuid', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const updated = await updateSpace(req.params.cuid, res.locals.userid, req.body);
        if (!updated) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }
        return res.json({ status: 'success', data: sanitizeSpace(updated) });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /commentservice/spaces/:cuid
 * 删除空间
 */
router.delete('/spaces/:cuid', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const deleted = await deleteSpace(req.params.cuid, res.locals.userid);
        if (!deleted) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }
        return res.json({ status: 'success', message: '空间已删除' });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 空间配置
// ============================================================

/**
 * GET /commentservice/spaces/:cuid/config
 * 获取空间配置
 */
router.get('/spaces/:cuid/config', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const config = await getSpaceConfig(req.params.cuid);
        return res.json({ status: 'success', data: config });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/spaces/:cuid/config
 * 更新空间配置
 */
router.put('/spaces/:cuid/config', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const updated = await updateSpaceConfig(req.params.cuid, res.locals.userid, req.body);
        if (!updated) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        // 部分字段校验未通过时，返回已保存的合法部分 + 错误列表
        if (updated.errors) {
            return res.json({ status: 'partial', data: updated.config, errors: updated.errors });
        }
        return res.json({ status: 'success', data: updated });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 评论管理
// ============================================================

/**
 * GET /commentservice/spaces/:cuid/comments
 * 评论管理列表
 */
router.get('/spaces/:cuid/comments', needLogin, requireResource("comment", "read", "cuid", { allowDelegation: true }), async (req, res, next) => {
    try {
        const decision = await authorizeResourceOperation(res.locals.userid, 'comment', req.params.cuid, 'read', resourceAuthorizationContext(req, res));
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || ((!decision.resourceGrant || decision.delegationId != null) && space.owner_id !== decision.principalId)) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const data = await getCommentList(space.id, { ...req.query, userId: res.locals.userid }, {}, {
            spaceCuid: req.params.cuid, authorizationContext: resourceAuthorizationContext(req, res),
        });
        return res.json({ status: 'success', data });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/spaces/:cuid/comments/:id
 * 审核评论 (更新状态)
 */
router.put('/spaces/:cuid/comments/:id', needLogin, requireScope((req) => {
    const likeOnly = Object.keys(req.body || {}).length === 1 && req.body.like !== undefined;
    return `comment:${req.params.cuid}:${likeOnly ? 'interact' : 'update'}`;
}, { allowDelegation: true }), async (req, res, next) => {
    try {
        const likeOnly = Object.keys(req.body || {}).length === 1 && req.body.like !== undefined;
        const decision = await authorizeResourceOperation(res.locals.userid, 'comment', req.params.cuid, likeOnly ? 'interact' : 'update', resourceAuthorizationContext(req, res));
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || ((!decision.resourceGrant || decision.delegationId != null) && space.owner_id !== decision.principalId)) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const updated = await updateComment(
            space.id,
            req.params.id,
            req.body,
            res.locals.userid,
            true, // isAdmin
            { spaceCuid: req.params.cuid, authorizationContext: resourceAuthorizationContext(req, res) },
        );

        if (!updated) {
            return res.status(404).json({ status: 'error', message: '评论不存在' });
        }

        // 审核通过时，为有 pid 的评论触发回复通知
        if (req.body.status === 'approved' && updated.pid) {
            try {
                queueManager.enqueueCommentNotification('reply_notification', updated.id, space.id, space.cuid);
            } catch (e) {
                logger.warn('[commentservice] Failed to enqueue approve notification:', e.message);
            }
        }

        return res.json({ status: 'success', data: updated });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /commentservice/spaces/:cuid/comments/:id
 * 删除评论
 */
router.delete('/spaces/:cuid/comments/:id', needLogin, requireResource("comment", "delete", "cuid", { allowDelegation: true }), async (req, res, next) => {
    try {
        const decision = await authorizeResourceOperation(res.locals.userid, 'comment', req.params.cuid, 'delete', resourceAuthorizationContext(req, res));
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || ((!decision.resourceGrant || decision.delegationId != null) && space.owner_id !== decision.principalId)) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const deleted = await deleteComment(
            space.id,
            req.params.id,
            res.locals.userid,
            true, // isAdmin
            { spaceCuid: req.params.cuid, authorizationContext: resourceAuthorizationContext(req, res) },
        );

        if (!deleted) {
            return res.status(404).json({ status: 'error', message: '评论不存在' });
        }

        return res.json({ status: 'success', message: '评论已删除' });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 空间用户管理
// ============================================================

/**
 * GET /commentservice/spaces/:cuid/users
 * 空间用户列表
 */
router.get('/spaces/:cuid/users', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const data = await listSpaceUsers(
            space.id,
            parseInt(req.query.page) || 1,
            parseInt(req.query.pageSize) || 20,
            { type: req.query.type || null, keyword: req.query.keyword || null },
        );
        return res.json({ status: 'success', data });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/spaces/:cuid/users/:userId
 * 更新用户角色 (只能设为 moderator/guest/banned, 不能设为 administrator)
 */
router.put('/spaces/:cuid/users/:userId', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const targetUserId = parseInt(req.params.userId);

        // 不能修改 owner 自己的角色
        if (targetUserId === space.owner_id) {
            return res.status(400).json({ status: 'error', message: '不能修改空间所有者的角色' });
        }

        // 只允许设置 moderator/guest/banned
        if (req.body.type && !['moderator', 'guest', 'banned'].includes(req.body.type)) {
            return res.status(400).json({ status: 'error', message: '只能设置为 moderator、guest 或 banned' });
        }

        const updated = await updateSpaceUser(
            space.id,
            targetUserId,
            req.body,
        );

        return res.json({ status: 'success', data: updated });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 空间统计
// ============================================================

/**
 * GET /commentservice/spaces/:cuid/stats
 * 空间统计
 */
router.get('/spaces/:cuid/stats', needLogin, requireResource("comment", "read", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const stats = await getSpaceStats(space.id);
        return res.json({ status: 'success', data: stats });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// UI Login (ZeroCat token -> Waline JWT)
// ============================================================

/**
 * POST /commentservice/ui/login
 * ZeroCat token 换取 Waline JWT
 * 前端在用户登录后调用此接口
 */
router.post('/ui/login', needLogin, requireScope("comment:create"), async (req, res, next) => {
    try {
        const { spaceCuid } = req.body;
        if (!spaceCuid) {
            return res.status(400).json({ errno: 1, errmsg: '缺少 spaceCuid' });
        }

        const space = await getSpaceByGuid(spaceCuid);
        if (!space || space.status !== 'active') {
            return res.status(404).json({ errno: 1, errmsg: '评论空间不存在' });
        }

        const userId = res.locals.userid;

        // 获取用户信息
        const user = await prisma.ow_users.findUnique({
            where: { id: userId },
            select: {
                id: true, username: true, display_name: true,
                avatar: true, email: true, type: true,
                url: true, bio: true, label: true,
            },
        });

        if (!user) {
            return res.status(404).json({ errno: 1, errmsg: '用户不存在' });
        }

        // 确保空间用户映射存在
        const spaceUser = await getOrCreateSpaceUser(space.id, userId, {
            display_name: user.display_name || user.username,
            email: user.email,
            avatar: user.avatar,
        });

        // 生成 Waline JWT
        const token = createWalineToken(userId, space.jwt_secret);

        // 计算 mailMd5 (Gravatar)
        const mail = spaceUser.email || user.email || '';
        const mailMd5 = mail
            ? crypto.createHash('md5').update(mail.trim().toLowerCase()).digest('hex')
            : '';

        // 拼接 avatar 完整 URL
        const staticUrl = await zcconfig.get('s3.staticurl');
        const rawAvatar = spaceUser.avatar || user.avatar || '';
        const avatarUrl = rawAvatar ? `${staticUrl}/assets/${rawAvatar.substring(0, 2)}/${rawAvatar.substring(2, 4)}/${rawAvatar}.webp` : '';

        return res.json({
            errno: 0,
            data: {
                token,
                nick: spaceUser.display_name || user.display_name || user.username,
                mail,
                avatar: avatarUrl,
                link: spaceUser.url || user.url || '',
                type: toWalineType(spaceUser.type),
                label: spaceUser.label || user.label || '',
                objectId: String(userId),
                mailMd5,
                // ZeroCat 用户扩展信息
                username: user.username,
                display_name: user.display_name,
                bio: user.bio || '',
            },
        });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 数据导入导出
// ============================================================

/**
 * POST /commentservice/spaces/:cuid/data/export
 * 发起导出任务
 */
router.post('/spaces/:cuid/data/export', needLogin, requireResource("comment", "read", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const taskId = crypto.randomUUID();
        await createTask(taskId, space.id, res.locals.userid, 'export', {
            spaceCuid: space.cuid,
            spaceName: space.name,
        });

        const enqueued = await queueManager.enqueueDataTask(
            taskId, 'export', space.id, space.cuid, space.name, res.locals.userid,
        );

        if (!enqueued) {
            return res.status(503).json({ status: 'error', message: '任务队列不可用，请稍后重试' });
        }

        return res.json({ status: 'success', data: { taskId } });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /commentservice/spaces/:cuid/data/import
 * 发起导入任务
 * Body: Waline JSON 格式
 * { __version, type, version, time, tables, data: { Comment: [...], Counter: [...], Users: [...] } }
 */
router.post('/spaces/:cuid/data/import', needLogin, requireResource("comment", "manage", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        await assertCanWrite(Number(res.locals.userid), 'comments', 'manage');
        const importData = req.body;
        if (!importData?.data || !Array.isArray(importData.data.Comment) || importData.data.Comment.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: '请提供有效的 Waline JSON 数据 (需包含 data.Comment 数组)',
            });
        }

        const taskId = crypto.randomUUID();
        await createTask(taskId, space.id, res.locals.userid, 'import', {
            spaceCuid: space.cuid,
            spaceName: space.name,
        });

        const enqueued = await queueManager.enqueueDataTask(
            taskId, 'import', space.id, space.cuid, space.name, res.locals.userid, importData.data,
        );

        if (!enqueued) {
            return res.status(503).json({ status: 'error', message: '任务队列不可用，请稍后重试' });
        }

        return res.json({ status: 'success', data: { taskId } });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/spaces/:cuid/data/tasks
 * 查看空间的导入导出任务列表
 */
router.get('/spaces/:cuid/data/tasks', needLogin, requireResource("comment", "read", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const tasks = await listTasks(space.id);
        return res.json({ status: 'success', data: tasks });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/spaces/:cuid/data/tasks/:taskId
 * 查看任务详情/进度
 */
router.get('/spaces/:cuid/data/tasks/:taskId', needLogin, requireResource("comment", "read", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const task = await getTask(req.params.taskId);
        if (!task || task.space_id !== space.id) {
            return res.status(404).json({ status: 'error', message: '任务不存在' });
        }

        return res.json({ status: 'success', data: task });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/spaces/:cuid/data/tasks/:taskId/download
 * 下载导出结果 (仅导出任务，完成后 1 小时内有效)
 */
router.get('/spaces/:cuid/data/tasks/:taskId/download', needLogin, requireResource("comment", "read", "cuid"), async (req, res, next) => {
    try {
        const space = await getSpaceByGuid(req.params.cuid);
        if (!space || space.owner_id !== res.locals.userid) {
            return res.status(404).json({ status: 'error', message: '空间不存在或无权限' });
        }

        const task = await getTask(req.params.taskId);
        if (!task || task.space_id !== space.id) {
            return res.status(404).json({ status: 'error', message: '任务不存在' });
        }
        if (task.type !== 'export') {
            return res.status(400).json({ status: 'error', message: '该任务不是导出任务' });
        }
        if (task.status !== 'completed') {
            return res.status(400).json({ status: 'error', message: '任务尚未完成' });
        }

        const jsonData = await getExportData(req.params.taskId);
        if (!jsonData) {
            return res.status(410).json({ status: 'error', message: '导出数据已过期，请重新导出' });
        }

        const filename = `comments-${space.cuid}-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(jsonData);
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 单条评论 (统一令牌与具体资源委托)
// ============================================================

router.use('/comments/:id', (req, res, next) => {
    const id = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
        return res.status(400).json({ status: 'error', code: 'ZC_ERROR_INVALID_ID', message: '无效评论 ID' });
    }
    next();
});

router.get('/comments/:id', needLogin, requireResource('comment', 'read', 'id', { allowDelegation: true }), async (req, res, next) => {
    try {
        const comment = await getComment(req.params.id, res.locals.userid, { authorizationContext: resourceAuthorizationContext(req, res) });
        if (!comment) return res.status(404).json({ status: 'error', message: '评论不存在' });
        return res.json({ status: 'success', data: { objectId: String(comment.id), comment: renderMarkdown(comment.comment),
            orig: comment.comment, url: comment.url, status: comment.status, insertedAt: comment.insertedAt } });
    } catch (err) { next(err); }
});

router.put('/comments/:id', needLogin, requireScope((req) => {
    const likeOnly = Object.keys(req.body || {}).length === 1 && req.body.like !== undefined;
    return `comment:${req.params.id}:${likeOnly ? 'interact' : 'update'}`;
}, { allowDelegation: true }), async (req, res, next) => {
    try {
        const comment = await prisma.ow_comment_service.findUnique({ where: { id: Number(req.params.id) } });
        if (!comment) return res.status(404).json({ status: 'error', message: '评论不存在' });
        const updated = await updateComment(comment.space_id, req.params.id, req.body, res.locals.userid, false,
            { authorizationContext: resourceAuthorizationContext(req, res) });
        if (!updated) return res.status(404).json({ status: 'error', message: '评论不存在或无权限' });
        return res.json({ status: 'success', data: { objectId: String(updated.id) } });
    } catch (err) { next(err); }
});

router.delete('/comments/:id', needLogin, requireResource('comment', 'delete', 'id', { allowDelegation: true }), async (req, res, next) => {
    try {
        const comment = await prisma.ow_comment_service.findUnique({ where: { id: Number(req.params.id) } });
        if (!comment) return res.status(404).json({ status: 'error', message: '评论不存在' });
        const deleted = await deleteComment(comment.space_id, req.params.id, res.locals.userid, false,
            { authorizationContext: resourceAuthorizationContext(req, res) });
        if (!deleted) return res.status(404).json({ status: 'error', message: '评论不存在或无权限' });
        return res.json({ status: 'success', message: '评论已删除' });
    } catch (err) { next(err); }
});

// ============================================================
// 我的评论
// ============================================================

/**
 * GET /commentservice/my/comments
 * 我在所有空间的评论
 */
router.get('/my/comments', needLogin, requireScope("comment:read"), async (req, res, next) => {
    try {
        const userId = res.locals.userid;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
        const keyword = req.query.keyword;

        // 有搜索关键词时使用 pg_trgm 搜索
        if (keyword && keyword.trim()) {
            const result = await searchMyComments(userId, keyword.trim(), page, pageSize);
            return res.json({ status: 'success', data: result });
        }

        const where = { account_user_id: Number(userId) };
        const [comments, count] = await Promise.all([
            prisma.ow_comment_service.findMany({
                where,
                orderBy: { insertedAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
                include: {
                    space: { select: { cuid: true, name: true } },
                },
            }),
            prisma.ow_comment_service.count({ where }),
        ]);

        const data = comments.map(c => ({
            objectId: String(c.id),
            comment: renderMarkdown(c.comment),
            orig: c.comment,
            url: c.url,
            status: c.status,
            insertedAt: c.insertedAt.toISOString(),
            space: c.space ? { cuid: c.space.cuid, name: c.space.name } : null,
        }));

        return res.json({
            status: 'success',
            data: {
                page,
                totalPages: Math.ceil(count / pageSize),
                pageSize,
                count,
                data,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 管理员：敏感词管理
// ============================================================

/**
 * GET /commentservice/admin/sensitive-words
 * 获取敏感词列表
 */
router.get('/admin/sensitive-words', needAdmin, async (req, res, next) => {
    try {
        let words = await zcconfig.get('commentservice.sensitive_words');
        if (typeof words === 'string') {
            try { words = JSON.parse(words); } catch { words = []; }
        }
        if (!Array.isArray(words)) words = [];
        return res.json({ status: 'success', data: { words } });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/admin/sensitive-words
 * 更新敏感词列表
 */
router.put('/admin/sensitive-words', needAdmin, async (req, res, next) => {
    try {
        const { words } = req.body;
        if (!Array.isArray(words)) {
            return res.status(400).json({ status: 'error', message: 'words 必须是字符串数组' });
        }
        const cleaned = words.map(w => String(w).trim()).filter(Boolean);
        await zcconfig.set('commentservice.sensitive_words', JSON.stringify(cleaned));
        return res.json({ status: 'success', data: { words: cleaned } });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/admin/sensitive-ban-duration
 * 获取敏感词封禁时长
 */
router.get('/admin/sensitive-ban-duration', needAdmin, async (req, res, next) => {
    try {
        const duration = await zcconfig.get('commentservice.sensitive_ban_duration');
        return res.json({ status: 'success', data: { duration: (typeof duration === 'number' && duration > 0) ? duration : 3600 } });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/admin/sensitive-ban-duration
 * 更新敏感词封禁时长
 */
router.put('/admin/sensitive-ban-duration', needAdmin, async (req, res, next) => {
    try {
        const { duration } = req.body;
        if (typeof duration !== 'number' || duration <= 0) {
            return res.status(400).json({ status: 'error', message: '封禁时长必须是正整数（秒）' });
        }
        await zcconfig.set('commentservice.sensitive_ban_duration', duration);
        return res.json({ status: 'success', data: { duration } });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// 管理员：空间管理
// ============================================================

/**
 * GET /commentservice/admin/spaces
 * 分页列出所有评论空间
 */
router.get('/admin/spaces', needAdmin, async (req, res, next) => {
    try {
        const result = await adminListSpaces({
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status || null,
            search: req.query.search || null,
        });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/admin/spaces/:spaceId
 * 获取单个空间详情
 */
router.get('/admin/spaces/:spaceId', needAdmin, async (req, res, next) => {
    try {
        const space = await adminGetSpace(req.params.spaceId);
        if (!space) {
            return res.status(404).json({ status: 'error', message: '空间不存在' });
        }
        return res.json({ status: 'success', data: space });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /commentservice/admin/spaces/:spaceId/status
 * 修改空间状态
 */
router.put('/admin/spaces/:spaceId/status', needAdmin, async (req, res, next) => {
    try {
        const { status } = req.body;
        if (!status) {
            return res.status(400).json({ status: 'error', message: '缺少 status 字段' });
        }
        const updated = await adminUpdateSpaceStatus(req.params.spaceId, status);
        const { jwt_secret, ...safe } = updated;
        return res.json({ status: 'success', data: safe });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /commentservice/admin/violations
 * 查看敏感词违规日志
 */
router.get('/admin/violations', needAdmin, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

        const [rows, countRows] = await Promise.all([
            prisma.$queryRawUnsafe(
                `SELECT "key", "value", "created_at" FROM ow_cache_kv
                 WHERE "user_id" = 0 AND "key" LIKE 'cs:violation:%'
                 ORDER BY "created_at" DESC
                 LIMIT $1 OFFSET $2`,
                limit,
                (page - 1) * limit,
            ),
            prisma.$queryRawUnsafe(
                `SELECT COUNT(*)::int AS total FROM ow_cache_kv
                 WHERE "user_id" = 0 AND "key" LIKE 'cs:violation:%'`,
            ),
        ]);

        const count = countRows[0]?.total || 0;
        const data = rows.map(r => {
            let parsed = {};
            try { parsed = JSON.parse(r.value); } catch {}
            return {
                key: r.key,
                ...parsed,
                created_at: r.created_at,
            };
        });

        return res.json({
            status: 'success',
            data: {
                page,
                totalPages: Math.ceil(count / limit),
                pageSize: limit,
                count,
                data,
            },
        });
    } catch (err) {
        next(err);
    }
});

export default router;
