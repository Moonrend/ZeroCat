/**
 * ActivityPub 活动投递
 * 将活动签名后 POST 到远程服务器的收件箱
 * 内置投递去重：同一 activity 不会重复投递给同一服务器
 */

import { prisma } from '../prisma.js';
import { assertCanWrite, visibleWhere } from '../moderation/visibility.js';
import logger from '../logger.js';
import { AP_CONTENT_TYPE } from './config.js';
import { signRequest, digestBody } from './httpSignature.js';
import { getUserPrivateKey } from './keys.js';
import { getActorKeyId } from './actor.js';
import { getLocalUserById } from './actor.js';
import { getRemoteFollowers, recordDelivery, isDelivered } from './store.js';
import { getSharedInboxUrl, fetchRemoteActor } from './federation.js';
import { federationRequest, validateFederationDestination } from './federationHttp.js';

/**
 * 发送已签名的 ActivityPub 请求
 * @param {object} opts
 * @param {string}  opts.inbox    - 目标收件箱 URL
 * @param {object}  opts.activity - 活动对象
 * @param {number}  opts.userId   - 发送者用户 ID
 * @param {string}  opts.username - 发送者用户名
 * @param {boolean} [opts.skipDedup=false] - 是否跳过去重检查
 * @param {Set}     [opts.deliveredInboxes] - 本轮已投递 inbox 集合（内存级跨调用去重）
 * @returns {boolean} 是否成功
 */
export async function deliverActivity({ inbox, activity, userId, username, skipDedup = false, deliveredInboxes = null }) {
    try {
        const activityType = activity?.type === 'Undo' ? activity.object?.type : activity?.type;
        const category = ['Follow', 'Accept', 'Reject'].includes(activityType) ? 'relations' : 'posts';
        await assertCanWrite(Number(userId), category, 'sync');
        const ownerVisible = await prisma.ow_users.findFirst({ where: { id: Number(userId), AND: [await visibleWhere('profile')] }, select: { id: true } });
        if (!ownerVisible) return false;
        const objectId = typeof activity?.object === 'string' ? activity.object : activity?.object?.id;
        const noteMatch = String(objectId || '').match(/\/ap\/notes\/(\d+)$/);
        if (noteMatch && activity?.type !== 'Delete') {
            const post = await prisma.ow_posts.findFirst({ where: { id: Number(noteMatch[1]), AND: [await visibleWhere('post')] } });
            if (!post) return false;
        }
        // ── 内存级去重（同一轮投递内跨 deliverToFollowers 调用共享） ──
        if (deliveredInboxes) {
            const domain = extractDomain(inbox);
            if (deliveredInboxes.has(domain)) {
                logger.debug(`[ap-delivery] 跳过已投递域 ${domain} (内存去重)`);
                return true;
            }
        }

        // ── 持久化去重（activity.id + 域名级别） ──
        if (!skipDedup && activity?.id) {
            const alreadySent = await isDelivered(activity, inbox);
            if (alreadySent) {
                logger.debug(`[ap-delivery] 跳过已投递: ${activity.id} -> ${extractDomain(inbox)}`);
                // 同步内存集合
                if (deliveredInboxes) deliveredInboxes.add(extractDomain(inbox));
                return true;
            }
        }

        // 先转为 Buffer，确保 Digest 计算和 HTTP 发送使用完全相同的字节
        const bodyStr = JSON.stringify(activity);
        const bodyBuf = Buffer.from(bodyStr, 'utf-8');
        // Validate before loading signing material, then validate and pin again
        // at connection time inside federationRequest.
        const safeInbox = (await validateFederationDestination(inbox)).url;
        const url = new URL(safeInbox);
        const privateKey = await getUserPrivateKey(userId);
        const keyId = await getActorKeyId(username);
        const digest = digestBody(bodyBuf);

        // 使用固定的 Date，确保签名和请求中完全一致
        const dateStr = new Date().toUTCString();
        // path 需要包含 query string (虽然 inbox URL 通常不带)
        const requestPath = url.pathname + (url.search || '');

        const headers = {
            'host': url.host,
            'date': dateStr,
            'digest': digest,
            'content-type': AP_CONTENT_TYPE,
        };

        const { signatureHeader } = signRequest({
            keyId,
            privateKey,
            method: 'POST',
            path: requestPath,
            headers,
        });

        logger.debug(`[ap-delivery] 投递到 ${safeInbox}, keyId=${keyId}, digest=${digest}`);

        const response = await federationRequest(safeInbox, {
            method: 'POST',
            data: bodyBuf,
            headers: {
                'Host': url.host,
                'Date': dateStr,
                'Digest': digest,
                'Content-Type': AP_CONTENT_TYPE,
                'Content-Length': bodyBuf.length,
                'Signature': signatureHeader,
                'User-Agent': 'ZeroCat-ActivityPub/1.0',
                'Accept': AP_CONTENT_TYPE,
            },
            timeout: 30000,
            followRedirects: false,
            validateStatus: () => true,
            // 禁止 axios 转换 Buffer body
            transformRequest: [(data) => data],
        });

        if (response.status >= 200 && response.status < 300) {
            logger.info(`[ap-delivery] 已发送到 ${inbox}: ${response.status}`);

            // 记录投递成功（持久化 + 内存）
            try { await recordDelivery(activity, inbox); } catch { /* best-effort */ }
            if (deliveredInboxes) deliveredInboxes.add(extractDomain(inbox));

            return true;
        } else {
            logger.warn(`[ap-delivery] 发送到 ${inbox} 返回 ${response.status}: ${
                typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data).substring(0, 200)
            }`);
            return false;
        }
    } catch (err) {
        logger.error(`[ap-delivery] 无法发送到 ${inbox}:`, err.message);
        return false;
    }
}

/**
 * 向用户的所有远程关注者投递活动
 * @param {number} userId - 用户 ID
 * @param {object} activity - 活动对象
 * @param {object} [options]
 * @param {Set}    [options.deliveredInboxes] - 跨调用共享的已投递 inbox 集合
 * @param {boolean} [options.skipDedup=false] - 跳过持久化去重
 */
export async function deliverToFollowers(userId, activity, options = {}) {
    const { deliveredInboxes = null, skipDedup = false } = options;

    const user = await getLocalUserById(userId);
    if (!user) {
        logger.warn(`[ap-delivery] 找不到用户 ${userId}, 跳过发送`);
        return;
    }

    const followers = await getRemoteFollowers(userId);
    if (followers.length === 0) {
        logger.debug(`[ap-delivery] 用户 ${userId} 没有远程关注者`);
        return;
    }

    // 按收件箱去重（共享收件箱优化）
    const inboxSet = new Map();
    for (const follower of followers) {
        // 尝试用共享收件箱
        let inbox = follower.inbox;
        try {
            const actor = await fetchRemoteActor(follower.actorUrl);
            if (actor) {
                inbox = getSharedInboxUrl(actor) || inbox;
            }
        } catch { /* 使用原始 inbox */ }

        if (inbox && !inboxSet.has(inbox)) {
            // 内存级跨调用去重：如果这个域已经投递过就跳过
            const domain = extractDomain(inbox);
            if (deliveredInboxes && deliveredInboxes.has(domain)) {
                logger.debug(`[ap-delivery] 跳过域 ${domain} (跨用户去重)`);
                continue;
            }
            inboxSet.set(inbox, true);
        }
    }

    logger.info(`[ap-delivery] 为用户 ${userId} 发送到 ${inboxSet.size} 个不同收件箱`);

    // 并发投递（限制并发数）
    const inboxes = [...inboxSet.keys()];
    const CONCURRENCY = 5;

    for (let i = 0; i < inboxes.length; i += CONCURRENCY) {
        const batch = inboxes.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
            batch.map(inbox =>
                deliverActivity({
                    inbox,
                    activity,
                    userId: user.id,
                    username: user.username,
                    skipDedup,
                    deliveredInboxes,
                })
            )
        );
    }
}

/**
 * 向特定 Actor 投递活动
 * @param {number} userId - 发送者用户 ID
 * @param {string} targetActorUrl - 目标 Actor URL
 * @param {object} activity - 活动对象
 * @param {object} [options]
 * @param {Set}    [options.deliveredInboxes] - 共享去重集合
 */
export async function deliverToActor(userId, targetActorUrl, activity, options = {}) {
    const { deliveredInboxes = null } = options;

    const user = await getLocalUserById(userId);
    if (!user) return false;

    const actor = await fetchRemoteActor(targetActorUrl);
    if (!actor || !actor.inbox) {
        logger.warn(`[ap-delivery] 无法为 ${targetActorUrl} 解析收件箱`);
        return false;
    }

    return deliverActivity({
        inbox: actor.inbox,
        activity,
        userId: user.id,
        username: user.username,
        deliveredInboxes,
    });
}

// ── 辅助 ────────────────────────────────────────────

function extractDomain(inbox) {
    try {
        return new URL(inbox).host;
    } catch {
        return inbox;
    }
}
