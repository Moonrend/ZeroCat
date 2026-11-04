/**
 * ActivityPub 发件箱和帖子同步
 * 处理本地帖子事件并生成对应的 AP 活动，投递到远程服务器
 */

import { prisma } from '../prisma.js';
import logger from '../logger.js';
import { visibleWhere, assertCanWrite } from '../moderation/visibility.js';
import { isFederationEnabled, getApEndpointBaseUrl } from './config.js';
import { getLocalUserById, getActorUrl } from './actor.js';
import {
    postToNote, buildCreateActivity, buildDeleteActivity,
    buildLikeActivity, buildUndoActivity, buildAnnounceActivity,
    getNoteId,
    buildOrderedCollection, buildOrderedCollectionPage,
} from './objects.js';
import { setPostApRef, getPostApId } from './store.js';
import { deliverToFollowers, deliverActivity } from './delivery.js';
import { fetchRemoteActor, getSharedInboxUrl } from './federation.js';

/**
 * 确保指定帖子已同步到 ActivityPub（有 AP ref），没有则立即同步
 * 用于回帖/引用/转推时先确保主贴已发布到联邦网络
 * @param {number} refPostId - 被引用/回复/转推的帖子 ID
 * @param {Set} [deliveredInboxes] - 共享去重集合
 * @returns {Promise<string|null>} 帖子的 AP Note ID
 */
async function ensurePostSynced(refPostId, deliveredInboxes = null) {
    if (!refPostId) return null;

    const visible = await prisma.ow_posts.findFirst({ where: { id: refPostId, AND: [await visibleWhere('post')] } });
    if (!visible) return null;
    await assertCanWrite(visible.author_id, 'posts', 'sync');
    // 已有 AP ref，直接返回
    const existingApId = await getPostApId(refPostId);
    if (existingApId) return existingApId;

    // 查询帖子
    const refPost = await prisma.ow_posts.findUnique({
        where: { id: refPostId },
        include: {
            author: { select: { id: true, username: true, display_name: true } },
        },
    });

    if (!refPost || refPost.is_deleted || !refPost.author) return null;

    // 构建 Note 并投递
    const note = await postToNote(refPost);
    if (!note) return null;

    // 先写入 AP ref，防止并发重复投递（乐观锁）
    await setPostApRef(refPostId, note.id, note.url);

    // 再次确认没有被并发抢先（double-check）
    const recheck = await getPostApId(refPostId);
    if (recheck && recheck !== note.id) {
        // 被另一个并发请求先写入了，直接返回
        return recheck;
    }

    const actorUrl = await getActorUrl(refPost.author.username);
    const activity = await buildCreateActivity(actorUrl, note);
    await deliverToFollowers(refPost.author_id, activity, { deliveredInboxes });

    logger.info(`[ap-outbox] 依赖帖子 #${refPostId} 已同步为 Create(Note)`);
    return note.id;
}

/**
 * 处理帖子社交同步事件（ActivityPub 方向）
 * 与现有 socialSync 系统集成，作为一个额外的同步目标
 * @param {object} opts
 * @param {number} opts.actorUserId - 触发事件的用户 ID
 * @param {number} opts.postId - 帖子 ID
 * @param {string} opts.eventType - 事件类型 (create/delete/like/unlike/retweet/unretweet 等)
 */
export async function syncPostToActivityPub({ actorUserId, postId, eventType }) {
    // 检查联邦是否启用
    const enabled = await isFederationEnabled();
    if (!enabled) return;

    try {
        await assertCanWrite(Number(actorUserId), 'posts', 'sync');
        if (eventType !== 'delete') {
            const current = await prisma.ow_posts.findFirst({ where: { id: Number(postId), AND: [await visibleWhere('post')] } });
            if (!current) return;
            if (['create', 'reply', 'quote', 'retweet'].includes(eventType) && current.author_id !== Number(actorUserId)) return;
        }
        switch (eventType) {
            case 'create':
            case 'reply':
            case 'quote':
                await handlePostCreate(actorUserId, postId);
                break;
            case 'delete':
                await handlePostDelete(actorUserId, postId);
                break;
            case 'like':
                await handlePostLike(actorUserId, postId);
                break;
            case 'unlike':
                await handlePostUnlike(actorUserId, postId);
                break;
            case 'retweet':
                await handlePostRetweet(actorUserId, postId);
                break;
            case 'unretweet':
                await handlePostUnretweet(actorUserId, postId);
                break;
            default:
                logger.debug(`[ap-outbox] 未处理的事件类型: ${eventType}`);
        }
    } catch (err) {
        logger.error(`[ap-outbox] 同步帖子 ${postId} (${eventType}) 错误:`, err.message);
    }
}

/**
 * 处理帖子创建 → 生成 Create(Note) 活动并投递
 * 使用共享 deliveredInboxes 防止同一活动重复投递到同一服务器
 */
async function handlePostCreate(userId, postId) {
    const post = await prisma.ow_posts.findUnique({
        where: { id: postId },
        include: {
            author: { select: { id: true, username: true, display_name: true } },
        },
    });

    if (!post || post.is_deleted) return;

    // 防御性检查：如果是转推帖子，应走 Announce 流程而非 Create(Note)
    if (post.post_type === 'retweet' && post.retweet_post_id) {
        logger.debug(`[ap-outbox] 帖子 #${postId} 是转推，转发到 handlePostRetweet`);
        return await handlePostRetweet(userId, postId);
    }

    // 确保被回复/引用的主贴已同步到联邦网络
    // 注意：依赖帖子和当前帖子是不同 activity，不能共享去重集合，
    // 否则会把当前回帖误判为已投递而被跳过。
    if (post.in_reply_to_id) {
        await ensurePostSynced(post.in_reply_to_id);
    }
    if (post.quoted_post_id) {
        await ensurePostSynced(post.quoted_post_id);
    }

    // 本轮投递的共享去重集合（仅用于当前 activity 的多目标投递）
    const deliveredInboxes = new Set();

    // 构建 Note 对象
    const note = await postToNote(post);
    if (!note) return;

    // 在帖子的 platform_refs 中记录 AP ID
    await setPostApRef(postId, note.id, note.url);

    // 构建 Create 活动
    const actorUrl = await getActorUrl(post.author.username);
    const activity = await buildCreateActivity(actorUrl, note);

    // 投递到回帖作者自己的远程关注者
    await deliverToFollowers(userId, activity, { deliveredInboxes });

    // 如果是回帖或引用帖，还要投递到被回复/引用帖子作者的远程关注者
    // 使用同一个 deliveredInboxes 集合，避免向已投递的服务器重复发送
    const relatedAuthorIds = new Set();
    if (post.in_reply_to_id) {
        const parentPost = await prisma.ow_posts.findUnique({
            where: { id: post.in_reply_to_id },
            select: { author_id: true },
        });
        if (parentPost && parentPost.author_id !== userId) {
            relatedAuthorIds.add(parentPost.author_id);
        }
    }
    if (post.quoted_post_id) {
        const quotedPost = await prisma.ow_posts.findUnique({
            where: { id: post.quoted_post_id },
            select: { author_id: true },
        });
        if (quotedPost && quotedPost.author_id !== userId) {
            relatedAuthorIds.add(quotedPost.author_id);
        }
    }
    for (const authorId of relatedAuthorIds) {
        await deliverToFollowers(authorId, activity, { deliveredInboxes });
    }

    logger.info(`[ap-outbox] 帖子 #${postId} 已作为 Create(Note) 发送到 ${deliveredInboxes.size} 个服务器`);
}

/**
 * 处理帖子删除 → 生成 Delete 活动
 */
async function handlePostDelete(userId, postId) {
    const user = await getLocalUserById(userId);
    if (!user) return;

    const noteId = await getNoteId(postId);
    const actorUrl = await getActorUrl(user.username);
    const activity = await buildDeleteActivity(actorUrl, noteId);

    await deliverToFollowers(userId, activity);
    logger.info(`[ap-outbox] 帖子 #${postId} 已作为 Delete 发送`);
}

/**
 * 处理帖子点赞 → 生成 Like 活动
 */
async function handlePostLike(userId, postId) {
    const user = await getLocalUserById(userId);
    if (!user) return;

    // 获取被点赞帖子的 AP ID
    const noteId = await getPostApId(postId) || await getNoteId(postId);
    const actorUrl = await getActorUrl(user.username);
    const activity = await buildLikeActivity(actorUrl, noteId);

    // Like 只需要投递给帖子作者
    const post = await prisma.ow_posts.findUnique({
        where: { id: postId },
        select: { author_id: true },
    });

    if (post) {
        // 如果是本地用户的帖子，只需记录；如果有 AP 引用则可投递
        await deliverToFollowers(userId, activity);
    }

    logger.debug(`[ap-outbox] 帖子 #${postId} 的点赞已发送`);
}

/**
 * 处理取消点赞 → 生成 Undo(Like) 活动
 */
async function handlePostUnlike(userId, postId) {
    const user = await getLocalUserById(userId);
    if (!user) return;

    const noteId = await getPostApId(postId) || await getNoteId(postId);
    const actorUrl = await getActorUrl(user.username);
    const likeActivity = await buildLikeActivity(actorUrl, noteId);
    const activity = await buildUndoActivity(actorUrl, likeActivity);

    await deliverToFollowers(userId, activity);
    logger.debug(`[ap-outbox] 帖子 #${postId} 的取消点赞(Undo) 已发送`);
}

/**
 * 处理转推 → 生成 Announce 活动
 */
async function handlePostRetweet(userId, postId) {
    // 获取转推指向的原帖
    const post = await prisma.ow_posts.findUnique({
        where: { id: postId },
        select: { retweet_post_id: true },
    });

    if (!post?.retweet_post_id) return;
    if (!await prisma.ow_posts.findFirst({ where: { id: post.retweet_post_id, AND: [await visibleWhere('post')] }, select: { id: true } })) return;

    const user = await getLocalUserById(userId);
    if (!user) return;

    // 确保原帖已同步到联邦网络
    await ensurePostSynced(post.retweet_post_id);

    const originalNoteId = await getPostApId(post.retweet_post_id)
        || await getNoteId(post.retweet_post_id);
    const actorUrl = await getActorUrl(user.username);
    const activity = await buildAnnounceActivity(actorUrl, originalNoteId);

    await deliverToFollowers(userId, activity);
    logger.info(`[ap-outbox] 帖子 #${postId} 已作为 Announce 发送`);
}

/**
 * 处理取消转推 → 生成 Undo(Announce) 活动
 */
async function handlePostUnretweet(userId, postId) {
    // 获取转推指向的原帖
    const post = await prisma.ow_posts.findUnique({
        where: { id: postId },
        select: { retweet_post_id: true },
    });

    if (!post?.retweet_post_id) return;
    if (!await prisma.ow_posts.findFirst({ where: { id: post.retweet_post_id, AND: [await visibleWhere('post')] }, select: { id: true } })) return;

    const user = await getLocalUserById(userId);
    if (!user) return;

    const originalNoteId = await getPostApId(post.retweet_post_id)
        || await getNoteId(post.retweet_post_id);
    const actorUrl = await getActorUrl(user.username);

    // 构建 Announce 活动（作为 Undo 的 object）
    const announceActivity = await buildAnnounceActivity(actorUrl, originalNoteId);
    // 构建 Undo(Announce)
    const activity = await buildUndoActivity(actorUrl, announceActivity);

    await deliverToFollowers(userId, activity);
    logger.info(`[ap-outbox] 帖子 #${postId} 的转推已撤销 (Undo Announce)`);
}

/**
 * 构建用户的 Outbox 集合
 * @param {string} username
 * @param {number} page - 页码 (0 表示返回集合概览)
 * @param {number} pageSize
 */
export async function buildUserOutbox(username, page = 0, pageSize = 20) {
    const apBaseUrl = await getApEndpointBaseUrl();
    const outboxUrl = `${apBaseUrl}/ap/users/${username}/outbox`;

    const user = await prisma.ow_users.findFirst({
        where: { username, status: 'active', AND: [await visibleWhere('profile')] },
        select: { id: true },
    });

    if (!user) return null;

    if (page === 0) {
        const totalItems = await prisma.ow_posts.count({
            where: {
                author_id: user.id,
                is_deleted: false,
                AND: [await visibleWhere('post')],
                post_type: { in: ['normal', 'reply', 'quote', 'retweet'] },
            },
        });
        return buildOrderedCollection(outboxUrl, totalItems, `${outboxUrl}?page=1`);
    }

    // 获取帖子列表（含转推）
    const posts = await prisma.ow_posts.findMany({
        where: {
            author_id: user.id,
            is_deleted: false,
            AND: [await visibleWhere('post')],
            post_type: { in: ['normal', 'reply', 'quote', 'retweet'] },
        },
        include: {
            author: { select: { id: true, username: true, display_name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: pageSize,
        skip: (page - 1) * pageSize,
    });

    // Recheck referenced originals together and load their AP IDs in the same query.
    const retweetIds = [...new Set(posts.filter(post => post.post_type === 'retweet' && post.retweet_post_id)
        .map(post => post.retweet_post_id))];
    const originals = retweetIds.length ? await prisma.ow_posts.findMany({
        where: { id: { in: retweetIds }, AND: [await visibleWhere('post')] },
        select: { id: true, platform_refs: true },
    }) : [];
    const originalById = new Map(originals.map(post => [post.id, post]));

    // 转换为 AP 活动
    const actorUrl = await getActorUrl(username);
    const items = [];
    for (const post of posts) {
        if (post.post_type === 'retweet' && post.retweet_post_id) {
            const original = originalById.get(post.retweet_post_id);
            if (!original) continue;
            // 转推 → Announce 活动
            const originalNoteId = original.platform_refs?.activitypub?.id
                || await getNoteId(post.retweet_post_id);
            const activity = await buildAnnounceActivity(actorUrl, originalNoteId);
            items.push(activity);
        } else {
            // 普通帖子/回帖/引用 → Create(Note)
            const note = await postToNote(post);
            if (note) {
                const activity = await buildCreateActivity(actorUrl, note);
                items.push(activity);
            }
        }
    }

    const nextPage = posts.length === pageSize ? `${outboxUrl}?page=${page + 1}` : null;
    const prevPage = page > 1 ? `${outboxUrl}?page=${page - 1}` : null;

    return buildOrderedCollectionPage(
        `${outboxUrl}?page=${page}`,
        outboxUrl,
        items,
        nextPage,
        prevPage,
    );
}

/**
 * 向新关注者推送用户的所有历史帖子
 * 由 BullMQ 任务调用，避免阻塞收件箱请求
 * 使用持久化去重：如果 activity 已投递给该服务器则跳过
 * @param {object} opts
 * @param {number} opts.userId - 被关注用户 ID
 * @param {string} opts.followerActorUrl - 新关注者的 Actor URL
 */
export async function backfillPostsToFollower({ userId, followerActorUrl }) {
    await assertCanWrite(Number(userId), 'posts', 'sync');
    const enabled = await isFederationEnabled();
    if (!enabled) return;

    const user = await getLocalUserById(userId);
    if (!user) {
        logger.warn(`[ap-backfill] 找不到用户 ${userId}`);
        return;
    }

    // 获取关注者的收件箱
    const actor = await fetchRemoteActor(followerActorUrl);
    if (!actor) {
        logger.warn(`[ap-backfill] 无法获取 actor: ${followerActorUrl}`);
        return;
    }
    const inbox = getSharedInboxUrl(actor) || actor.inbox;
    if (!inbox) {
        logger.warn(`[ap-backfill] 找不到收件箱: ${followerActorUrl}`);
        return;
    }

    // 查询用户的所有公开帖子（按时间正序，让对方按发布顺序收到）
    const posts = await prisma.ow_posts.findMany({
        where: {
            author_id: userId,
            is_deleted: false,
            AND: [await visibleWhere('post')],
            post_type: { in: ['normal', 'reply', 'quote'] },
        },
        include: {
            author: { select: { id: true, username: true, display_name: true } },
        },
        orderBy: { created_at: 'asc' },
        take: 200, // 限制最多推送 200 条
    });

    if (posts.length === 0) {
        logger.debug(`[ap-backfill] 没有为用户 ${userId} 回填的帖子`);
        return;
    }

    logger.info(`[ap-backfill] 正在向 ${followerActorUrl} 回填 ${posts.length} 篇来自 ${user.username} 的帖子`);

    const actorUrl = await getActorUrl(user.username);
    let delivered = 0;
    let skipped = 0;

    for (const post of posts) {
        try {
            const note = await postToNote(post);
            if (!note) continue;

            // 确保帖子有 AP 引用
            await setPostApRef(post.id, note.id, note.url);

            const activity = await buildCreateActivity(actorUrl, note);

            // 持久化去重：已发送过的帖子不再投递
            const ok = await deliverActivity({
                inbox,
                activity,
                userId: user.id,
                username: user.username,
                // 不跳过去重 — 如果该帖子已通过实时投递发送过，回填时自动跳过
            });
            if (ok) delivered++;

            // 每条之间短暂延迟，避免淹没远程服务器
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            logger.warn(`[ap-backfill] 无法回填帖子 #${post.id}:`, err.message);
        }
    }

    logger.info(`[ap-backfill] 回填完成: ${delivered}/${posts.length} 篇帖子已发送给 ${followerActorUrl}`);
}
