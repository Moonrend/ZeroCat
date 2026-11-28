/**
 * ActivityPub 联邦工具
 * 处理远程 Actor 获取、缓存和通信
 */

import logger from '../logger.js';
import { AP_CONTENT_TYPE, AP_ACCEPT_TYPES } from './config.js';
import { cacheRemoteActor, getCachedRemoteActor } from './store.js';
import { getKeyDocumentUrl, validateActorKeyBinding, validateFetchedActorIdentity } from './identityBinding.js';

import { federationGet, validateFederationDestination } from './federationHttp.js';

// 远程 Actor 缓存 TTL (1小时)
const ACTOR_CACHE_TTL = 60 * 60 * 1000;

/**
 * 获取远程 Actor，带缓存
 * @param {string} actorUrl Actor 的 URL (也是其 ID)
 * @returns {object|null} Actor 对象
 */
export async function fetchRemoteActor(actorUrl, forceRefresh = false) {
    let safeActorUrl;
    try {
        // Validate before consulting persisted cache so entries created before
        // this boundary cannot preserve access to a now-protected destination.
        safeActorUrl = (await validateFederationDestination(actorUrl)).url;
    } catch (err) {
        logger.warn(`[ap-federation] 拒绝不安全的 actor URL: ${err.message}`);
        return null;
    }

    // 尝试从缓存读取
    if (!forceRefresh) {
        const cached = await getCachedRemoteActor(safeActorUrl);
        if (cached && cached._cachedAt) {
            const age = Date.now() - new Date(cached._cachedAt).getTime();
            const identity = validateFetchedActorIdentity(cached, actorUrl);
            if (identity.valid && age < ACTOR_CACHE_TTL) {
                return cached;
            }
        }
    }

    try {
        logger.info(`[ap-federation] 获取远程 actor: ${safeActorUrl}`);
        const response = await federationGet(safeActorUrl, {
            headers: {
                'Accept': AP_ACCEPT_TYPES[0],
                'User-Agent': 'ZeroCat-ActivityPub/1.0',
            },
            timeout: 15000,
            validateStatus: s => s === 200,
        });

        const actor = response.data;
        if (!actor || !actor.id) {
            logger.warn(`[ap-federation] 来自 ${safeActorUrl} 的 actor 响应无效`);
            return null;
        }

        const identity = validateFetchedActorIdentity(actor, actorUrl);
        if (!identity.valid) {
            logger.warn(`[ap-federation] 拒绝来自 ${actorUrl} 的 actor: ${identity.message}`);
            return null;
        }

        // 缓存
        actor._cachedAt = new Date().toISOString();
        await cacheRemoteActor(safeActorUrl, actor);

        return actor;
    } catch (err) {
        logger.warn(`[ap-federation] 失败获取 actor ${actorUrl}:`+ err.message);
        return null;
    }
}

/**
 * 从远程 Actor 提取收件箱 URL
 */
export function getInboxUrl(actor) {
    return actor?.inbox || null;
}

/**
 * 从远程 Actor 提取共享收件箱 URL
 */
export function getSharedInboxUrl(actor) {
    return actor?.endpoints?.sharedInbox || actor?.inbox || null;
}

/**
 * 从远程 Actor 提取公钥
 */
export function getPublicKeyFromActor(actor) {
    if (!actor?.publicKey) return null;
    return actor.publicKey.publicKeyPem || null;
}

/**
 * 通过 keyId 获取公钥
 * keyId 通常是 "https://example.com/users/alice#main-key"
 */
export async function fetchPublicKeyByKeyId(keyId) {
    if (!keyId) return null;

    // keyId 通常是 actorUrl#main-key 格式
    const actorUrl = getKeyDocumentUrl(keyId);
    if (!actorUrl) return null;

    const actor = await fetchRemoteActor(actorUrl, true); // 强制刷新以获取最新公钥
    if (!actor) return null;

    const binding = validateActorKeyBinding({ actor, keyId });
    return binding.valid ? binding.publicKeyPem : null;
}

/**
 * 解析 WebFinger 获取远程用户
 * @param {string} acct - user@domain 格式的账号
 * @returns {{ actorUrl: string, username: string, domain: string } | null}
 */
export async function resolveWebFinger(acct) {
    // 移除 acct: 前缀
    const cleanAcct = acct.replace(/^acct:/, '');
    const parts = cleanAcct.split('@');
    if (parts.length !== 2) return null;

    const [username, domain] = parts;

    try {
        const url = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
        const response = await federationGet(url, {
            headers: {
                'Accept': 'application/jrd+json, application/json',
                'User-Agent': 'ZeroCat-ActivityPub/1.0',
            },
            timeout: 15000,
        });

        const data = response.data;
        if (!data || !data.links) return null;

        // 查找 self 链接（ActivityPub actor URL）
        const selfLink = data.links.find(
            link => link.rel === 'self' &&
            (link.type === 'application/activity+json' ||
             link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"')
        );

        if (!selfLink?.href) return null;

        return {
            actorUrl: selfLink.href,
            username,
            domain,
        };
    } catch (err) {
        logger.warn(`[ap-federation] WebFinger 查询失败 ${acct}:`, err.message);
        return null;
    }
}

/**
 * 收集需要投递的收件箱列表（去重）
 * @param {string[]} actorUrls Actor URL 列表
 * @returns {string[]} 去重后的收件箱 URL 列表
 */
export async function collectInboxes(actorUrls) {
    const inboxSet = new Set();

    for (const url of actorUrls) {
        if (!url || url === 'https://www.w3.org/ns/activitystreams#Public') continue;

        const actor = await fetchRemoteActor(url);
        if (!actor) continue;

        // 优先使用共享收件箱
        const inbox = getSharedInboxUrl(actor) || getInboxUrl(actor);
        if (inbox) inboxSet.add(inbox);
    }

    return [...inboxSet];
}
