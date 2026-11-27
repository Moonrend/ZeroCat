/**
 * ActivityPub 收件箱处理
 * 处理从远程服务器接收到的各种活动
 */

import logger from '../logger.js';
import { prisma } from '../prisma.js';
import { getInstanceBaseUrl, getInstanceDomain, isAutoAcceptFollows } from './config.js';
import { fetchRemoteActor } from './federation.js';
import { verifySignature, verifyDigest, parseSignatureHeader } from './httpSignature.js';
import { getKeyDocumentUrl, validateActorKeyBinding, validateActivityActorBinding } from './identityBinding.js';
import { getLocalUserByUsername, buildActorObject, getActorUrl } from './actor.js';
import {
    addRemoteFollower, removeRemoteFollower, isRemoteFollower,
    storeActivity, getActivity,
} from './store.js';
import {
    buildAcceptActivity, buildRejectActivity,
} from './objects.js';
import { deliverToActor } from './delivery.js';
import { isActorAllowed } from './federationConfig.js';
import { handleIncomingNote, handleIncomingAnnounce, handleIncomingLike, handleIncomingUndoLike, handleIncomingDelete } from './remotePosts.js';
import { handleFollowAccepted, handleFollowRejected } from './followSync.js';
import { ensureProxyUser } from './remoteUser.js';

/**
 * 验证收件箱请求的 HTTP Signature
 * @param {import('express').Request} req
 * @returns {{ valid: boolean, actor: object|null, message: string }}
 */
export async function verifyInboxRequest(req) {
    const signatureHeader = req.headers.signature;
    if (!signatureHeader) {
        return { valid: false, actor: null, message: 'Missing Signature header' };
    }

    // 解析 signature 获取 keyId
    const parsed = parseSignatureHeader(signatureHeader);
    if (!parsed) {
        return { valid: false, actor: null, message: 'Invalid Signature header format' };
    }

    // 验证 digest（如果存在）
    if (req.headers.digest) {
        // 优先使用 rawBody（原始字节），回退到序列化 body
        const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || ''));
        if (!verifyDigest(req.headers.digest, rawBody)) {
            return { valid: false, actor: null, message: 'Digest verification failed' };
        }
    }

    // 通过 keyId 获取远程 Actor 和公钥
    const actorUrl = getKeyDocumentUrl(parsed.keyId);
    if (!actorUrl) {
        return { valid: false, actor: null, message: 'Signature keyId is not a valid HTTP URL' };
    }

    const actor = await fetchRemoteActor(actorUrl, true);
    if (!actor) {
        return { valid: false, actor: null, message: `Could not fetch actor: ${actorUrl}` };
    }

    const actorBinding = validateActorKeyBinding({
        actor,
        keyId: parsed.keyId,
        localBaseUrl: await getInstanceBaseUrl(),
    });
    if (!actorBinding.valid) {
        return { valid: false, actor: null, message: actorBinding.message };
    }

    // 验证签名
    // 反代场景下，host 头会被改为后端地址，直接使用配置的前端域名还原
    const headersForVerify = { ...req.headers };
    const frontendDomain = await getInstanceDomain();
    if (frontendDomain && headersForVerify.host !== frontendDomain) {
        logger.debug(`[ap-inbox] 还原 host 为前端域名: ${frontendDomain} (当前 host: ${headersForVerify.host})`);
        headersForVerify.host = frontendDomain;
    }

    const isValid = verifySignature({
        signature: signatureHeader,
        method: req.method,
        path: req.originalUrl || req.url,
        headers: headersForVerify,
        publicKey: actorBinding.publicKeyPem,
    });

    if (!isValid) {
        return { valid: false, actor: null, message: 'Signature verification failed' };
    }

    const activityBinding = validateActivityActorBinding(req.body, actorBinding.actorId);
    if (!activityBinding.valid) {
        return { valid: false, actor: null, message: activityBinding.message };
    }

    const verifiedActor = {
        ...actor,
        id: actorBinding.actorId,
        publicKey: {
            ...actor.publicKey,
            id: actorBinding.keyId,
            owner: actorBinding.actorId,
        },
    };
    return { valid: true, actor: verifiedActor, message: 'OK' };
}

/**
 * 处理收件箱中的活动
 * @param {object} activity 活动对象
 * @param {object} remoteActor 发送者的 Actor 对象
 * @param {string} [targetUsername] 如果是用户收件箱，传入用户名
 */
export async function processInboxActivity(activity, remoteActor, targetUsername = null) {
    const type = activity.type;

    const identityBinding = validateActivityActorBinding(activity, remoteActor?.id);
    if (!identityBinding.valid) {
        logger.warn(`[ap-inbox] 拒绝身份不匹配的 ${type || 'unknown'} 活动: ${identityBinding.message}`);
        return { handled: false, error: identityBinding.message, type };
    }

    logger.info(`[ap-inbox] 正在处理来自 ${remoteActor?.id || 'unknown'} 的 ${type} 活动`);

    // 检查远程实例是否被允许
    const allowed = await isActorAllowed(remoteActor?.id);
    if (!allowed) {
        logger.warn(`[ap-inbox] 拒绝来自非允许实例的活动: ${remoteActor?.id}`);
        return { handled: false, error: 'Instance not allowed', type };
    }

    switch (type) {
        case 'Follow':
            return handleFollow(activity, remoteActor, targetUsername);
        case 'Undo':
            return handleUndo(activity, remoteActor, targetUsername);
        case 'Create':
            return handleCreate(activity, remoteActor, targetUsername);
        case 'Delete':
            return handleDelete(activity, remoteActor);
        case 'Like':
            return handleLike(activity, remoteActor);
        case 'Announce':
            return handleAnnounce(activity, remoteActor);
        case 'Update':
            return handleUpdate(activity, remoteActor);
        case 'Accept':
            return handleAccept(activity, remoteActor);
        case 'Reject':
            return handleReject(activity, remoteActor);
        default:
            logger.info(`[ap-inbox] 未处理的活动类型: ${type}`);
            return { handled: false, type };
    }
}

/**
 * 处理 Follow 活动
 */
async function handleFollow(activity, remoteActor, targetUsername) {
    const targetActorUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!targetActorUrl) {
        logger.warn('[ap-inbox] Follow 活动缺少 object 字段');
        return { handled: false, error: 'Missing object' };
    }

    // 从目标 URL 中提取用户名
    const baseUrl = await getInstanceBaseUrl();
    const usernameMatch = targetActorUrl.match(/\/ap\/users\/([^/]+)$/);
    const username = usernameMatch ? usernameMatch[1] : targetUsername;

    if (!username) {
        logger.warn('[ap-inbox] 无法从 Follow 活动中确定目标用户');
        return { handled: false, error: 'Cannot determine target user' };
    }

    const localUser = await getLocalUserByUsername(username);
    if (!localUser) {
        logger.warn(`[ap-inbox] Follow 目标用户未找到: ${username}`);
        return { handled: false, error: 'User not found' };
    }

    // 获取 follower 的信息
    const followerInbox = remoteActor.inbox;
    if (!followerInbox) {
        logger.warn('[ap-inbox] 关注者没有收件箱');
        return { handled: false, error: 'Follower has no inbox' };
    }

    // 存储活动记录
    if (activity.id) {
        await storeActivity(activity.id, JSON.stringify({
            type: 'Follow',
            actor: remoteActor.id,
            target: username,
            receivedAt: new Date().toISOString(),
        }));
    }

    // 添加远程关注者
    await addRemoteFollower(localUser.id, remoteActor.id, followerInbox);
    logger.info(`[ap-inbox] 远程关注者已添加: ${remoteActor.id} -> ${username}`);

    // 是否自动接受
    const autoAccept = await isAutoAcceptFollows();
    if (autoAccept) {
        const localActorUrl = await getActorUrl(username);
        const acceptActivity = await buildAcceptActivity(localActorUrl, activity);

        // 通过 BullMQ 队列异步投递 Accept
        try {
            const { default: queueManager } = await import('../queue/queueManager.js');
            await queueManager.enqueueApDeliver(
                remoteActor.inbox,
                acceptActivity,
                localUser.id,
                username
            );
        } catch (err) {
            // 降级：直接投递
            logger.warn('[ap-inbox] 无法入队 Accept 投递，降级为直接投递:', err.message);
            deliverToActor(localUser.id, remoteActor.id, acceptActivity).catch(e => {
                logger.error('[ap-inbox] 发送 Accept 失败:', e.message);
            });
        }

        // 通过 BullMQ 任务队列异步推送历史帖子给新关注者
        try {
            const { default: queueManager } = await import('../queue/queueManager.js');
            await queueManager.enqueueApBackfill(localUser.id, remoteActor.id);
            logger.info(`[ap-inbox] 已为 ${username} -> ${remoteActor.id} 排队回填作业`);
        } catch (err) {
            logger.error('[ap-inbox] 无法排队回填作业:', err.message);
        }
    }

    return { handled: true, type: 'Follow', autoAccepted: autoAccept };
}

/**
 * 处理 Undo 活动
 */
async function handleUndo(activity, remoteActor, targetUsername) {
    const inner = typeof activity.object === 'string' ? { id: activity.object } : activity.object;
    if (!inner) return { handled: false, error: 'Missing inner object' };

    const innerType = inner.type;

    if (innerType === 'Follow') {
        // 撤销关注
        const targetActorUrl = typeof inner.object === 'string' ? inner.object : inner.object?.id;
        const baseUrl = await getInstanceBaseUrl();
        const usernameMatch = targetActorUrl?.match(/\/ap\/users\/([^/]+)$/);
        const username = usernameMatch ? usernameMatch[1] : targetUsername;

        if (!username) return { handled: false, error: 'Cannot determine target user' };

        const localUser = await getLocalUserByUsername(username);
        if (!localUser) return { handled: false, error: 'User not found' };

        await removeRemoteFollower(localUser.id, remoteActor.id);
        logger.info(`[ap-inbox] 远程关注者已移除: ${remoteActor.id} -> ${username}`);

        return { handled: true, type: 'Undo:Follow' };
    }

    if (innerType === 'Like') {
        logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的取消点赞 (Undo Like)`);
        // 取消远程点赞记录
        const likeObjectId = typeof inner.object === 'string' ? inner.object : inner.object?.id;
        if (likeObjectId) {
            await handleIncomingUndoLike(likeObjectId, remoteActor);
        }
        return { handled: true, type: 'Undo:Like' };
    }

    if (innerType === 'Announce') {
        logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的取消转发 (Undo Announce)`);
        return { handled: true, type: 'Undo:Announce' };
    }

    logger.info(`[ap-inbox] 未处理的取消内部类型: ${innerType}`);
    return { handled: false, type: `Undo:${innerType}` };
}

/**
 * 处理 Create 活动（远程帖子到达）
 * 增强版：创建本地代理帖子记录
 */
async function handleCreate(activity, remoteActor, targetUsername) {
    const object = activity.object;
    if (!object) return { handled: false, error: 'Missing object' };

    const objectType = typeof object === 'string' ? 'Reference' : (object.type || 'Unknown');

    if (objectType === 'Note' || objectType === 'Article') {
        logger.info(`[ap-inbox] 接收到远程 ${objectType} 来自 ${remoteActor.id}: ${object.id || 'no-id'}`);

        // 存储活动引用
        if (activity.id) {
            await storeActivity(activity.id, JSON.stringify({
                type: 'Create',
                objectType,
                objectId: object.id,
                actor: remoteActor.id,
                content: object.content?.substring(0, 500),
                inReplyTo: object.inReplyTo,
                receivedAt: new Date().toISOString(),
            }));
        }

        // 导入为本地帖子（通过代理用户）
        const importedPost = await handleIncomingNote(object, remoteActor);

        // 检查是否是对本地帖子的回复
        if (object.inReplyTo) {
            await handleRemoteReply(object, remoteActor);
        }

        return { handled: true, type: 'Create:Note', postId: importedPost?.id };
    }

    logger.info(`[ap-inbox] 未处理的 Create 对象类型: ${objectType}`);
    return { handled: false, type: `Create:${objectType}` };
}

/**
 * 处理远程回复（对本地帖子的回复）
 */
async function handleRemoteReply(noteObject, remoteActor) {
    const inReplyTo = noteObject.inReplyTo;
    if (!inReplyTo) return;

    const baseUrl = await getInstanceBaseUrl();

    // 检查被回复的是否为本地帖子
    const noteIdMatch = inReplyTo.match(/\/ap\/notes\/(\d+)$/);
    if (!noteIdMatch) return;

    const localPostId = parseInt(noteIdMatch[1], 10);
    if (isNaN(localPostId)) return;

    // 验证本地帖子存在
    const localPost = await prisma.ow_posts.findUnique({
        where: { id: localPostId },
        select: { id: true, author_id: true },
    });

    if (!localPost) return;

    logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的远程回复到本地帖子 #${localPostId}`);

    // 存储远程回复记录（可用于显示联邦回复）
    await storeActivity(`reply:${noteObject.id}`, JSON.stringify({
        type: 'RemoteReply',
        localPostId,
        remoteNoteId: noteObject.id,
        remoteActorId: remoteActor.id,
        remoteActorName: remoteActor.preferredUsername || remoteActor.name,
        content: noteObject.content?.substring(0, 1000),
        published: noteObject.published,
        receivedAt: new Date().toISOString(),
    }));
}

/**
 * 处理 Delete 活动
 */
async function handleDelete(activity, remoteActor) {
    const objectId = typeof activity.object === 'string'
        ? activity.object
        : activity.object?.id;

    if (objectId) {
        logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的删除活动: ${objectId}`);
        // 清理相关的活动记录
        await storeActivity(`deleted:${objectId}`, JSON.stringify({
            deletedAt: new Date().toISOString(),
            actor: remoteActor.id,
        }));

        // 标记对应的本地代理帖子为已删除
        await handleIncomingDelete(objectId, remoteActor);
    }

    return { handled: true, type: 'Delete' };
}

/**
 * 处理 Like 活动
 */
async function handleLike(activity, remoteActor) {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (objectId) {
        logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的点赞活动: ${objectId}`);

        // 创建远程点赞记录（代理用户点赞本地帖子）
        await handleIncomingLike(objectId, remoteActor);
    }

    return { handled: true, type: 'Like' };
}

/**
 * 处理 Announce (boost) 活动
 */
async function handleAnnounce(activity, remoteActor) {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (objectId) {
        logger.info(`[ap-inbox] 来自 ${remoteActor.id} 的转发 (Announce) 活动: ${objectId}`);

        // 创建远程转推记录
        await handleIncomingAnnounce(objectId, remoteActor, activity);
    }

    return { handled: true, type: 'Announce' };
}

/**
 * 处理 Update 活动
 */
async function handleUpdate(activity, remoteActor) {
    const object = activity.object;
    if (!object) return { handled: false, error: 'Missing object' };

    // 如果是 Actor 更新，刷新缓存并更新代理用户
    if (object.type === 'Person' || object.type === 'Service' || object.type === 'Application') {
        const updatedActor = await fetchRemoteActor(object.id || remoteActor.id, true);
        // 同步更新代理用户信息
        if (updatedActor) {
            try {
                await ensureProxyUser(object.id || remoteActor.id, updatedActor);
            } catch (err) {
                logger.debug(`[ap-inbox] 更新代理用户失败:`, err.message);
            }
        }
        logger.info(`[ap-inbox] Actor 已更新: ${object.id || remoteActor.id}`);
    }

    return { handled: true, type: 'Update' };
}

/**
 * 处理 Accept 活动（对我们发出的 Follow 的回应）
 */
async function handleAccept(activity, remoteActor) {
    const inner = typeof activity.object === 'string' ? { id: activity.object } : activity.object;
    logger.info(`[ap-inbox] 接受来自 ${remoteActor.id} 的活动: ${inner?.type || '未知'}`);

    // 处理远端接受关注请求
    await handleFollowAccepted(activity, remoteActor);

    return { handled: true, type: 'Accept' };
}

/**
 * 处理 Reject 活动
 */
async function handleReject(activity, remoteActor) {
    const inner = typeof activity.object === 'string' ? { id: activity.object } : activity.object;
    logger.info(`[ap-inbox] 拒绝来自 ${remoteActor.id} 的活动: ${inner?.type || '未知'}`);

    // 处理远端拒绝关注请求
    await handleFollowRejected(activity, remoteActor);

    return { handled: true, type: 'Reject' };
}
