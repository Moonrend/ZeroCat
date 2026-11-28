import { Router } from 'express';
import crypto from 'crypto';
import logger from '../services/logger.js';
import zcconfig from '../services/config/zcconfig.js';
import { prisma } from '../services/prisma.js';
import { walineSpaceResolver, isSpaceAdmin } from '../middleware/walineSpaceResolver.js';
import { isWalineScopeGranted, revokeWalineToken } from '../services/commentService/walineAuth.js';
import {
    getOrCreateSpaceUser,
    getSpaceUser,
    listSpaceUsers,
    updateSpaceUser,
} from '../services/commentService/spaceManager.js';
import {
    checkIpRate,
    checkDuplicate,
    createComment,
    getComments,
    getCommentCount,
    getRecentComments,
    getCommentList,
    updateComment,
    deleteComment,
} from '../services/commentService/commentManager.js';
import { getArticleCounter, updateArticleCounter } from '../services/commentService/counterManager.js';
import { formatComment, toWalineType } from '../services/commentService/walineFormatter.js';
import { verifyCaptcha } from '../services/commentService/captchaService.js';
import {
    checkSensitiveWords,
    isSensitiveBanned,
    banIpForSensitiveWord,
    logSensitiveViolation,
} from '../services/commentService/sensitiveWordService.js';
import queueManager from '../services/queue/queueManager.js';
import { renderMarkdown } from '../services/commentService/markdown.js';
import { visibleWhere, assertCanWrite } from '../services/moderation/visibility.js';

const router = Router();

router.use((req, res, next) => {
    if (req.headers['x-zerocat-delegation'] !== undefined) {
        return res.status(403).json({ errno: 1003, code: 'ZC_ERROR_DELEGATION_NOT_SUPPORTED', errmsg: '请使用统一令牌的评论服务 API 进行委托操作' });
    }
    next();
});

function parseWalineListParam(input, { preserveEmpty = false } = {}) {
    if (input === undefined || input === null) return [];

    const rawList = Array.isArray(input) ? input : [input];
    const result = [];

    for (const raw of rawList) {
        if (raw === undefined || raw === null) continue;
        const parts = String(raw).split(',');
        for (const part of parts) {
            const value = part.trim();
            if (value || preserveEmpty) {
                result.push(value);
            }
        }
    }

    return result;
}

function hasWalineScope(req, requiredScope) {
    return Boolean(req.walineUser)
        && isWalineScopeGranted(req.walineUser.scopes, requiredScope);
}

function walineScopeDenied(res) {
    return res.status(403).json({ errno: 1003, errmsg: '令牌权限不足' });
}

// Waline 示例页面 (在 walineSpaceResolver 之前，跳过域名校验)
router.get('/:spaceCuid', (req, res, next) => {
    // 仅当浏览器直接访问时返回 HTML；API 请求放行到后续路由
    const accept = req.headers.accept || '';
    if (!accept.includes('text/html')) return next();

    const spaceCuid = req.params.cuid || req.params.spaceCuid;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Waline Example</title>
</head>
<body>
  <div id="waline" style="max-width: 800px;margin: 0 auto;"></div>
  <link href='//unpkg.com/@waline/client@v3/dist/waline.css' rel='stylesheet' />
  <script type="module">
    import { init } from 'https://unpkg.com/@waline/client@v3/dist/waline.js';

    console.log(
      '%c @waline/server %c v1.39.0 ',
      'color: white; background: #0078E7; padding:5px 0;',
      'padding:4px;border:1px solid #0078E7;'
    );
    const params = new URLSearchParams(location.search.slice(1));
    const waline = init({
      el: '#waline',
      path: params.get('path') || '/',
      lang: params.get('lng') || undefined,
      serverURL: location.protocol + '//' + location.host + location.pathname.replace(/\\/+$/, ''),
      recaptchaV3Key: '',
      turnstileKey: '',
    });
  </script>
</body>
</html>`;
    res.type('html').send(html);
});

// 所有 /:spaceCuid/* 路由使用空间解析中间件
router.use('/:spaceCuid', walineSpaceResolver);

// ============================================================
// 评论 API
// ============================================================

/**
 * GET /comment/:spaceCuid/api/comment
 * 评论列表 / 计数 / 最新 / 管理列表
 */
router.get('/:spaceCuid/api/comment', async (req, res, next) => {
    try {
        const space = req.commentSpace;
        const config = req.spaceConfig;
        const { type } = req.query;
        const canReadAsUser = hasWalineScope(req, 'comment:read');

        // type=count - 获取评论数量
        if (type === 'count') {
            const hasUrlParam = req.query.url !== undefined;
            const urls = parseWalineListParam(req.query.url);
            const count = await getCommentCount(
                space.id,
                urls.length > 0 ? urls : null,
                {
                    userId: canReadAsUser ? req.walineUser.userId : null,
                    forceArray: hasUrlParam && urls.length > 0,
                },
            );
            return res.json({ errno: 0, errmsg: '', data: count });
        }

        // type=recent - 获取最新评论
        if (type === 'recent') {
            const data = await getRecentComments(space.id, req.query.count, config, {
                userId: canReadAsUser ? req.walineUser.userId : null,
                isAdmin: isSpaceAdmin(req),
            });
            return res.json({ errno: 0, errmsg: '', data });
        }

        // type=list - 管理列表 (需要管理员)
        if (type === 'list') {
            if (!isSpaceAdmin(req)) {
                return res.status(401).json({ errno: 1003, errmsg: '无权限' });
            }
            const data = await getCommentList(space.id, {
                ...req.query,
                userId: req.walineUser?.userId,
            }, config);
            return res.json({ errno: 0, data });
        }

        // 默认 - 评论列表
        const pageUrl = req.query.path || req.query.url;
        if (!pageUrl) {
            return res.json({ errno: 0, data: { page: 1, totalPages: 0, pageSize: 10, count: 0, data: [] } });
        }

        const admin = isSpaceAdmin(req);
        const data = await getComments(
            space.id,
            { url: pageUrl, ...req.query },
            { isAdmin: admin, config, userId: canReadAsUser ? req.walineUser.userId : null },
        );
        return res.json({ errno: 0, data });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /comment/:spaceCuid/api/comment
 * 发表评论
 */
router.post('/:spaceCuid/api/comment', async (req, res, next) => {
    try {
        const space = req.commentSpace;
        const config = req.spaceConfig;
        const ip = req.ipInfo?.clientIP || req.ip;

        if (req.walineUser && !hasWalineScope(req, 'comment:create')) {
            return walineScopeDenied(res);
        }

        // 检查 login=force
        if (config.login === 'force' && !req.walineUser) {
            return res.status(401).json({ errno: 1003, errmsg: '请先登录' });
        }

        const { comment, url } = req.body;
        if (!comment || !url) {
            return res.status(400).json({ errno: 1004, errmsg: '缺少评论内容或页面地址' });
        }

        // 验证码校验
        const turnstileToken = req.body.turnstileToken || req.body['cf-turnstile-response'] || null;
        const recaptchaToken = req.body.recaptchaToken || req.body['g-recaptcha-response'] || null;
        const captchaResult = await verifyCaptcha(config, turnstileToken, recaptchaToken, ip);
        if (!captchaResult.pass) {
            return res.status(403).json({ errno: 1010, errmsg: captchaResult.reason || '验证码校验失败' });
        }

        // IP 频率限制
        const ipqps = parseInt(config.ipqps) || 60;
        const allowed = await checkIpRate(space.id, ip, ipqps);
        if (!allowed) {
            return res.status(429).json({ errno: 1005, errmsg: '请求过于频繁，请稍后再试' });
        }

        // 重复内容检测
        const isDuplicate = await checkDuplicate(space.id, ip, comment);
        if (isDuplicate) {
            return res.status(400).json({ errno: 1006, errmsg: '请勿重复发送相同评论' });
        }

        // 全局敏感词封禁检查
        const sensitiveIpBanned = await isSensitiveBanned(ip);
        if (sensitiveIpBanned) {
            return res.status(403).json({ errno: 1011, errmsg: '您的IP因发送敏感内容已被临时封禁' });
        }

        // 全局敏感词检查
        const sensitiveResult = await checkSensitiveWords(comment);
        if (sensitiveResult.hit) {
            await banIpForSensitiveWord(ip);
            await logSensitiveViolation(space.id, ip, req.body.nick || req.walineUser?.nick || '', sensitiveResult.word, comment);
            return res.status(403).json({ errno: 1012, errmsg: '评论包含敏感词，禁止发送' });
        }

        const ua = req.headers['user-agent'] || '';

        const record = await createComment(
            space.id,
            {
                comment,
                url,
                pid: req.body.pid || null,
                rid: req.body.rid || null,
                nick: req.body.nick || null,
                mail: req.body.mail || null,
                link: req.body.link || null,
                ua,
                ip,
            },
            config,
            req.walineUser,
        );

        // 格式化返回
        const spaceUser = req.walineUser?.userId
            ? await getSpaceUser(space.id, req.walineUser.userId)
            : null;
        const formatted = await formatComment(record, {
            isAdmin: isSpaceAdmin(req),
            spaceUser,
            zcUser: req.walineUser?.zcUser || null,
            disableUserAgent: config.disableUserAgent === 'true',
            disableRegion: config.disableRegion === 'true',
        });

        // 异步入队通知（不阻塞响应）
        try {
            if (record.status === 'approved' || record.status === 'waiting') {
                queueManager.enqueueCommentNotification('admin_new_comment', record.id, space.id, space.cuid);
            }
            if (record.status === 'approved' && record.pid) {
                queueManager.enqueueCommentNotification('reply_notification', record.id, space.id, space.cuid);
            }
        } catch (notifyErr) {
            logger.warn('[comment] Failed to enqueue notification:', notifyErr.message);
        }

        return res.json({ errno: 0, errmsg: '', data: formatted });
    } catch (err) {
        if (err.errno === 1009) {
            return res.status(403).json({ errno: 1009, errmsg: err.message });
        }
        next(err);
    }
});

/**
 * PUT /comment/:spaceCuid/api/comment/:id
 * 更新评论
 */
router.put('/:spaceCuid/api/comment/:id', async (req, res, next) => {
    try {
        const space = req.commentSpace;

        // 点赞操作允许匿名用户，其他编辑操作需要登录
        const isLikeOnly = Object.keys(req.body).length === 1 && req.body.like !== undefined;
        if (!req.walineUser && !isLikeOnly) {
            return res.status(401).json({ errno: 1003, errmsg: '请先登录' });
        }
        if (!isLikeOnly && !hasWalineScope(req, 'comment:update')) {
            return walineScopeDenied(res);
        }

        const admin = isSpaceAdmin(req);
        const actingUserId = !isLikeOnly || hasWalineScope(req, 'comment:interact')
            ? req.walineUser?.userId
            : null;
        const updated = await updateComment(
            space.id,
            req.params.id,
            req.body,
            actingUserId,
            admin,
        );

        if (!updated) {
            return res.status(403).json({ errno: 1007, errmsg: '无权限或评论不存在' });
        }

        const spaceUser = req.walineUser?.userId
            ? await getSpaceUser(space.id, req.walineUser.userId)
            : null;
        const formatted = await formatComment(updated, {
            isAdmin: admin,
            spaceUser,
            zcUser: req.walineUser?.zcUser || null,
        });

        return res.json({ errno: 0, errmsg: '', data: formatted });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /comment/:spaceCuid/api/comment/:id
 * 删除评论
 */
router.delete('/:spaceCuid/api/comment/:id', async (req, res, next) => {
    try {
        const space = req.commentSpace;
        if (!req.walineUser) {
            return res.status(401).json({ errno: 1003, errmsg: '请先登录' });
        }
        if (!hasWalineScope(req, 'comment:delete')) {
            return walineScopeDenied(res);
        }

        const admin = isSpaceAdmin(req);
        const deleted = await deleteComment(
            space.id,
            req.params.id,
            req.walineUser.userId,
            admin,
        );

        if (!deleted) {
            return res.status(403).json({ errno: 1007, errmsg: '无权限或评论不存在' });
        }

        return res.json({ errno: 0, errmsg: '' });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// Token API (用户认证)
// ============================================================

/**
 * GET /comment/:spaceCuid/api/token
 * 获取当前用户信息
 */
router.get('/:spaceCuid/api/token', async (req, res, next) => {
    try {
        if (!req.walineUser) {
            return res.json({ errno: 0, data: {} });
        }

        const space = req.commentSpace;
        const spaceUser = req.walineSpaceUser;
        const zcUser = req.walineUser.zcUser;

        const mail = spaceUser?.email || zcUser?.email || '';
        const mailMd5 = mail
            ? crypto.createHash('md5').update(mail.trim().toLowerCase()).digest('hex')
            : '';

        // 拼接 avatar 完整 URL
        const staticUrl = await zcconfig.get('s3.staticurl');
        const rawAvatar = spaceUser?.avatar || zcUser?.avatar || '';
        const avatarUrl = rawAvatar ? `${staticUrl}/assets/${rawAvatar.substring(0, 2)}/${rawAvatar.substring(2, 4)}/${rawAvatar}.webp` : '';

        return res.json({
            errno: 0,
            data: {
                nick: spaceUser?.display_name || zcUser?.display_name || '',
                mail,
                link: spaceUser?.url || zcUser?.url || '',
                avatar: avatarUrl,
                type: toWalineType(spaceUser?.type),
                label: spaceUser?.label || zcUser?.label || '',
                objectId: String(req.walineUser.userId),
                mailMd5,
                username: zcUser?.username || '',
                display_name: zcUser?.display_name || '',
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /comment/:spaceCuid/api/token
 * 引导至 ZeroCat 登录 (返回登录URL)
 */
router.post('/:spaceCuid/api/token', async (req, res, next) => {
    try {
        const frontendUrl = await zcconfig.get('urls.frontend');
        return res.json({
            errno: 0,
            data: {
                url: `${frontendUrl}/app/commentservice/login?space=${req.commentSpace.cuid}`,
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /comment/:spaceCuid/api/token
 * 登出并吊销当前派生令牌
 */
router.delete('/:spaceCuid/api/token', async (req, res, next) => {
    try {
        if (req.walineToken) await revokeWalineToken(req.walineToken);
    } catch (err) {
        return next(err);
    }
    res.json({ errno: 0, errmsg: '' });
});

// ============================================================
// User API
// ============================================================

/**
 * GET /comment/:spaceCuid/api/user
 * 用户列表 (管理员)
 */
router.get('/:spaceCuid/api/user', async (req, res, next) => {
    try {
        if (!isSpaceAdmin(req)) {
            return res.status(401).json({ errno: 1003, errmsg: '无权限' });
        }

        const data = await listSpaceUsers(
            req.commentSpace.id,
            parseInt(req.query.page) || 1,
            parseInt(req.query.pageSize) || 20,
            { type: req.query.type || null, keyword: req.query.keyword || null },
        );

        const users = data.users.map(u => ({
            objectId: String(u.user_id),
            display_name: u.display_name || u.user?.display_name || '',
            email: u.email || '',
            url: u.url || '',
            avatar: u.avatar || u.user?.avatar || '',
            type: u.type,
            label: u.label || '',
        }));

        return res.json({
            errno: 0,
            data: {
                page: data.page,
                totalPages: data.totalPages,
                pageSize: data.pageSize,
                count: data.count,
                data: users,
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /comment/:spaceCuid/api/user
 * 更新自己的资料
 */
router.put('/:spaceCuid/api/user', async (req, res, next) => {
    try {
        if (!req.walineUser) {
            return res.status(401).json({ errno: 1003, errmsg: '请先登录' });
        }
        if (!hasWalineScope(req, 'comment:update')) {
            return walineScopeDenied(res);
        }

        const space = req.commentSpace;
        await assertCanWrite(Number(req.walineUser.userId), 'profile', 'update');
        const spaceUser = await getOrCreateSpaceUser(space.id, req.walineUser.userId, {
            display_name: req.walineUser.nick,
        });

        const updateData = {};
        if (req.body.display_name !== undefined) updateData.display_name = req.body.display_name;
        if (req.body.url !== undefined) updateData.url = req.body.url;
        if (req.body.avatar !== undefined) updateData.avatar = req.body.avatar;

        const updated = await updateSpaceUser(space.id, req.walineUser.userId, updateData);
        return res.json({ errno: 0, data: updated });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /comment/:spaceCuid/api/user/:id
 * 管理员: 更新用户
 */
router.put('/:spaceCuid/api/user/:id', async (req, res, next) => {
    try {
        if (!isSpaceAdmin(req)) {
            return res.status(401).json({ errno: 1003, errmsg: '无权限' });
        }

        const updated = await updateSpaceUser(
            req.commentSpace.id,
            parseInt(req.params.id),
            req.body,
        );
        return res.json({ errno: 0, data: updated });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /comment/:spaceCuid/api/user/:id
 * 管理员: 封禁用户 (设置type=banned)
 */
router.delete('/:spaceCuid/api/user/:id', async (req, res, next) => {
    try {
        if (!isSpaceAdmin(req)) {
            return res.status(401).json({ errno: 1003, errmsg: '无权限' });
        }

        await updateSpaceUser(
            req.commentSpace.id,
            parseInt(req.params.id),
            { type: 'banned' },
        );

        return res.json({ errno: 0, errmsg: '' });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// Article API (页面计数器)
// ============================================================

/**
 * GET /comment/:spaceCuid/api/article
 * 获取页面计数器
 */
router.get('/:spaceCuid/api/article', async (req, res, next) => {
    try {
        const urls = parseWalineListParam(req.query.path ?? req.query.url, { preserveEmpty: true });
        if (urls.length === 0) return res.json({ errno: 0, errmsg: '', data: 0 });

        const type = req.query.type || null;
        const data = await getArticleCounter(req.commentSpace.id, urls, type);
        return res.json({ errno: 0, errmsg: '', data });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /comment/:spaceCuid/api/article
 * 更新页面计数器
 */
router.post('/:spaceCuid/api/article', async (req, res, next) => {
    try {
        const [url] = parseWalineListParam(req.body.path ?? req.body.url ?? req.query.path ?? req.query.url, { preserveEmpty: true });
        if (!url) return res.status(400).json({ errno: 1004, errmsg: '缺少页面地址' });

        if (req.walineUser?.userId) await assertCanWrite(Number(req.walineUser.userId), 'comments', 'interact');
        const type = req.body.type || req.query.type || 'time';
        const action = req.body.action || req.query.action || 'inc';
        const { field, value } = await updateArticleCounter(req.commentSpace.id, url, type, action);
        return res.json({ errno: 0, errmsg: '', data: [{ [field]: value }] });
    } catch (err) {
        next(err);
    }
});

// ============================================================
// RSS
// ============================================================

/**
 * GET /comment/:spaceCuid/api/comment/rss
 * RSS 订阅 — 返回最近评论的标准 RSS 2.0
 * 可选 ?path=/xxx 按页面路径过滤
 */
router.get('/:spaceCuid/api/comment/rss', async (req, res, next) => {
    try {
        const space = req.commentSpace;
        const pathFilter = req.query.path || null;

        const where = { space_id: space.id, status: 'approved', AND: [await visibleWhere('comment_service')] };
        if (pathFilter) where.url = pathFilter;

        const comments = await prisma.ow_comment_service.findMany({
            where,
            orderBy: { insertedAt: 'desc' },
            take: 50,
        });

        // 构建 base link
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        const now = new Date().toUTCString();
        const lastBuild = comments.length > 0
            ? comments[0].insertedAt.toUTCString()
            : now;

        const escapeXml = (s) =>
            String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

        const items = comments.map(c => {
            const commentUrl = c.url || '/';
            const nick = c.nick || 'Anonymous';
            const renderedComment = renderMarkdown(c.comment);
            return `        <item>
            <title><![CDATA[${nick} commented on ${commentUrl}]]></title>
            <description><![CDATA[${renderedComment}]]></description>
            <link>${escapeXml(baseUrl)}/#${c.id}</link>
            <guid isPermaLink="false">${c.id}</guid>
            <pubDate>${c.insertedAt.toUTCString()}</pubDate>
        </item>`;
        }).join('\n');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
    <channel>
        <title><![CDATA[${space.name} Recent Comments]]></title>
        <description><![CDATA[Recent comments.]]></description>
        <link>${escapeXml(baseUrl)}</link>
        <generator>ZeroCat Comment Service</generator>
        <lastBuildDate>${lastBuild}</lastBuildDate>
        <pubDate>${lastBuild}</pubDate>
${items}
    </channel>
</rss>`;

        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        return res.send(xml);
    } catch (err) {
        next(err);
    }
});

// ============================================================
// UI 路由
// ============================================================

/**
 * GET /comment/:spaceCuid/ui/login
 * 重定向到 ZeroCat 前端登录
 */
router.get('/:spaceCuid/ui/login', async (req, res, next) => {
    try {
        const frontendUrl = await zcconfig.get('urls.frontend');
        return res.redirect(302, `${frontendUrl}/app/commentservice/login?space=${req.commentSpace.cuid}`);
    } catch (err) {
        next(err);
    }
});

export default router;
