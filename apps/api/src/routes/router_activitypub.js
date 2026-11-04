/**
 * ActivityPub 路由
 * 实现 WebFinger、NodeInfo、Actor、Inbox、Outbox 等 AP 端点
 */

import { Router } from 'express';
import express from 'express';
import logger from '../services/logger.js';
import { prisma } from '../services/prisma.js';
import zcconfig from '../services/config/zcconfig.js';
import { visibleWhere, canViewContent } from '../services/moderation/visibility.js';
import {
    AP_CONTENT_TYPE, AP_CONTEXT,
    getInstanceDomain, getInstanceBaseUrl, getApEndpointBaseUrl, getStaticUrl,
    isFederationEnabled, isApRequest,
    buildActorObject, getLocalUserByUsername,
    verifyInboxRequest,
    buildUserOutbox,
    countRemoteFollowers, getRemoteFollowers,
    buildOrderedCollection, buildOrderedCollectionPage,
    getNoteId, getNoteUrl, postToNote, getCardUrl,
    buildCreateActivity, getActorUrl,
    // 远程用户代理
    ensureProxyUser, resolveAndEnsureProxyUser, findProxyUserByActorUrl,
    listProxyUsers, searchProxyUsers, isRemoteProxyUser,
    getRemoteUserInfo, getProxyUserActorUrl,
    REMOTE_USER_TYPE,
    // 联邦实例配置
    getFederationConfig, setInstancePolicy,
    setAllowedInstances, setBlockedInstances,
    addAllowedInstance, removeAllowedInstance,
    addBlockedInstance, removeBlockedInstance,
    isInstanceAllowed, isRemoteSearchAllowed,
    // 远程帖子
    fetchRemoteUserPosts, getRemoteUserLocalPosts,
    // 远程搜索
    federatedUserSearch, parseFediAddress,
    // 关注同步
    getOutboundFollows,
} from '../services/activitypub/index.js';

const router = Router();

// ─── AP Body Parser：解析 activity+json / ld+json 并保留原始 body ───
router.use(express.json({
    type: [
        'application/activity+json',
        'application/ld+json',
        'application/json',
    ],
    limit: '1mb',
    verify: (req, _res, buf) => {
        // 保存原始 Buffer 用于 Digest / Signature 验证
        req.rawBody = buf;
    },
}));

// ─── 中间件：检查联邦是否启用 ──────────────────────────────

async function requireFederation(req, res, next) {
    const enabled = await isFederationEnabled();
    if (!enabled) {
        return res.status(404).json({
            error: 'ActivityPub federation is not enabled on this instance',
        });
    }
    next();
}

// ─── host-meta ──────────────────────────────────────────────

router.get('/host-meta', async (req, res) => {
    try {
        const baseUrl = await getInstanceBaseUrl();
        res.set('Content-Type', 'application/xrd+xml; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        return res.send(
            `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n` +
            `  <Link rel="lrdd" template="${baseUrl}/.well-known/webfinger?resource={uri}"/>\n` +
            `</XRD>`
        );
    } catch (err) {
        logger.error('[ap-route] host-meta 错误:', err);
        res.status(500).send('Internal server error');
    }
});

// ─── WebFinger ──────────────────────────────────────────────

router.get('/webfinger', async (req, res) => {
    try {
        const resource = req.query.resource;
        if (!resource) {
            return res.status(400).json({ error: 'Missing resource parameter' });
        }

        // 解析 acct:username@domain 格式
        const acctMatch = resource.match(/^acct:([^@]+)@(.+)$/);
        if (!acctMatch) {
            return res.status(400).json({ error: 'Invalid resource format. Expected acct:user@domain' });
        }

        const [, username, domain] = acctMatch;
        const instanceDomain = await getInstanceDomain();

        // 只处理本实例的请求
        if (domain !== instanceDomain) {
            return res.status(404).json({ error: 'User not found on this instance' });
        }

        // 查找用户
        const user = await getLocalUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const baseUrl = await getInstanceBaseUrl();
        const apBaseUrl = await getApEndpointBaseUrl();

        res.set('Content-Type', 'application/jrd+json; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        return res.json({
            subject: `acct:${user.username}@${instanceDomain}`,
            aliases: [
                `${apBaseUrl}/ap/users/${user.username}`,
                `${baseUrl}/${user.username}`,
            ],
            links: [
                {
                    rel: 'self',
                    type: 'application/activity+json',
                    href: `${apBaseUrl}/ap/users/${user.username}`,
                },
                {
                    rel: 'http://webfinger.net/rel/profile-page',
                    type: 'text/html',
                    href: `${baseUrl}/${user.username}`,
                },
            ],
        });
    } catch (err) {
        logger.error('[ap-route] WebFinger 错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── NodeInfo ───────────────────────────────────────────────

router.get('/nodeinfo', async (req, res) => {
    try {
        const apBaseUrl = await getApEndpointBaseUrl();
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        return res.json({
            links: [
                {
                    rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
                    href: `${apBaseUrl}/ap/nodeinfo/2.0`,
                },
            ],
        });
    } catch (err) {
        logger.error('[ap-route] NodeInfo 链接错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/nodeinfo/2.0', async (req, res) => {
    try {
        const [userCount, postCount, adminUser] = await Promise.all([
            prisma.ow_users.count({ where: { status: 'active', AND: [await visibleWhere('profile')] } }),
            prisma.ow_posts.count({ where: { is_deleted: false, AND: [await visibleWhere('post')] } }),
            prisma.ow_users.findUnique({
                where: { id: 1 },
                select: { id: true, username: true, display_name: true, email: true },
            }),
        ]);

        const apBaseUrl = await getApEndpointBaseUrl();

        const metadata = {
            "nodeName": "ZeroCat 零猫社区",
            "nodeDescription": "新一代开源编程社区。https://zerocat.dev",
            "nodeAdmins": [
                {
                    "name": adminUser.username,
                    "email": adminUser.email
                }
            ],
            "maintainer": {
                "name": adminUser.username,
                "email": adminUser.email
            },
            "tosUrl": "",
            "privacyPolicyUrl": "",
            "inquiryUrl": "https://zerocat.dev",
        };

        if (adminUser) {
            metadata.admin = adminUser.username;
            metadata.adminContact = adminUser.email || null;
            metadata.contact = {
                account: {
                    id: String(adminUser.id),
                    username: adminUser.username,
                    display_name: adminUser.display_name || adminUser.username,
                    url: `${apBaseUrl}/ap/users/${adminUser.username}`,
                },
                email: adminUser.email || null,
            };
        }
        metadata.repositoryUrl = "https://github.com/Moonrend/ZeroCat"
        metadata.feedbackUrl = "https://github.com/Moonrend/ZeroCat/issues/new"
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        return res.json({
            version: '2.0',
            software: {
                name: 'zerocat',
                version: '1.0.0',
                "homepage": "https://github.com/Moonrend/ZeroCat",

            },
            protocols: ['activitypub'],
            usage: {
                users: {
                    total: userCount,
                    activeMonth: userCount, // 简化处理
                    activeHalfyear: userCount,
                },
                localPosts: postCount,
            },
            openRegistrations: true,
            services: {
                inbound: [],
                outbound: [],
            },
            metadata,
        });
    } catch (err) {
        logger.error('[ap-route] NodeInfo 2.0 错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Actor Profile ──────────────────────────────────────────

router.get('/users/:username', requireFederation, async (req, res) => {
    try {
        const { username } = req.params;

        // 检查 Accept 头 - 只在 AP 请求时返回 JSON-LD
        if (!isApRequest(req)) {
            // 非 AP 请求重定向到前端用户页面
            const baseUrl = await getInstanceBaseUrl();
            return res.redirect(`${baseUrl}/${username}`);
        }

        const user = await getLocalUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const actor = await buildActorObject(user);

        res.set('Content-Type', AP_CONTENT_TYPE);
        res.set('Cache-Control', 'no-store');
        return res.json(actor);
    } catch (err) {
        logger.error('[ap-route] Actor 错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── User Inbox (POST) ─────────────────────────────────────

router.post('/users/:username/inbox', requireFederation, async (req, res) => {
    try {
        const { username } = req.params;

        // 验证目标用户存在
        const user = await getLocalUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // 验证 HTTP Signature
        const verification = await verifyInboxRequest(req);
        if (!verification.valid) {
            logger.warn(`[ap-route] 收件箱签名验证失败 ${username}: ${verification.message}`);
            // 在开发环境可以放宽验证
            if (process.env.NODE_ENV === 'production') {
                return res.status(401).json({ error: verification.message });
            }
            logger.warn('[ap-route] 在没有有效签名的情况下继续(非生产环境)');
        }

        const activity = req.body;
        if (!activity || !activity.type) {
            return res.status(400).json({ error: 'Invalid activity' });
        }

        // 获取远程 Actor
        const remoteActor = verification.actor || await (async () => {
            const { fetchRemoteActor } = await import('../services/activitypub/federation.js');
            const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
            return actorUrl ? fetchRemoteActor(actorUrl) : null;
        })();

        if (!remoteActor) {
            return res.status(400).json({ error: 'Could not resolve actor' });
        }

        // 处理活动 — 加入队列异步处理
        const { default: queueManager } = await import('../services/queue/queueManager.js');
        const result = await queueManager.enqueueApInbox(activity, remoteActor, username);

        // ActivityPub 规范要求收件箱返回 202 Accepted
        return res.status(202).json({ status: 'accepted', ...result });
    } catch (err) {
        logger.error('[ap-route] 收件箱错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Shared Inbox (POST) ────────────────────────────────────

router.post('/inbox', requireFederation, async (req, res) => {
    try {
        // 验证 HTTP Signature
        const verification = await verifyInboxRequest(req);
        if (!verification.valid && process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: verification.message });
        }

        const activity = req.body;
        if (!activity || !activity.type) {
            return res.status(400).json({ error: 'Invalid activity' });
        }

        const remoteActor = verification.actor || await (async () => {
            const { fetchRemoteActor } = await import('../services/activitypub/federation.js');
            const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
            return actorUrl ? fetchRemoteActor(actorUrl) : null;
        })();

        if (!remoteActor) {
            return res.status(400).json({ error: 'Could not resolve actor' });
        }

        // 共享收件箱 — 加入队列异步处理
        const { default: queueManager } = await import('../services/queue/queueManager.js');
        const result = await queueManager.enqueueApInbox(activity, remoteActor, null);

        return res.status(202).json({ status: 'accepted', ...result });
    } catch (err) {
        logger.error('[ap-route] 共享收件箱错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── User Outbox (GET) ──────────────────────────────────────

router.get('/users/:username/outbox', requireFederation, async (req, res) => {
    try {
        const { username } = req.params;
        const page = parseInt(req.query.page) || 0;

        const outbox = await buildUserOutbox(username, page);
        if (!outbox) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.set('Content-Type', AP_CONTENT_TYPE);
        res.set('Cache-Control', 'no-store');
        return res.json(outbox);
    } catch (err) {
        logger.error('[ap-route] 发件箱错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Followers Collection ───────────────────────────────────

router.get('/users/:username/followers', requireFederation, async (req, res) => {
    try {
        const { username } = req.params;
        const apBaseUrl = await getApEndpointBaseUrl();
        const followersUrl = `${apBaseUrl}/ap/users/${username}/followers`;
        const page = parseInt(req.query.page) || 0;

        const user = await getLocalUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // 统计本地关注者
        const localFollowerCount = await prisma.ow_user_relationships.count({
            where: {
                target_user_id: user.id,
                relationship_type: 'follow',
                AND: [await visibleWhere('relation'), { source_user: await visibleWhere('profile') }],
            },
        });

        // 统计远程关注者
        const remoteFollowerCount = await countRemoteFollowers(user.id);
        const totalItems = localFollowerCount + remoteFollowerCount;

        if (page === 0) {
            res.set('Content-Type', AP_CONTENT_TYPE);
            return res.json(buildOrderedCollection(
                followersUrl,
                totalItems,
                `${followersUrl}?page=1`,
            ));
        }

        // 获取关注者列表（AP 规范通常只返回 URL）
        const pageSize = 20;

        // 获取本地关注者
        const localFollowers = await prisma.ow_user_relationships.findMany({
            where: {
                target_user_id: user.id,
                relationship_type: 'follow',
                AND: [await visibleWhere('relation'), { source_user: await visibleWhere('profile') }],
            },
            include: {
                source_user: { select: { username: true } },
            },
            take: pageSize,
            skip: (page - 1) * pageSize,
        });

        const items = localFollowers
            .filter(f => f.source_user)
            .map(f => `${apBaseUrl}/ap/users/${f.source_user.username}`);

        // 如果本地关注者不足一页，补充远程关注者
        if (items.length < pageSize) {
            const remoteOffset = Math.max(0, (page - 1) * pageSize - localFollowerCount);
            const remoteFollowers = await getRemoteFollowers(
                user.id,
                pageSize - items.length,
                remoteOffset,
            );
            items.push(...remoteFollowers.map(f => f.actorUrl));
        }

        const hasMore = items.length === pageSize;
        const nextPage = hasMore ? `${followersUrl}?page=${page + 1}` : null;
        const prevPage = page > 1 ? `${followersUrl}?page=${page - 1}` : null;

        res.set('Content-Type', AP_CONTENT_TYPE);
        return res.json(buildOrderedCollectionPage(
            `${followersUrl}?page=${page}`,
            followersUrl,
            items,
            nextPage,
            prevPage,
        ));
    } catch (err) {
        logger.error('[ap-route] 关注者錯误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Following Collection ───────────────────────────────────

router.get('/users/:username/following', requireFederation, async (req, res) => {
    try {
        const { username } = req.params;
        const apBaseUrl = await getApEndpointBaseUrl();
        const followingUrl = `${apBaseUrl}/ap/users/${username}/following`;
        const page = parseInt(req.query.page) || 0;

        const user = await getLocalUserByUsername(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const totalItems = await prisma.ow_user_relationships.count({
            where: {
                source_user_id: user.id,
                relationship_type: 'follow',
                AND: [await visibleWhere('relation'), { target_user: await visibleWhere('profile') }],
            },
        });

        if (page === 0) {
            res.set('Content-Type', AP_CONTENT_TYPE);
            return res.json(buildOrderedCollection(
                followingUrl,
                totalItems,
                `${followingUrl}?page=1`,
            ));
        }

        const pageSize = 20;
        const following = await prisma.ow_user_relationships.findMany({
            where: {
                source_user_id: user.id,
                relationship_type: 'follow',
                AND: [await visibleWhere('relation'), { target_user: await visibleWhere('profile') }],
            },
            include: {
                target_user: { select: { username: true } },
            },
            take: pageSize,
            skip: (page - 1) * pageSize,
        });

        const items = following
            .filter(f => f.target_user)
            .map(f => `${apBaseUrl}/ap/users/${f.target_user.username}`);

        const hasMore = items.length === pageSize;
        const nextPage = hasMore ? `${followingUrl}?page=${page + 1}` : null;
        const prevPage = page > 1 ? `${followingUrl}?page=${page - 1}` : null;

        res.set('Content-Type', AP_CONTENT_TYPE);
        return res.json(buildOrderedCollectionPage(
            `${followingUrl}?page=${page}`,
            followingUrl,
            items,
            nextPage,
            prevPage,
        ));
    } catch (err) {
        logger.error('[ap-route] 正在关注错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Note Object (GET) ─────────────────────────────────────

router.get('/notes/:postId', async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) {
            return res.status(400).json({ error: 'Invalid post ID' });
        }

        const post = await prisma.ow_posts.findUnique({
            where: { id: postId },
            include: {
                author: { select: { id: true, username: true, display_name: true } },
            },
        });

        if (!post || post.is_deleted || !await canViewContent('post', post, null)) {
            // AP 规范要求返回 Tombstone
            if (isApRequest(req)) {
                res.set('Content-Type', AP_CONTENT_TYPE);
                return res.status(410).json({
                    '@context': AP_CONTEXT,
                    id: await getNoteId(postId),
                    type: 'Tombstone',
                    formerType: 'Note',
                });
            }
            return res.status(404).json({ error: 'Post not found' });
        }

        if (!isApRequest(req)) {
            // 非 AP 请求重定向到前端帖子页面
            const baseUrl = await getInstanceBaseUrl();
            return res.redirect(`${baseUrl}/app/posts/${postId}`);
        }

        const note = await postToNote(post);
        if (!note) {
            return res.status(500).json({ error: 'Could not serialize post' });
        }

        res.set('Content-Type', AP_CONTENT_TYPE);
        res.set('Cache-Control', 'no-store');
        return res.json(note);
    } catch (err) {
        logger.error('[ap-route] 笔记错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Activity Object (GET) ──────────────────────────────────

router.get('/activities/:activityId', requireFederation, async (req, res) => {
    try {
        const { getActivity } = await import('../services/activitypub/store.js');
        const activity = await getActivity(req.params.activityId);

        if (!activity) {
            return res.status(404).json({ error: 'Activity not found' });
        }

        res.set('Content-Type', AP_CONTENT_TYPE);
        return res.json(activity);
    } catch (err) {
        logger.error('[ap-route] 活动错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── AP 管理接口 ─────────────────────────────────────────────

router.get('/status', async (req, res) => {
    try {
        const { getActivityPubStatus } = await import('../services/activitypub/setup.js');
        const status = await getActivityPubStatus();
        return res.json(status);
    } catch (err) {
        logger.error('[ap-route] 状态错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 初始化/配置 ActivityPub (需要管理员权限)
 * POST /ap/admin/setup
 * Body: { domain?, name?, description?, enabled?, autoAcceptFollows? }
 */
router.post('/admin/setup', async (req, res) => {
    try {
        // 验证管理员权限
        if (!res.locals.userid) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const zcconfig = (await import('../services/config/zcconfig.js')).default;
        const adminUsers = await zcconfig.get('security.adminusers');
        if (!adminUsers?.includes(String(res.locals.userid))) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { initializeActivityPub } = await import('../services/activitypub/setup.js');
        const result = await initializeActivityPub(req.body);

        return res.json({ status: 'ok', ...result });
    } catch (err) {
        logger.error('[ap-route] 设置错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 切换联邦启用状态 (需要管理员权限)
 * PATCH /ap/admin/federation
 * Body: { enabled: boolean }
 */
router.patch('/admin/federation', async (req, res) => {
    try {
        if (!res.locals.userid) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const zcconfig = (await import('../services/config/zcconfig.js')).default;
        const adminUsers = await zcconfig.get('security.adminusers');
        if (!adminUsers?.includes(String(res.locals.userid))) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { setFederationEnabled } = await import('../services/activitypub/setup.js');
        await setFederationEnabled(Boolean(req.body.enabled));

        return res.json({ status: 'ok', enabled: Boolean(req.body.enabled) });
    } catch (err) {
        logger.error('[ap-route] 联邐切换错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 用户的远程关注者统计
 * GET /ap/users/:username/remote-followers/count
 */
router.get('/users/:username/remote-followers/count', async (req, res) => {
    try {
        const user = await getLocalUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const count = await countRemoteFollowers(user.id);
        return res.json({ username: req.params.username, remoteFollowers: count });
    } catch (err) {
        logger.error('[ap-route] 远程关注者计数错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── 管理员验证中间件 ─────────────────────────────────────────

async function requireAdmin(req, res, next) {
    if (!res.locals.userid) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const adminUsers = await zcconfig.get('security.adminusers');
    if (!adminUsers?.includes(String(res.locals.userid))) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ═══════════════════════════════════════════════════════════════
// 联邦实例配置管理 (白名单/黑名单)
// ═══════════════════════════════════════════════════════════════

/**
 * 获取联邦实例配置
 * GET /ap/admin/federation/config
 */
router.get('/admin/federation/config', requireAdmin, async (req, res) => {
    try {
        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 获取联邦配置错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 更新联邦实例策略
 * PATCH /ap/admin/federation/config
 * Body: { policy?, allowedInstances?, blockedInstances?, autoFetchPosts?, maxFetchPosts?, allowRemoteSearch? }
 */
router.patch('/admin/federation/config', requireAdmin, async (req, res) => {
    try {
        const { policy, allowedInstances, blockedInstances, autoFetchPosts, maxFetchPosts, allowRemoteSearch } = req.body;

        if (policy) {
            if (!['open', 'allowlist', 'blocklist'].includes(policy)) {
                return res.status(400).json({ error: 'Invalid policy. Must be: open, allowlist, or blocklist' });
            }
            await setInstancePolicy(policy);
        }
        if (allowedInstances !== undefined) {
            await setAllowedInstances(Array.isArray(allowedInstances) ? allowedInstances : []);
        }
        if (blockedInstances !== undefined) {
            await setBlockedInstances(Array.isArray(blockedInstances) ? blockedInstances : []);
        }
        if (autoFetchPosts !== undefined) {
            await zcconfig.set('ap.federation.auto_fetch_posts', Boolean(autoFetchPosts));
        }
        if (maxFetchPosts !== undefined) {
            await zcconfig.set('ap.federation.max_fetch_posts', Number(maxFetchPosts) || 50);
        }
        if (allowRemoteSearch !== undefined) {
            await zcconfig.set('ap.federation.allow_remote_search', Boolean(allowRemoteSearch));
        }

        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 更新联邦配置错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 添加允许的实例
 * POST /ap/admin/federation/allowlist
 * Body: { domain: string }
 */
router.post('/admin/federation/allowlist', requireAdmin, async (req, res) => {
    try {
        const { domain } = req.body;
        if (!domain || typeof domain !== 'string') {
            return res.status(400).json({ error: 'domain is required' });
        }
        await addAllowedInstance(domain.trim().toLowerCase());
        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 添加允许实例错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 移除允许的实例
 * DELETE /ap/admin/federation/allowlist/:domain
 */
router.delete('/admin/federation/allowlist/:domain', requireAdmin, async (req, res) => {
    try {
        await removeAllowedInstance(req.params.domain);
        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 移除允许实例错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 添加封禁的实例
 * POST /ap/admin/federation/blocklist
 * Body: { domain: string }
 */
router.post('/admin/federation/blocklist', requireAdmin, async (req, res) => {
    try {
        const { domain } = req.body;
        if (!domain || typeof domain !== 'string') {
            return res.status(400).json({ error: 'domain is required' });
        }
        await addBlockedInstance(domain.trim().toLowerCase());
        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 添加封禁实例错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 移除封禁的实例
 * DELETE /ap/admin/federation/blocklist/:domain
 */
router.delete('/admin/federation/blocklist/:domain', requireAdmin, async (req, res) => {
    try {
        await removeBlockedInstance(req.params.domain);
        const config = await getFederationConfig();
        return res.json({ status: 'ok', data: config });
    } catch (err) {
        logger.error('[ap-route] 移除封禁实例错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 联邦管理 — 统计、用户、帖子、队列、手动同步
// ═══════════════════════════════════════════════════════════════

/**
 * 联邦综合统计概览
 * GET /ap/admin/federation/stats
 */
router.get('/admin/federation/stats', requireAdmin, async (req, res) => {
    try {
        // 基础统计
        const [configGroups, totalLocalPosts] = await Promise.all([
            prisma.ow_target_configs.groupBy({
                by: ['target_type'],
                where: { target_type: { in: ['ap_follow', 'ap_actor', 'ap_delivery'] } },
                _count: { _all: true },
            }),
            prisma.ow_posts.count({ where: { is_deleted: false, AND: [await visibleWhere('post')] } }),
        ]);
        const configCounts = new Map(configGroups.map(row => [row.target_type, row._count._all]));
        const totalRemoteFollowers = configCounts.get('ap_follow') || 0;
        const totalProxyUsers = configCounts.get('ap_actor') || 0;
        const totalDeliveryRecords = configCounts.get('ap_delivery') || 0;

        // 外部平台同步统计
        const platformStats = await prisma.$queryRaw`
            SELECT
                COUNT(*) AS federated_posts,
                COUNT(*) FILTER (WHERE platform_refs::jsonb ? 'twitter') AS twitter_synced,
                COUNT(*) FILTER (WHERE platform_refs::jsonb ? 'bluesky') AS bluesky_synced,
                COUNT(*) FILTER (WHERE platform_refs::jsonb ? 'activitypub') AS activitypub_synced
            FROM ow_posts
            WHERE is_deleted = false AND platform_refs IS NOT NULL
        `;

        // 队列状态
        let queueStats = null;
        try {
            const { getApFederationQueue } = await import('../services/queue/queues.js');
            const queue = getApFederationQueue();
            if (queue) {
                const [waiting, active, completed, failed, delayed] = await Promise.all([
                    queue.getWaitingCount(),
                    queue.getActiveCount(),
                    queue.getCompletedCount(),
                    queue.getFailedCount(),
                    queue.getDelayedCount(),
                ]);
                queueStats = { waiting, active, completed, failed, delayed };
            }
        } catch { /* queue not available */ }

        const { getActivityPubStatus } = await import('../services/activitypub/setup.js');
        const apStatus = await getActivityPubStatus();

        return res.json({
            status: 'ok',
            data: {
                federation: apStatus,
                counts: {
                    remoteFollowers: totalRemoteFollowers,
                    proxyUsers: totalProxyUsers,
                    federatedPosts: Number(platformStats?.[0]?.federated_posts || 0),
                    localPosts: totalLocalPosts,
                    deliveryRecords: totalDeliveryRecords,
                },
                platformSync: platformStats?.[0] ? {
                    twitter: Number(platformStats[0].twitter_synced || 0),
                    bluesky: Number(platformStats[0].bluesky_synced || 0),
                    activitypub: Number(platformStats[0].activitypub_synced || 0),
                } : null,
                queue: queueStats,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 联邦统计错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 列出所有有远程关注者的本地用户
 * GET /ap/admin/federation/users?page=1&limit=20
 */
router.get('/admin/federation/users', requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;

        // 查找有远程关注者的本地用户
        const followRecords = await prisma.ow_target_configs.groupBy({
            by: ['target_id'],
            where: { target_type: 'ap_follow' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            skip,
            take: limit,
        });

        const userIds = followRecords.map(r => Number(r.target_id)).filter(id => !isNaN(id));
        const users = userIds.length > 0 ? await prisma.ow_users.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, display_name: true, avatar: true, status: true },
        }) : [];

        const userMap = Object.fromEntries(users.map(u => [u.id, u]));
        const result = followRecords.map(r => ({
            user: userMap[Number(r.target_id)] || { id: Number(r.target_id) },
            remoteFollowersCount: r._count.id,
        }));

        const total = await prisma.ow_target_configs.groupBy({
            by: ['target_id'],
            where: { target_type: 'ap_follow' },
        }).then(g => g.length);

        return res.json({ status: 'ok', data: { users: result, total, page, limit } });
    } catch (err) {
        logger.error('[ap-route] 联邦用户列表错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 查看某用户的远程关注者详情
 * GET /ap/admin/federation/users/:userId/followers?page=1&limit=50
 */
router.get('/admin/federation/users/:userId/followers', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = (page - 1) * limit;

        const followers = await getRemoteFollowers(userId, limit, offset);
        const count = await countRemoteFollowers(userId);

        return res.json({
            status: 'ok',
            data: {
                userId,
                followers: followers.map(f => {
                    try { return { actorUrl: f.actorUrl, inbox: f.inbox, ...JSON.parse(f.value || '{}') }; }
                    catch { return { actorUrl: f.actorUrl, inbox: f.inbox }; }
                }),
                total: count,
                page,
                limit,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 用户远程关注者错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 查看远程代理用户列表（管理员版）
 * GET /ap/admin/federation/proxy-users?page=1&limit=20&q=keyword
 */
router.get('/admin/federation/proxy-users', requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;
        const keyword = req.query.q || '';

        let result;
        if (keyword) {
            result = await searchProxyUsers(keyword, limit);
        } else {
            result = await listProxyUsers(limit, skip);
        }

        return res.json({
            status: 'ok',
            data: {
                users: result.users,
                total: result.total,
                page,
                limit,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 管理员代理用户列表错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 查看帖子的完整同步状态
 * GET /ap/admin/federation/posts/:postId/sync-status
 */
router.get('/admin/federation/posts/:postId/sync-status', requireAdmin, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });

        const post = await prisma.ow_posts.findUnique({
            where: { id: postId },
            select: {
                id: true, author_id: true, post_type: true, content: true,
                platform_refs: true, created_at: true, is_deleted: true,
                author: { select: { id: true, username: true, display_name: true } },
            },
        });

        if (!post) return res.status(404).json({ error: 'Post not found' });

        const refs = post.platform_refs || {};

        // 获取 AP 投递记录
        let deliveryRecords = [];
        if (refs.activitypub?.id) {
            const { getDeliveryRecords } = await import('../services/activitypub/store.js');
            deliveryRecords = await getDeliveryRecords(refs.activitypub.id);
        }

        return res.json({
            status: 'ok',
            data: {
                post: {
                    id: post.id,
                    authorId: post.author_id,
                    author: post.author,
                    postType: post.post_type,
                    content: post.content?.substring(0, 300),
                    createdAt: post.created_at,
                    isDeleted: post.is_deleted,
                },
                sync: {
                    twitter: refs.twitter || null,
                    bluesky: refs.bluesky || null,
                    activitypub: refs.activitypub || null,
                },
                delivery: {
                    total: deliveryRecords.length,
                    records: deliveryRecords.slice(0, 50),
                },
            },
        });
    } catch (err) {
        logger.error('[ap-route] 帖子同步状态错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 列出已同步的帖子
 * GET /ap/admin/federation/posts?page=1&limit=20&platform=activitypub|twitter|bluesky
 */
router.get('/admin/federation/posts', requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;
        const platform = req.query.platform;

        let platformFilter = { platform_refs: { not: null } };
        // Prisma JSON 路径过滤
        if (platform === 'twitter') {
            platformFilter = { platform_refs: { path: ['twitter'], not: null } };
        } else if (platform === 'bluesky') {
            platformFilter = { platform_refs: { path: ['bluesky'], not: null } };
        } else if (platform === 'activitypub') {
            platformFilter = { platform_refs: { path: ['activitypub'], not: null } };
        }

        const [posts, total] = await Promise.all([
            prisma.ow_posts.findMany({
                where: { is_deleted: false, ...platformFilter },
                select: {
                    id: true, author_id: true, post_type: true, content: true,
                    platform_refs: true, created_at: true,
                    author: { select: { id: true, username: true, display_name: true } },
                },
                orderBy: { created_at: 'desc' },
                skip,
                take: limit,
            }),
            prisma.ow_posts.count({ where: { is_deleted: false, ...platformFilter } }),
        ]);

        return res.json({
            status: 'ok',
            data: {
                posts: posts.map(p => ({
                    id: p.id,
                    authorId: p.author_id,
                    author: p.author,
                    postType: p.post_type,
                    content: p.content?.substring(0, 200),
                    createdAt: p.created_at,
                    sync: {
                        twitter: p.platform_refs?.twitter || null,
                        bluesky: p.platform_refs?.bluesky || null,
                        activitypub: p.platform_refs?.activitypub || null,
                    },
                })),
                total,
                page,
                limit,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 联邦帖子列表错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 管理员手动触发帖子重新推送到所有平台
 * POST /ap/admin/federation/posts/:postId/resync
 * Body: { platforms?: ['activitypub','twitter','bluesky'] }
 */
router.post('/admin/federation/posts/:postId/resync', requireAdmin, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });

        const post = await prisma.ow_posts.findUnique({
            where: { id: postId },
            select: { id: true, author_id: true, is_deleted: true },
        });
        if (!post || post.is_deleted || !await canViewContent('post', post, null)) return res.status(404).json({ error: 'Post not found' });

        const results = {};

        // 社交平台同步（包含 Twitter/Bluesky/AP）
        const { default: queueManager } = await import('../services/queue/queueManager.js');
        const syncResult = await queueManager.enqueueSocialPostSync(
            post.author_id, postId, 'create'
        );
        results.socialSync = syncResult;

        return res.json({ status: 'ok', data: { postId, results } });
    } catch (err) {
        logger.error('[ap-route] 帖子重新推送错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 管理员手动触发帖子推送到 AP 关注者
 * POST /ap/admin/federation/posts/:postId/push-ap
 */
router.post('/admin/federation/posts/:postId/push-ap', requireAdmin, async (req, res) => {
    try {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) return res.status(400).json({ error: 'Invalid post ID' });

        const post = await prisma.ow_posts.findUnique({
            where: { id: postId },
            include: { author: { select: { id: true, username: true, display_name: true } } },
        });
        if (!post || post.is_deleted || !await canViewContent('post', post, null)) return res.status(404).json({ error: 'Post not found' });

        const { postToNote, buildCreateActivity, getActorUrl, setPostApRef } = await import('../services/activitypub/index.js');
        const note = await postToNote(post);
        if (!note) return res.status(400).json({ error: 'Cannot build AP Note for this post' });

        await setPostApRef(postId, note.id, note.url);
        const actorUrl = await getActorUrl(post.author.username);
        const activity = await buildCreateActivity(actorUrl, note);

        const { default: queueManager } = await import('../services/queue/queueManager.js');
        const result = await queueManager.enqueueApDeliverFollowers(post.author_id, activity);

        return res.json({ status: 'ok', data: { postId, noteId: note.id, delivery: result } });
    } catch (err) {
        logger.error('[ap-route] AP 推送错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 管理员手动触发远程用户帖子拉取
 * POST /ap/admin/federation/proxy-users/:userId/fetch-posts
 * Body: { maxPosts?: number }
 */
router.post('/admin/federation/proxy-users/:userId/fetch-posts', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const isRemote = await isRemoteProxyUser(userId);
        if (!isRemote) return res.status(404).json({ error: 'Not a remote proxy user' });

        const actorUrl = await getProxyUserActorUrl(userId);
        if (!actorUrl) return res.status(404).json({ error: 'Actor URL not found' });

        const maxPosts = Math.min(parseInt(req.body.maxPosts) || 50, 200);

        const { default: queueManager } = await import('../services/queue/queueManager.js');
        const result = await queueManager.enqueueApFetchPosts(actorUrl, maxPosts);

        return res.json({ status: 'ok', data: { userId, actorUrl, maxPosts, queued: result } });
    } catch (err) {
        logger.error('[ap-route] 管理员拉取远程帖子错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 管理员手动触发远程用户资料刷新
 * POST /ap/admin/federation/proxy-users/:userId/refresh
 */
router.post('/admin/federation/proxy-users/:userId/refresh', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const isRemote = await isRemoteProxyUser(userId);
        if (!isRemote) return res.status(404).json({ error: 'Not a remote proxy user' });

        const actorUrl = await getProxyUserActorUrl(userId);
        if (!actorUrl) return res.status(404).json({ error: 'Actor URL not found' });

        // 强制刷新远程 Actor（跳过缓存）
        const { fetchRemoteActor } = await import('../services/activitypub/federation.js');
        const actor = await fetchRemoteActor(actorUrl, true);
        if (!actor) return res.status(502).json({ error: 'Could not fetch remote actor' });

        // 更新代理用户信息
        const { ensureProxyUser: refreshProxy } = await import('../services/activitypub/remoteUser.js');
        const proxyUser = await refreshProxy(actorUrl, actor);

        return res.json({ status: 'ok', data: { userId, actorUrl, refreshed: !!proxyUser } });
    } catch (err) {
        logger.error('[ap-route] 管理员刷新远程用户错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 管理员向指定用户的所有远程关注者触发历史帖子回填
 * POST /ap/admin/federation/users/:userId/backfill
 */
router.post('/admin/federation/users/:userId/backfill', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const user = await prisma.ow_users.findUnique({
            where: { id: userId },
            select: { id: true, username: true },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const followers = await getRemoteFollowers(userId, 500, 0);
        if (followers.length === 0) {
            return res.json({ status: 'ok', data: { userId, jobs: 0, message: 'No remote followers' } });
        }

        const { default: queueManager } = await import('../services/queue/queueManager.js');
        let queued = 0;
        for (const follower of followers) {
            const result = await queueManager.enqueueApBackfill(userId, follower.actorUrl);
            if (result) queued++;
        }

        return res.json({ status: 'ok', data: { userId, username: user.username, jobs: queued, followers: followers.length } });
    } catch (err) {
        logger.error('[ap-route] 管理员回填错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * AP 联邦队列状态和管理
 * GET /ap/admin/federation/queue
 */
router.get('/admin/federation/queue', requireAdmin, async (req, res) => {
    try {
        const { getApFederationQueue } = await import('../services/queue/queues.js');
        const { getSocialSyncQueue } = await import('../services/queue/queues.js');
        const apQueue = getApFederationQueue();
        const socialQueue = getSocialSyncQueue();

        const getQueueInfo = async (queue, name) => {
            if (!queue) return { name, available: false };
            const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
                queue.getWaitingCount(),
                queue.getActiveCount(),
                queue.getCompletedCount(),
                queue.getFailedCount(),
                queue.getDelayedCount(),
                queue.isPaused(),
            ]);
            return { name, available: true, paused, waiting, active, completed, failed, delayed };
        };

        const [apInfo, socialInfo] = await Promise.all([
            getQueueInfo(apQueue, 'ap-federation'),
            getQueueInfo(socialQueue, 'social-sync'),
        ]);

        return res.json({ status: 'ok', data: { queues: [apInfo, socialInfo] } });
    } catch (err) {
        logger.error('[ap-route] 队列状态错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 暂停/恢复 AP 联邦队列
 * POST /ap/admin/federation/queue/pause
 * POST /ap/admin/federation/queue/resume
 */
router.post('/admin/federation/queue/:action', requireAdmin, async (req, res) => {
    try {
        const { action } = req.params;
        if (!['pause', 'resume'].includes(action)) {
            return res.status(400).json({ error: 'Action must be pause or resume' });
        }

        const { getApFederationQueue } = await import('../services/queue/queues.js');
        const queue = getApFederationQueue();
        if (!queue) return res.status(503).json({ error: 'AP federation queue not available' });

        if (action === 'pause') {
            await queue.pause();
        } else {
            await queue.resume();
        }

        return res.json({ status: 'ok', data: { action, paused: await queue.isPaused() } });
    } catch (err) {
        logger.error('[ap-route] 队列操作错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 远程用户代理端点
// ═══════════════════════════════════════════════════════════════

/**
 * 搜索/解析远程用户（支持 @user@domain 格式）
 * GET /ap/remote/users/search?q=@user@domain
 */
router.get('/remote/users/search', requireFederation, async (req, res) => {
    try {
        const keyword = req.query.q || req.query.keyword || '';
        if (!keyword) {
            return res.status(400).json({ error: 'Search query (q) is required' });
        }

        // 检查是否允许远程搜索
        const allowed = await isRemoteSearchAllowed();
        if (!allowed) {
            return res.status(403).json({ error: 'Remote user search is disabled on this instance' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const result = await federatedUserSearch(keyword, {
            limit,
            currentUserId: res.locals.userid || null,
        });

        return res.json({
            status: 'ok',
            data: {
                users: result.users,
                remoteUser: result.remoteUser,
                isFediSearch: result.isFediSearch,
                keyword,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 远程用户搜索错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 通过 actor URL 解析远程用户
 * POST /ap/remote/users/resolve
 * Body: { acct: "@user@domain" } 或 { actorUrl: "https://..." }
 */
router.post('/remote/users/resolve', requireFederation, async (req, res) => {
    try {
        const { acct, actorUrl } = req.body;
        if (!acct && !actorUrl) {
            return res.status(400).json({ error: 'acct or actorUrl is required' });
        }

        let proxyUser;
        if (acct) {
            proxyUser = await resolveAndEnsureProxyUser(acct);
        } else {
            proxyUser = await ensureProxyUser(actorUrl);
        }

        if (!proxyUser) {
            return res.status(404).json({ error: 'Could not resolve remote user' });
        }

        const remoteInfo = await getRemoteUserInfo(proxyUser.id);
        return res.json({
            status: 'ok',
            data: {
                user: proxyUser,
                remote: remoteInfo,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 远程用户解析错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 列出所有远程代理用户
 * GET /ap/remote/users?page=1&limit=20
 */
router.get('/remote/users', requireFederation, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;
        const keyword = req.query.q || '';

        let result;
        if (keyword) {
            result = await searchProxyUsers(keyword, limit);
        } else {
            result = await listProxyUsers(limit, skip);
        }

        return res.json({
            status: 'ok',
            data: {
                users: result.users,
                total: result.total,
                page,
                limit,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 列出远程用户错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取远程用户详细信息
 * GET /ap/remote/users/:userId/info
 */
router.get('/remote/users/:userId/info', requireFederation, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const isRemote = await isRemoteProxyUser(userId);
        if (!isRemote) {
            return res.status(404).json({ error: 'Not a remote proxy user' });
        }

        const remoteInfo = await getRemoteUserInfo(userId);
        const actorUrl = await getProxyUserActorUrl(userId);

        return res.json({
            status: 'ok',
            data: {
                userId,
                actorUrl,
                remote: remoteInfo,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 获取远程用户信息错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 拉取远程用户的帖子
 * POST /ap/remote/users/:userId/fetch-posts
 */
router.post('/remote/users/:userId/fetch-posts', requireFederation, async (req, res) => {
    try {
        if (!res.locals.userid) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const isRemote = await isRemoteProxyUser(userId);
        if (!isRemote) {
            return res.status(404).json({ error: 'Not a remote proxy user' });
        }

        const actorUrl = await getProxyUserActorUrl(userId);
        if (!actorUrl) {
            return res.status(404).json({ error: 'Actor URL not found' });
        }

        const maxPosts = Math.min(parseInt(req.body.maxPosts) || 20, 100);
        const imported = await fetchRemoteUserPosts(actorUrl, maxPosts);

        return res.json({
            status: 'ok',
            data: {
                userId,
                imported: imported.length,
                posts: imported.map(p => ({ id: p.id, title: p.title, createdAt: p.time })),
            },
        });
    } catch (err) {
        logger.error('[ap-route] 拉取远程用户帖子错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取远程用户在本地的帖子
 * GET /ap/remote/users/:userId/posts?page=1&limit=20
 */
router.get('/remote/users/:userId/posts', requireFederation, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

        const isRemote = await isRemoteProxyUser(userId);
        if (!isRemote) {
            return res.status(404).json({ error: 'Not a remote proxy user' });
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const skip = (page - 1) * limit;

        const result = await getRemoteUserLocalPosts(userId, limit, skip);
        return res.json({
            status: 'ok',
            data: {
                posts: result.posts,
                total: result.total,
                page,
                limit,
            },
        });
    } catch (err) {
        logger.error('[ap-route] 获取远程用户帖子错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取当前用户的出站关注状态（关注的远程用户）
 * GET /ap/remote/follows
 */
router.get('/remote/follows', requireFederation, async (req, res) => {
    try {
        if (!res.locals.userid) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const follows = await getOutboundFollows(res.locals.userid);
        return res.json({ status: 'ok', data: follows });
    } catch (err) {
        logger.error('[ap-route] 获取出站关注错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 检查域名是否在白名单/黑名单中
 * GET /ap/remote/check-instance?domain=mastodon.social
 */
router.get('/remote/check-instance', requireFederation, async (req, res) => {
    try {
        const { domain } = req.query;
        if (!domain) {
            return res.status(400).json({ error: 'domain query parameter is required' });
        }
        const allowed = await isInstanceAllowed(domain);
        return res.json({ status: 'ok', data: { domain, allowed } });
    } catch (err) {
        logger.error('[ap-route] 检查实例错误:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ═══════════════════════════════════════════════════════════════
// OG Card 端点 — 为 Mastodon 等 ActivityPub 实现提供链接预览卡片
// Mastodon 从帖子 content HTML 中提取 URL 并抓取其 OpenGraph 元数据
// 这些端点返回带有 og: 标签的最小 HTML 页面，并自动重定向到前端
// ═══════════════════════════════════════════════════════════════

/**
 * 生成带 OG 标签的最小 HTML 页面
 */
function renderOgPage({ title, description, image, url, siteName, redirectUrl }) {
    const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description || '')}"/>
${image ? `<meta property="og:image" content="${esc(image)}"/>` : ''}
<meta property="og:url" content="${esc(url)}"/>
${siteName ? `<meta property="og:site_name" content="${esc(siteName)}"/>` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(description || '')}"/>
${image ? `<meta name="twitter:image" content="${esc(image)}"/>` : ''}
<meta http-equiv="refresh" content="0;url=${esc(redirectUrl || url)}"/>
<title>${esc(title)}</title>
</head>
<body>
<p>Redirecting to <a href="${esc(redirectUrl || url)}">${esc(title)}</a>...</p>
</body>
</html>`;
}

/**
 * OG Card: Project
 * GET /ap/card/project/:id
 */
router.get('/card/project/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).send('Invalid ID');

        const project = await prisma.ow_projects.findUnique({
            where: { id },
            select: {
                id: true, name: true, title: true, description: true,
                thumbnail: true, state: true,
                author: { select: { username: true, display_name: true } },
            },
        });

        if (!project || project.state !== 'public' || !await canViewContent('project', project, null)) {
            return res.status(404).send('Not found');
        }

        const staticUrl = await getStaticUrl();
        const apBaseUrl = await getApEndpointBaseUrl();
        const baseUrl = await getInstanceBaseUrl();
        const domain = await getInstanceDomain();
        const title = project.title || project.name;
        const description = project.description
            ? project.description.substring(0, 200)
            : `Project by ${project.author?.display_name || project.author?.username || 'unknown'}`;
        let image = null;
        if (project.thumbnail) {
            const p1 = project.thumbnail.substring(0, 2);
            const p2 = project.thumbnail.substring(2, 4);
            image = `${staticUrl}/assets/${p1}/${p2}/${project.thumbnail}.webp`;
        }

        const authorName = project.author?.username || 'unknown';
        const cardUrl = `${apBaseUrl}/ap/card/project/${project.id}`;
        const projectUrl = `${baseUrl}/${encodeURIComponent(authorName)}/${encodeURIComponent(project.name)}`;

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        return res.send(renderOgPage({
            title,
            description,
            image,
            url: cardUrl,
            siteName: domain,
            redirectUrl: projectUrl,
        }));
    } catch (err) {
        logger.error('[ap-card] 项目卡片错误:', err);
        res.status(500).send('Internal server error');
    }
});

/**
 * OG Card: User
 * GET /ap/card/user/:id
 */
router.get('/card/user/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).send('Invalid ID');

        const user = await prisma.ow_users.findUnique({
            where: { id },
            select: { id: true, username: true, display_name: true, bio: true, avatar: true },
        });

        if (!user || !await canViewContent('profile', user, null)) return res.status(404).send('Not found');

        const staticUrl = await getStaticUrl();
        const apBaseUrl = await getApEndpointBaseUrl();
        const baseUrl = await getInstanceBaseUrl();
        const domain = await getInstanceDomain();
        const title = `${user.display_name || user.username} (@${user.username}@${domain})`;
        const description = user.bio ? user.bio.substring(0, 200) : `User profile on ${domain}`;
        let image = null;
        if (user.avatar && !user.avatar.startsWith('http')) {
            const p1 = user.avatar.substring(0, 2);
            const p2 = user.avatar.substring(2, 4);
            image = `${staticUrl}/assets/${p1}/${p2}/${user.avatar}.webp`;
        }

        const cardUrl = `${apBaseUrl}/ap/card/user/${user.id}`;
        const userUrl = `${baseUrl}/${user.username}`;

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        return res.send(renderOgPage({
            title,
            description,
            image,
            url: cardUrl,
            siteName: domain,
            redirectUrl: userUrl,
        }));
    } catch (err) {
        logger.error('[ap-card] 用户卡片错误:', err);
        res.status(500).send('Internal server error');
    }
});

/**
 * OG Card: List (合集)
 * GET /ap/card/list/:id
 */
router.get('/card/list/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).send('Invalid ID');

        const list = await prisma.ow_projects_lists.findUnique({
            where: { id },
            select: {
                id: true, title: true, description: true, state: true,
                author: { select: { username: true, display_name: true } },
            },
        });

        if (!list || list.state !== 'public' || !await canViewContent('list', list, null)) {
            return res.status(404).send('Not found');
        }

        const apBaseUrl = await getApEndpointBaseUrl();
        const baseUrl = await getInstanceBaseUrl();
        const domain = await getInstanceDomain();
        const title = list.title;
        const description = list.description
            ? list.description.substring(0, 200)
            : `Collection by ${list.author?.display_name || list.author?.username || 'unknown'}`;

        const cardUrl = `${apBaseUrl}/ap/card/list/${list.id}`;
        const listUrl = `${baseUrl}/app/projectlist/${list.id}`;

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        return res.send(renderOgPage({
            title,
            description,
            image: null,
            url: cardUrl,
            siteName: domain,
            redirectUrl: listUrl,
        }));
    } catch (err) {
        logger.error('[ap-card] 列表卡片错误:', err);
        res.status(500).send('Internal server error');
    }
});

export default router;
