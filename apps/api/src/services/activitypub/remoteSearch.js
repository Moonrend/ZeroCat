/**
 * 远程用户搜索服务
 * 支持搜索 @user@domain.com 格式的远程用户
 * 自动拉取远程用户信息并创建本地代理账户
 */

import logger from '../logger.js';
import { isFederationEnabled, getInstanceDomain } from './config.js';
import { resolveWebFinger } from './federation.js';
import { ensureProxyUser, resolveAndEnsureProxyUser, searchProxyUsers, REMOTE_USER_TYPE } from './remoteUser.js';
import { isActorAllowed, isRemoteSearchAllowed } from './federationConfig.js';
import { prisma } from '../prisma.js';
import { visibleWhere, sanitizePublicUser, sanitizeProfiles } from '../moderation/visibility.js';

// 匹配 @user@domain 或 user@domain 格式
const FEDI_ADDRESS_REGEX = /^@?([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;

/**
 * 检查搜索关键词是否为联邦用户地址格式
 * @param {string} keyword
 * @returns {object|null} { username, domain } 或 null
 */
export function parseFediAddress(keyword) {
    const match = keyword.trim().match(FEDI_ADDRESS_REGEX);
    if (!match) return null;
    return { username: match[1], domain: match[2] };
}

/**
 * 联邦用户搜索
 * 如果搜索关键词是 @user@domain 格式，同时尝试从远端拉取用户
 * @param {string} keyword - 搜索关键词
 * @param {object} [options] - 搜索选项
 * @param {number} [options.limit=20] - 最大结果数
 * @param {boolean} [options.includeLocal=true] - 是否包含本地用户
 * @param {boolean} [options.includeRemote=true] - 是否包含远程用户
 * @returns {object} { users, remoteUser, isFediSearch }
 */
export async function federatedUserSearch(keyword, options = {}) {
    const { limit = 20, includeLocal = true, includeRemote = true, currentUserId = null } = options;

    const enabled = await isFederationEnabled();
    const fediAddr = parseFediAddress(keyword);
    const result = {
        users: [],
        remoteUser: null,
        isFediSearch: !!fediAddr,
        federationEnabled: enabled,
    };

    // 先执行普通搜索（本地 + 已有的代理用户）
    const localResults = [];

    if (includeLocal) {
        const localUsers = await prisma.ow_users.findMany({
            where: {
                AND: [await visibleWhere('profile', currentUserId)],
                OR: [
                    { username: { contains: keyword.replace(/^@/, ''), mode: 'insensitive' } },
                    { display_name: { contains: keyword.replace(/^@/, ''), mode: 'insensitive' } },
                ],
                ...(includeRemote ? {} : { type: { not: REMOTE_USER_TYPE } }),
            },
            select: {
                id: true, username: true, display_name: true,
                avatar: true, bio: true, url: true,
                type: true, status: true,
            },
            take: limit,
        });
        localResults.push(...localUsers);
    }

    // 搜索已有的远程代理用户
    if (includeRemote && enabled) {
        const remoteResults = await searchProxyUsers(keyword.replace(/^@/, ''), limit);
        // 合并结果（去重）
        const existingIds = new Set(localResults.map(u => u.id));
        for (const r of remoteResults) {
            if (!existingIds.has(r.id)) {
                localResults.push({ ...r, type: REMOTE_USER_TYPE });
                existingIds.add(r.id);
            }
        }
    }

    result.users = (await sanitizeProfiles(localResults, currentUserId)).filter(Boolean).slice(0, limit);

    // 如果是联邦地址格式，且联邦启用，同时尝试远程拉取
    if (fediAddr && enabled) {
        const remoteSearchAllowed = await isRemoteSearchAllowed();
        if (!remoteSearchAllowed) {
            result.remoteSearchDisabled = true;
            return result;
        }

        const { username, domain } = fediAddr;
        const instanceDomain = await getInstanceDomain();

        // 本站用户不用远程搜索
        if (domain === instanceDomain) {
            return result;
        }

        // 检查实例是否允许
        const allowed = await isActorAllowed(`https://${domain}/`);
        if (!allowed) {
            result.instanceBlocked = true;
            return result;
        }

        try {
            // 尝试 WebFinger 解析
            const proxyUser = await resolveAndEnsureProxyUser(`${username}@${domain}`);
            if (proxyUser && await sanitizePublicUser(proxyUser, currentUserId)) {
                result.remoteUser = {
                    id: proxyUser.id,
                    username: proxyUser.username,
                    display_name: proxyUser.display_name,
                    avatar: proxyUser.avatar,
                    bio: proxyUser.bio,
                    url: proxyUser.url,
                    type: REMOTE_USER_TYPE,
                    is_remote: true,
                };

                // 确保远程用户在结果列表中
                if (!result.users.some(u => u.id === proxyUser.id)) {
                    result.users.unshift(result.remoteUser);
                }
            }
        } catch (err) {
            logger.warn(`[ap-search] 远程用户搜索失败 ${username}@${domain}:`+ err);
            result.remoteError = err.message;
        }
    }

    // 标记哪些是远程用户
    result.users = result.users.map(u => ({
        ...u,
        is_remote: u.type === REMOTE_USER_TYPE,
    }));

    return result;
}

/**
 * 通过完整 Actor URL 搜索/拉取远程用户
 * @param {string} actorUrl
 * @returns {object|null} 本地代理用户
 */
export async function searchByActorUrl(actorUrl) {
    const enabled = await isFederationEnabled();
    if (!enabled) return null;

    const allowed = await isActorAllowed(actorUrl);
    if (!allowed) return null;

    try {
        return await ensureProxyUser(actorUrl);
    } catch (err) {
        logger.warn(`[ap-search] 通过 Actor URL 搜索失败:`, err.message);
        return null;
    }
}
