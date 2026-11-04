/**
 * 远程用户代理服务
 * 在本地 ow_users 中创建远程 ActivityPub 用户的代理账户
 * 使用特殊 type 标记，用户名格式为 user@domain
 * 额外信息存储在 ow_target_configs 中
 */

import { prisma } from '../prisma.js';
import { visibleWhere } from '../moderation/visibility.js';
import logger from '../logger.js';
import { TARGET_TYPES, getInstanceDomain } from './config.js';
import { fetchRemoteActor, resolveWebFinger } from './federation.js';
import { upsertTargetConfig, getTargetConfig, queryTargetConfigs } from './store.js';
import { cacheActorMedia } from './remoteMedia.js';

// 远程用户在 ow_users 中的 type 标记
export const REMOTE_USER_TYPE = 'remote_activitypub';

// ow_target_configs 中远程用户的 target_type
const REMOTE_USER_TARGET_TYPE = 'ap_remote_user';

// 数据库字段长度限制 (与 schema.prisma 一致)
const LIMITS = {
    USERNAME: 64,       // VarChar(64)
    DISPLAY_NAME: 64,   // VarChar(64)
    AVATAR: 512,        // VarChar(512)
    IMAGES: 512,        // VarChar(512)
    URL: 512,           // VarChar(512)
};
const DEFAULT_HASH = 'fcd939e653195bb6d057e8c2519f5cc7';

/**
 * 将远程 Actor URL 解析为标准化的 username@domain 格式
 * @param {object} actor - AP Actor 对象
 * @returns {string} 格式化的用户名
 */
function buildRemoteUsername(actor) {
    try {
        const url = new URL(actor.id || actor.url);
        const domain = url.host;
        const preferredUsername = actor.preferredUsername || actor.name || 'unknown';
        const full = `${preferredUsername}@${domain}`;
        return full.length <= LIMITS.USERNAME ? full : full.substring(0, LIMITS.USERNAME);
    } catch {
        return `unknown@unknown`;
    }
}

// 兼容别名
const buildFullRemoteUsername = buildRemoteUsername;

/**
 * 安全截断字符串到指定长度
 */
function safeTruncate(str, maxLen) {
    if (!str) return str;
    return str.length > maxLen ? str.substring(0, maxLen) : str;
}

/**
 * 处理远程 avatar/images URL，超长时使用默认值
 */
function safeMediaUrl(url, maxLen = LIMITS.AVATAR) {
    if (!url) return DEFAULT_HASH;
    return url.length <= maxLen ? url : DEFAULT_HASH;
}

/**
 * 根据 Actor URL 查找本地代理用户
 * @param {string} actorUrl - 远程 Actor URL
 * @returns {object|null} 本地代理用户
 */
export async function findProxyUserByActorUrl(actorUrl) {
    const selectFields = { id: true, username: true, display_name: true, type: true, avatar: true, bio: true };

    // 1. 全局索引: actor_map:{actorUrl} -> userId
    const mapping = await getTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `actor_map:${actorUrl}`);
    if (mapping) {
        const userId = parseInt(mapping, 10);
        if (!isNaN(userId)) {
            const user = await prisma.ow_users.findUnique({ where: { id: userId }, select: selectFields });
            if (user && user.type === REMOTE_USER_TYPE) return user;
        }
    }

    // 2. 全局索引缺失时，扫描每用户 actor_url 键进行兜底查找
    const perUserMappings = await prisma.ow_target_configs.findMany({
        where: {
            target_type: REMOTE_USER_TARGET_TYPE,
            key: 'actor_url',
            value: actorUrl,
        },
        take: 10,
    });
    const candidateIds = (perUserMappings || [])
        .filter(row => row.value === actorUrl && row.target_id !== '0')
        .map(row => parseInt(row.target_id, 10))
        .filter(userId => !isNaN(userId));
    if (candidateIds.length) {
        const users = await prisma.ow_users.findMany({
            where: { id: { in: [...new Set(candidateIds)] }, type: REMOTE_USER_TYPE },
            select: selectFields,
        });
        const userById = new Map(users.map(user => [user.id, user]));
        // Preserve mapping precedence if legacy rows point at different proxy users.
        const userId = candidateIds.find(id => userById.has(id));
        if (userId !== undefined) {
            await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `actor_map:${actorUrl}`, String(userId));
            return userById.get(userId);
        }
    }

    return null;
}

/**
 * 根据 username@domain 格式查找本地代理用户
 * @param {string} remoteUsername - 格式 user@domain.com
 * @returns {object|null}
 */
export async function findProxyUserByRemoteUsername(remoteUsername) {
    const user = await prisma.ow_users.findFirst({
        where: {
            username: remoteUsername,
            type: REMOTE_USER_TYPE,
        },
        select: {
            id: true, username: true, display_name: true, type: true,
            avatar: true, bio: true, images: true,
            url: true, location: true, status: true,
        },
    });
    if (user) return user;

    // 兼容旧数据：通过 target_configs 的 username_map 查找
    const mapping = await getTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `username_map:${remoteUsername}`);
    if (mapping) {
        const userId = parseInt(mapping, 10);
        if (!isNaN(userId)) {
            const u = await prisma.ow_users.findUnique({
                where: { id: userId },
                select: {
                    id: true, username: true, display_name: true, type: true,
                    avatar: true, bio: true, images: true,
                    url: true, location: true, status: true,
                },
            });
            if (u && u.type === REMOTE_USER_TYPE) return u;
        }
    }
    return null;
}

/**
 * 获取代理用户储存的远程信息
 * @param {number} proxyUserId
 * @returns {object} 远程用户详细信息
 */
export async function getRemoteUserInfo(proxyUserId) {
    const infoRaw = await getTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_info');
    if (!infoRaw) return null;
    try {
        return typeof infoRaw === 'string' ? JSON.parse(infoRaw) : infoRaw;
    } catch {
        return null;
    }
}

/**
 * 创建或更新远程用户的本地代理账户
 * @param {string} actorUrl - 远程 Actor URL
 * @param {object} [actorData] - 可选的已获取的 Actor 数据
 * @returns {object} 本地代理用户
 */
export async function ensureProxyUser(actorUrl, actorData = null) {
    // 检查是否是本地用户
    const instanceDomain = await getInstanceDomain();

    // 获取远程 Actor
    const actor = actorData || await fetchRemoteActor(actorUrl, false);
    if (!actor) {
        throw new Error(`无法获取远程 Actor: ${actorUrl}`);
    }

    // 检查是否为本站 actor
    try {
        const actorDomain = new URL(actor.id || actorUrl).host;
        if (actorDomain === instanceDomain) {
            // 本站用户，不需要代理
            const preferredUsername = actor.preferredUsername;
            if (preferredUsername) {
                const localUser = await prisma.ow_users.findFirst({
                    where: { username: preferredUsername, status: 'active' },
                });
                if (localUser) return localUser;
            }
            return null;
        }
    } catch { /* ignore */ }

    const remoteUsername = buildFullRemoteUsername(actor);

    // 查找已有代理用户
    let proxyUser = await findProxyUserByActorUrl(actorUrl);

    if (proxyUser) {
        // 更新现有代理用户信息
        await updateProxyUser(proxyUser.id, actor);
        return await prisma.ow_users.findUnique({ where: { id: proxyUser.id } });
    }

    // 也通过完整 username 查找（防止映射丢失）
    proxyUser = await findProxyUserByRemoteUsername(remoteUsername);
    if (proxyUser) {
        // 恢复全局映射 + 每用户映射
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `actor_map:${actorUrl}`, String(proxyUser.id));
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `username_map:${remoteUsername}`, String(proxyUser.id));
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUser.id), 'actor_url', actorUrl);
        await updateProxyUser(proxyUser.id, actor);
        return await prisma.ow_users.findUnique({ where: { id: proxyUser.id } });
    }

    // 创建新的代理用户
    try {
        const displayName = safeTruncate(
            actor.name || actor.preferredUsername || remoteUsername,
            LIMITS.DISPLAY_NAME
        );
        const actorUrlStr = safeTruncate(actor.url || actor.id, LIMITS.URL);

        // 先用默认头像创建用户，稍后异步缓存远程图片
        const newUser = await prisma.ow_users.create({
            data: {
                username: remoteUsername,
                display_name: displayName,
                type: REMOTE_USER_TYPE,
                status: 'active',
                bio: (actor.summary || '').replace(/<[^>]*>/g, '').substring(0, 255) || null,
                url: actorUrlStr,
                avatar: DEFAULT_HASH,
                images: DEFAULT_HASH,
                password: null, // 远程用户无法登录
            },
        });

        // 缓存远程头像/横幅到本地 S3，写入 ow_assets
        try {
            const { avatar, banner } = await cacheActorMedia(actor, newUser.id);
            await prisma.ow_users.update({
                where: { id: newUser.id },
                data: { avatar, images: banner },
            });
            newUser.avatar = avatar;
            newUser.images = banner;
        } catch (mediaErr) {
            logger.warn(`[ap-remote-user] 缓存远程媒体失败 (#${newUser.id}):`, mediaErr.message);
        }

        // 存储 actorUrl -> userId 全局映射
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `actor_map:${actorUrl}`, String(newUser.id));
        // 存储 username -> userId 全局映射 (用于 @user@domain 查找)
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `username_map:${remoteUsername}`, String(newUser.id));

        // 存储每用户持久化映射 (即使全局映射丢失也能恢复)
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(newUser.id), 'actor_url', actorUrl);
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(newUser.id), 'current_username', remoteUsername);

        // 存储完整远程信息
        await storeRemoteUserInfo(newUser.id, actor);

        logger.info(`[ap-remote-user] 创建远程代理用户: ${remoteUsername} (id=${newUser.id}) <- ${actorUrl}`);
        return newUser;
    } catch (err) {
        // 可能 username 冲突（并发创建），尝试再次查找
        if (err.code === 'P2002') {
            const existing = await findProxyUserByRemoteUsername(remoteUsername);
            if (existing) {
                await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `actor_map:${actorUrl}`, String(existing.id));
                return existing;
            }
        }
        logger.error(`[ap-remote-user] 创建代理用户失败:` + err);
        throw err;
    }
}

/**
 * 更新代理用户信息（包括处理远端用户名变更）
 */
async function updateProxyUser(proxyUserId, actor) {
    try {
        const newRemoteUsername = buildRemoteUsername(actor);

        const updateData = {
            display_name: safeTruncate(
                actor.name || actor.preferredUsername || '',
                LIMITS.DISPLAY_NAME
            ),
            bio: (actor.summary || '').replace(/<[^>]*>/g, '').substring(0, 255) || null,
            url: safeTruncate(actor.url || actor.id, LIMITS.URL),
        };

        // 缓存远程头像/横幅到本地 S3
        try {
            const { avatar, banner } = await cacheActorMedia(actor, proxyUserId);
            updateData.avatar = avatar;
            updateData.images = banner;
        } catch (mediaErr) {
            logger.warn(`[ap-remote-user] 缓存远程媒体失败 (#${proxyUserId}):`, mediaErr.message);
        }

        // 检测远端用户名是否变更
        const currentUser = await prisma.ow_users.findUnique({
            where: { id: proxyUserId },
            select: { username: true },
        });
        const oldUsername = currentUser?.username;

        if (oldUsername && oldUsername !== newRemoteUsername) {
            // 远端用户名已变更，同步更新本地 username
            updateData.username = newRemoteUsername;
            logger.info(`[ap-remote-user] 远端用户名变更: ${oldUsername} -> ${newRemoteUsername} (proxy #${proxyUserId})`);

            // 清理旧的 username_map，写入新的
            try {
                await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `username_map:${oldUsername}`, '');
            } catch { /* 旧映射可能不存在 */ }
            await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, '0', `username_map:${newRemoteUsername}`, String(proxyUserId));
        }

        await prisma.ow_users.update({
            where: { id: proxyUserId },
            data: updateData,
        });

        // 更新远程信息 & 每用户持久化映射
        await storeRemoteUserInfo(proxyUserId, actor);

        logger.debug(`[ap-remote-user] 更新代理用户 #${proxyUserId} 的信息`);
    } catch (err) {
        logger.error(`[ap-remote-user] 更新代理用户 #${proxyUserId} 失败:`, err.message);
    }
}

/**
 * 存储远程用户完整信息到 ow_target_configs
 */
async function storeRemoteUserInfo(proxyUserId, actor) {
    const fullUsername = buildFullRemoteUsername(actor);

    // 提取远程粉丝/关注数量
    const followersCount = extractFollowCount(actor, 'followers');
    const followingCount = extractFollowCount(actor, 'following');

    const info = {
        actorUrl: actor.id,
        actorType: actor.type,
        preferredUsername: actor.preferredUsername,
        fullRemoteUsername: fullUsername,
        name: actor.name,
        summary: actor.summary,
        url: actor.url,
        inbox: actor.inbox,
        outbox: actor.outbox,
        followers: actor.followers,
        following: actor.following,
        followersCount,
        followingCount,
        sharedInbox: actor.endpoints?.sharedInbox,
        publicKeyId: actor.publicKey?.id,
        publicKeyPem: actor.publicKey?.publicKeyPem,
        icon: actor.icon,
        image: actor.image,
        attachment: actor.attachment,
        discoverable: actor.discoverable,
        manuallyApprovesFollowers: actor.manuallyApprovesFollowers,
        published: actor.published,
        updated: actor.updated || new Date().toISOString(),
        _syncedAt: new Date().toISOString(),
    };

    await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_info', JSON.stringify(info));

    // 单独存储粉丝/关注数量以便快速查询
    if (followersCount !== null) {
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_followers_count', String(followersCount));
    }
    if (followingCount !== null) {
        await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_following_count', String(followingCount));
    }

    // 每用户持久化映射: actor_url 和 current_username
    // 即使全局 actor_map / username_map 丢失，也能通过 userId 反查
    await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'actor_url', actor.id);
    await upsertTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'current_username', fullUsername);
}

/**
 * 从 Actor 对象中提取粉丝/关注数量
 * 支持 Mastodon (直接数值) 和标准 AP Collection (totalItems)
 * @param {object} actor - AP Actor 对象
 * @param {'followers'|'following'} field
 * @returns {number|null}
 */
function extractFollowCount(actor, field) {
    // 一些实现直接在 actor 上提供数值
    const directKey = field + 'Count';
    if (typeof actor[directKey] === 'number') return actor[directKey];

    // Mastodon 的 followers_count / following_count
    const snakeKey = field === 'followers' ? 'followers_count' : 'following_count';
    if (typeof actor[snakeKey] === 'number') return actor[snakeKey];

    // 如果 followers/following 是内联的 Collection 对象
    const collection = actor[field];
    if (collection && typeof collection === 'object') {
        if (typeof collection.totalItems === 'number') return collection.totalItems;
    }

    return null;
}

/**
 * 获取远程代理用户的远端粉丝/关注数量
 * @param {number} proxyUserId
 * @returns {Promise<{followersCount: number|null, followingCount: number|null}>}
 */
export async function getRemoteFollowCounts(proxyUserId) {
    const [followersRaw, followingRaw] = await Promise.all([
        getTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_followers_count'),
        getTargetConfig(REMOTE_USER_TARGET_TYPE, String(proxyUserId), 'remote_following_count'),
    ]);
    return {
        followersCount: followersRaw !== null ? parseInt(followersRaw, 10) : null,
        followingCount: followingRaw !== null ? parseInt(followingRaw, 10) : null,
    };
}

/**
 * 根据 acct（user@domain 格式）解析并确保本地代理用户存在
 * @param {string} acct - user@domain 格式
 * @returns {object|null} 本地代理用户
 */
export async function resolveAndEnsureProxyUser(acct) {
    const cleanAcct = acct.replace(/^@/, '').replace(/^acct:/, '');
    const parts = cleanAcct.split('@');
    if (parts.length !== 2) return null;

    const [username, domain] = parts;

    // 检查是否为本站用户
    const instanceDomain = await getInstanceDomain();
    if (domain === instanceDomain) {
        return prisma.ow_users.findFirst({
            where: { username, status: 'active' },
        });
    }

    // 先看有没有已创建的代理
    const existing = await findProxyUserByRemoteUsername(`${username}@${domain}`);
    if (existing) return existing;

    // WebFinger 解析
    const result = await resolveWebFinger(`${username}@${domain}`);
    if (!result?.actorUrl) return null;

    // 拉取并创建代理
    return ensureProxyUser(result.actorUrl);
}

/**
 * 判断用户是否为远程代理用户
 * @param {object|number} user - 用户对象或用户ID
 * @returns {boolean}
 */
export async function isRemoteProxyUser(user) {
    if (typeof user === 'number') {
        const u = await prisma.ow_users.findUnique({
            where: { id: user },
            select: { type: true },
        });
        return u?.type === REMOTE_USER_TYPE;
    }
    return user?.type === REMOTE_USER_TYPE;
}

/**
 * 获取代理用户对应的远程 Actor URL
 * @param {number} proxyUserId
 * @returns {string|null}
 */
export async function getProxyUserActorUrl(proxyUserId) {
    const info = await getRemoteUserInfo(proxyUserId);
    return info?.actorUrl || null;
}

/**
 * 获取代理用户对应的远程 inbox
 * @param {number} proxyUserId
 * @returns {string|null}
 */
export async function getProxyUserInbox(proxyUserId) {
    const info = await getRemoteUserInfo(proxyUserId);
    return info?.inbox || null;
}

/**
 * 获取代理用户对应的远程 shared inbox
 * @param {number} proxyUserId
 * @returns {string|null}
 */
export async function getProxyUserSharedInbox(proxyUserId) {
    const info = await getRemoteUserInfo(proxyUserId);
    return info?.sharedInbox || info?.inbox || null;
}

/**
 * 列出所有远程代理用户
 * @param {number} limit
 * @param {number} offset
 * @returns {Array} 代理用户列表
 */
export async function listProxyUsers(limit = 50, offset = 0) {
    return prisma.ow_users.findMany({
        where: { type: REMOTE_USER_TYPE, AND: [await visibleWhere('profile')] },
        select: {
            id: true, username: true, display_name: true,
            avatar: true, bio: true, url: true,
            status: true, regTime: true, updatedAt: true,
        },
        orderBy: { id: 'desc' },
        take: limit,
        skip: offset,
    });
}

/**
 * 搜索远程代理用户
 * @param {string} keyword
 * @param {number} limit
 * @returns {Array}
 */
export async function searchProxyUsers(keyword, limit = 20) {
    return prisma.ow_users.findMany({
        where: {
            type: REMOTE_USER_TYPE,
            AND: [await visibleWhere('profile')],
            OR: [
                { username: { contains: keyword, mode: 'insensitive' } },
                { display_name: { contains: keyword, mode: 'insensitive' } },
            ],
        },
        select: {
            id: true, username: true, display_name: true,
            avatar: true, bio: true, url: true,
        },
        take: limit,
    });
}
