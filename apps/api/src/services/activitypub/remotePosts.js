/**
 * 远程帖子拉取与同步服务
 * 主动拉取远程用户的帖子，处理提及、转推等引用的远程内容
 */

import { prisma } from '../prisma.js';
import logger from '../logger.js';
import { visibleWhere } from '../moderation/visibility.js';
import { AP_ACCEPT_TYPES, getInstanceDomain, getApEndpointBaseUrl } from './config.js';
import { fetchRemoteActor, resolveWebFinger } from './federation.js';
import { ensureProxyUser, findProxyUserByActorUrl, getRemoteUserInfo, REMOTE_USER_TYPE } from './remoteUser.js';
import { isActorAllowed } from './federationConfig.js';
import { federationGet } from './federationHttp.js';
import { upsertTargetConfig, getTargetConfig } from './store.js';

// target_type for remote posts
const REMOTE_POST_TARGET_TYPE = 'ap_remote_post';
const AP_FETCH_TIMEOUT = 15000;
const AP_FETCH_REDIRECT_LIMIT = 6;

function normalizeHttpUrl(rawUrl, baseUrl = null) {
    const input = String(rawUrl || '').trim();
    if (!input) return null;

    try {
        let normalizedInput = input;
        if (/^\/\//.test(normalizedInput)) {
            normalizedInput = `https:${normalizedInput}`;
        }

        const parsed = baseUrl
            ? new URL(normalizedInput, baseUrl)
            : new URL(normalizedInput);

        parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
        return parsed.toString();
    } catch {
        return null;
    }
}

function inferRemoteDomainFromNote(note) {
    const candidates = [
        typeof note?.attributedTo === 'string' ? note.attributedTo : note?.attributedTo?.id,
        typeof note?.id === 'string' ? note.id : null,
        typeof note?.url === 'string' ? note.url : note?.url?.href,
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const host = new URL(candidate).host;
            if (host) return host;
        } catch {
            continue;
        }
    }

    return null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMentionName(name, fallbackDomain) {
    const raw = String(name || '').trim();
    if (!raw) return null;

    const withAt = raw.startsWith('@') ? raw : `@${raw}`;
    const fullMatch = withAt.match(/^@([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/);
    if (fullMatch) {
        return {
            short: fullMatch[1],
            full: `@${fullMatch[1]}@${fullMatch[2]}`,
            domain: fullMatch[2],
            hasDomain: true,
        };
    }

    const shortMatch = withAt.match(/^@([a-zA-Z0-9_.-]+)$/);
    if (shortMatch && fallbackDomain) {
        return {
            short: shortMatch[1],
            full: `@${shortMatch[1]}@${fallbackDomain}`,
            domain: fallbackDomain,
            hasDomain: false,
        };
    }

    return null;
}

function buildMentionAliasMap(note, fallbackDomain) {
    const mentionTags = Array.isArray(note?.tag)
        ? note.tag.filter(tag => tag?.type === 'Mention')
        : [];

    const map = new Map();
    for (const tag of mentionTags) {
        const normalized = normalizeMentionName(tag?.name, fallbackDomain);
        if (!normalized || normalized.hasDomain) continue;
        map.set(normalized.short, normalized.full);
    }
    return map;
}

function rewriteShortMentionsToFedi(content, mentionAliasMap) {
    if (!content || !(mentionAliasMap instanceof Map) || mentionAliasMap.size === 0) {
        return content;
    }

    let rewritten = content;
    const entries = [...mentionAliasMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [shortName, fullMention] of entries) {
        const mentionRegex = new RegExp(`(^|[^\\w@])@${escapeRegExp(shortName)}(?![\\w@])`, 'g');
        rewritten = rewritten.replace(mentionRegex, (_, prefix) => `${prefix}${fullMention}`);
    }

    return rewritten;
}

function collectRawImageUrlsFromNote(note) {
    const urls = [];
    const pushUrl = (value) => {
        if (!value) return;
        if (typeof value === 'string') {
            urls.push(value);
            return;
        }
        if (typeof value === 'object') {
            if (typeof value.url === 'string') urls.push(value.url);
            if (typeof value.href === 'string') urls.push(value.href);
        }
    };

    pushUrl(note?.icon);
    pushUrl(note?.image);

    const attachments = Array.isArray(note?.attachment) ? note.attachment : [];
    for (const item of attachments) {
        const mediaType = String(item?.mediaType || '').toLowerCase();
        const type = String(item?.type || '').toLowerCase();
        const likelyImage = mediaType.startsWith('image/') || type === 'image';
        if (!likelyImage) continue;
        pushUrl(item?.url);
        pushUrl(item);
    }

    return urls;
}

function buildImageMirrorCandidates(rawUrl, contextUrl = null) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return [];

    const candidates = [];
    const pushUnique = (value) => {
        const normalized = normalizeHttpUrl(value, contextUrl);
        if (!normalized) return;
        if (!candidates.includes(normalized)) candidates.push(normalized);
    };

    pushUnique(raw);

    const absolute = normalizeHttpUrl(raw, contextUrl);
    if (absolute) {
        try {
            const parsed = new URL(absolute);
            const host = parsed.host;
            const path = parsed.pathname.replace(/\/{2,}/g, '/');

            if (parsed.protocol === 'http:') {
                pushUnique(`https://${host}${path}${parsed.search}`);
            } else if (parsed.protocol === 'https:') {
                pushUnique(`http://${host}${path}${parsed.search}`);
            }

            if (path.startsWith('/')) {
                pushUnique(`${parsed.protocol}//${host}/media${path}${parsed.search}`);
                pushUnique(`${parsed.protocol}//${host}/static${path}${parsed.search}`);
                pushUnique(`${parsed.protocol}//${host}/system${path}${parsed.search}`);
            }
        } catch {
            // ignore parse errors
        }
    }

    return candidates;
}

/**
 * 拉取远程用户的 outbox 帖子
 * @param {string} actorUrl - 远程 actor URL
 * @param {number} maxPosts - 最大拉取数量
 * @returns {Array} 拉取并创建的本地帖子列表
 */
export async function fetchRemoteUserPosts(actorUrl, maxPosts = 50) {
    // 检查实例是否允许
    const allowed = await isActorAllowed(actorUrl);
    if (!allowed) {
        logger.warn(`[ap-fetch] 实例不被允许: ${actorUrl}`);
        return [];
    }

    // 确保代理用户存在
    const proxyUser = await ensureProxyUser(actorUrl);
    if (!proxyUser) {
        logger.warn(`[ap-fetch] 无法创建代理用户: ${actorUrl}`);
        return [];
    }

    // 获取远程信息
    const remoteInfo = await getRemoteUserInfo(proxyUser.id);
    if (!remoteInfo?.outbox) {
        logger.warn(`[ap-fetch] 远程用户没有 outbox: ${actorUrl}`);
        return [];
    }

    try {
        // 获取 outbox collection
        const outboxData = await fetchApDocument(remoteInfo.outbox);
        if (!outboxData) return [];

        // 获取第一页
        let firstPageUrl = outboxData.first;
        if (typeof firstPageUrl === 'object') firstPageUrl = firstPageUrl.id;
        if (!firstPageUrl) return [];

        const firstPage = await fetchApDocument(firstPageUrl);
        if (!firstPage) return [];

        const items = firstPage.orderedItems || firstPage.items || [];
        const createdPosts = [];

        for (const item of items.slice(0, maxPosts)) {
            try {
                const post = await processRemoteActivity(item, proxyUser);
                if (post) createdPosts.push(post);
            } catch (err) {
                logger.debug(`[ap-fetch] 处理远程帖子失败:`, err.message);
            }
        }

        // 记录上次拉取时间
        await upsertTargetConfig(REMOTE_POST_TARGET_TYPE, String(proxyUser.id), 'last_fetch', new Date().toISOString());

        logger.info(`[ap-fetch] 从 ${actorUrl} 拉取了 ${createdPosts.length}/${items.length} 条帖子`);
        return createdPosts;
    } catch (err) {
        logger.error(`[ap-fetch] 拉取远程用户帖子失败:`, err.message);
        return [];
    }
}

/**
 * 获取 AP 文档（通用）
 * @param {string} url
 * @returns {object|null}
 */
async function fetchApDocument(url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (!normalizedUrl) {
        logger.warn(`[ap-fetch] AP 文档 URL 无效: ${url}`);
        return null;
    }

    try {
        const response = await federationGet(normalizedUrl, {
            headers: {
                'Accept': AP_ACCEPT_TYPES[0],
                'User-Agent': 'ZeroCat-ActivityPub/1.0',
            },
            timeout: AP_FETCH_TIMEOUT,
            maxRedirects: AP_FETCH_REDIRECT_LIMIT,
            validateStatus: status => status >= 200 && status < 300,
        });
        return response.data;
    } catch (err) {
        logger.warn(`[ap-fetch] 获取 AP 文档失败 ${normalizedUrl}:`, err.message);
        return null;
    }
}

/**
 * 处理远程活动并存储为本地帖子
 * @param {object} activity - AP Create/Announce 等活动
 * @param {object} proxyUser - 本地代理用户
 * @returns {object|null} 创建的本地帖子
 */
async function processRemoteActivity(activity, proxyUser) {
    if (!activity) return null;

    // 处理 Create 活动
    if (activity.type === 'Create') {
        const object = activity.object;
        if (!object) return null;

        // 如果 object 是引用字符串，尝试获取
        const note = typeof object === 'string' ? await fetchApDocument(object) : object;
        if (!note) return null;

        if (note.type === 'Note' || note.type === 'Article') {
            return await importRemoteNote(note, proxyUser);
        }
    }

    // 处理 Announce (转推)
    if (activity.type === 'Announce') {
        const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        if (!objectUrl) return null;

        return await importRemoteAnnounce(objectUrl, proxyUser, activity);
    }

    return null;
}

/**
 * 导入远程 Note 为本地帖子
 * @param {object} note - AP Note 对象
 * @param {object} proxyUser - 本地代理用户
 * @returns {object|null}
 */
async function importRemoteNote(note, proxyUser) {
    const noteId = note.id;
    if (!noteId) return null;

    // 检查是否已导入
    const existing = await findPostByApId(noteId);
    if (existing) return existing;

    // 提取纯文本内容
    let content = note.content || '';
    // 将块级标签转换为换行（Mastodon 使用 <p> 包裹段落）
    content = content
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        // 解码常见 HTML 实体
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // 合并超过两个连续换行为两个
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    // 远端提及容错：将 @user 自动补全为 @user@remote.domain
    const remoteDomain = inferRemoteDomainFromNote(note);
    const mentionAliasMap = buildMentionAliasMap(note, remoteDomain);
    content = rewriteShortMentionsToFedi(content, mentionAliasMap);

    // 截断到合理长度
    content = content.substring(0, 5000);

    // 提取更多远程图片镜像候选，便于前端查看
    const rawImageUrls = collectRawImageUrlsFromNote(note);
    const imageMirrorCandidates = Array.from(new Set(
        rawImageUrls.flatMap(imageUrl => buildImageMirrorCandidates(imageUrl, noteId))
    )).slice(0, 30);

    // 确定帖子类型
    let postType = 'normal';
    let inReplyToId = null;
    let threadRootId = null;
    let quotedPostId = null;
    let parentPost = null;

    // 处理回复关系
    if (note.inReplyTo) {
        postType = 'reply';
        const replyToPost = await resolveRemoteNoteReference(note.inReplyTo);
        if (replyToPost) {
            inReplyToId = replyToPost.id;
            parentPost = replyToPost;
            // 继承线程根 ID：如果父帖有 thread_root_id 则使用，否则父帖本身就是根
            threadRootId = replyToPost.thread_root_id || replyToPost.id;
        }
    }

    // 处理引用
    if (note.quoteUrl || note._misskey_quote) {
        postType = 'quote';
        const quoteUrl = note.quoteUrl || note._misskey_quote;
        const quotedPost = await resolveRemoteNoteReference(quoteUrl);
        if (quotedPost) {
            quotedPostId = quotedPost.id;
        }
    }

    try {
        // 创建本地帖子
        const post = await prisma.ow_posts.create({
            data: {
                author_id: proxyUser.id,
                post_type: postType,
                content,
                character_count: content.length,
                in_reply_to_id: inReplyToId,
                thread_root_id: threadRootId,
                quoted_post_id: quotedPostId,
                platform_refs: {
                    activitypub: {
                        id: noteId,
                        url: note.url || noteId,
                    },
                },
                created_at: note.published ? new Date(note.published) : new Date(),
                metadata: {
                    remote: true,
                    source_actor: note.attributedTo,
                    sensitive: note.sensitive || false,
                    spoiler_text: note.summary || null,
                    remote_url: note.url || noteId,
                    remote_domain: remoteDomain,
                    mention_aliases: Object.fromEntries(mentionAliasMap),
                    image_mirror_urls: imageMirrorCandidates,
                },
            },
        });

        // 递增父帖的回复计数
        if (parentPost) {
            try {
                await prisma.ow_posts.update({
                    where: { id: parentPost.id },
                    data: { reply_count: { increment: 1 } },
                });
            } catch (countErr) {
                logger.debug(`[ap-fetch] 更新父帖回复计数失败:`, countErr.message);
            }
        }

        // 存储 apId -> postId 映射
        await upsertTargetConfig(REMOTE_POST_TARGET_TYPE, '0', `note_map:${noteId}`, String(post.id));

        // 处理提及
        await processRemoteMentions(post.id, note);

        logger.debug(`[ap-fetch] 导入远程帖子: ${noteId} -> 本地帖子 #${post.id}`);
        return post;
    } catch (err) {
        // 可能是并发导入冲突
        if (err.code === 'P2002') {
            return await findPostByApId(noteId);
        }
        logger.error(`[ap-fetch] 导入远程帖子失败:`, err.message);
        return null;
    }
}

/**
 * 导入远程 Announce (转推)
 */
async function importRemoteAnnounce(objectUrl, proxyUser, activity) {
    // 先获取原始帖子
    const originalPost = await resolveRemoteNoteReference(objectUrl);
    if (!originalPost) return null;

    // 检查是否已有此 announce 的记录
    const announceId = activity.id;
    if (announceId) {
        const existing = await findPostByApId(announceId);
        if (existing) return existing;
    }

    try {
        const post = await prisma.ow_posts.create({
            data: {
                author_id: proxyUser.id,
                post_type: 'retweet',
                retweet_post_id: originalPost.id,
                platform_refs: announceId ? {
                    activitypub: {
                        id: announceId,
                        url: announceId,
                    },
                } : undefined,
                created_at: activity.published ? new Date(activity.published) : new Date(),
                metadata: {
                    remote: true,
                    source_actor: typeof activity.actor === 'string' ? activity.actor : activity.actor?.id,
                },
            },
        });

        if (announceId) {
            await upsertTargetConfig(REMOTE_POST_TARGET_TYPE, '0', `note_map:${announceId}`, String(post.id));
        }

        // 增加原帖的转推计数
        await prisma.ow_posts.update({
            where: { id: originalPost.id },
            data: { retweet_count: { increment: 1 } },
        });

        logger.debug(`[ap-fetch] 导入远程转推: ${announceId || objectUrl} -> 本地帖子 #${post.id}`);
        return post;
    } catch (err) {
        logger.error(`[ap-fetch] 导入远程转推失败:`, err.message);
        return null;
    }
}

/**
 * 根据 AP Note ID 查找本地帖子
 * @param {string} apNoteId
 * @returns {object|null}
 */
export async function findPostByApId(apNoteId) {
    // 从映射表查找
    const mapping = await getTargetConfig(REMOTE_POST_TARGET_TYPE, '0', `note_map:${apNoteId}`);
    if (mapping) {
        const postId = parseInt(mapping, 10);
        if (!isNaN(postId)) {
            return prisma.ow_posts.findUnique({ where: { id: postId } });
        }
    }

    // 也可以通过 platform_refs 查找（本地发出的帖子的 AP ref）
    const instanceDomain = await getInstanceDomain();
    const apBaseUrl = await getApEndpointBaseUrl();
    const noteIdMatch = apNoteId.match(/\/ap\/notes\/(\d+)$/);
    if (noteIdMatch) {
        const localPostId = parseInt(noteIdMatch[1], 10);
        if (!isNaN(localPostId)) {
            return prisma.ow_posts.findUnique({ where: { id: localPostId } });
        }
    }

    return null;
}

/**
 * 解析远程 Note 引用（URL 或 ID）为本地帖子
 * 如果本地没有，尝试拉取并创建
 * @param {string} noteRef - Note URL 或 ID
 * @returns {object|null}
 */
async function resolveRemoteNoteReference(noteRef) {
    if (!noteRef) return null;

    // 先检查是否为本地帖子
    const localPost = await findPostByApId(noteRef);
    if (localPost) return localPost;

    // 尝试获取远程 Note
    try {
        const note = await fetchApDocument(noteRef);
        if (!note || (note.type !== 'Note' && note.type !== 'Article')) return null;

        // 确定作者的代理用户
        const attributedTo = typeof note.attributedTo === 'string' ? note.attributedTo : note.attributedTo?.id;
        if (!attributedTo) return null;

        // 检查实例是否允许
        const allowed = await isActorAllowed(attributedTo);
        if (!allowed) return null;

        const proxyUser = await ensureProxyUser(attributedTo);
        if (!proxyUser) return null;

        // 导入此 note（不递归处理 inReplyTo 避免无限递归）
        return await importRemoteNoteShallow(note, proxyUser);
    } catch (err) {
        logger.debug(`[ap-fetch] 无法解析远程 Note 引用 ${noteRef}:`, err.message);
        return null;
    }
}

/**
 * 浅导入远程 Note（不递归处理引用关系）
 */
async function importRemoteNoteShallow(note, proxyUser) {
    const noteId = note.id;
    if (!noteId) return null;

    const existing = await findPostByApId(noteId);
    if (existing) return existing;

    let content = (note.content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').substring(0, 5000);

    // 浅导入也需要处理 inReplyTo 以保持线程结构完整
    let postType = 'normal';
    let inReplyToId = null;
    let threadRootId = null;

    if (note.inReplyTo) {
        // 浅导入只查找已存在的本地帖子，不递归拉取
        const parentPost = await findPostByApId(note.inReplyTo);
        if (parentPost) {
            postType = 'reply';
            inReplyToId = parentPost.id;
            threadRootId = parentPost.thread_root_id || parentPost.id;
        }
    }

    try {
        const post = await prisma.ow_posts.create({
            data: {
                author_id: proxyUser.id,
                post_type: postType,
                content,
                character_count: content.length,
                in_reply_to_id: inReplyToId,
                thread_root_id: threadRootId,
                platform_refs: {
                    activitypub: {
                        id: noteId,
                        url: note.url || noteId,
                    },
                },
                created_at: note.published ? new Date(note.published) : new Date(),
                metadata: {
                    remote: true,
                    source_actor: note.attributedTo,
                    shallow_import: true,
                },
            },
        });

        // 递增父帖回复计数
        if (inReplyToId) {
            try {
                await prisma.ow_posts.update({
                    where: { id: inReplyToId },
                    data: { reply_count: { increment: 1 } },
                });
            } catch { /* 忽略 */ }
        }

        await upsertTargetConfig(REMOTE_POST_TARGET_TYPE, '0', `note_map:${noteId}`, String(post.id));
        return post;
    } catch (err) {
        if (err.code === 'P2002') {
            return await findPostByApId(noteId);
        }
        return null;
    }
}

/**
 * 处理远程帖子的提及
 */
async function processRemoteMentions(postId, note) {
    if (!note.tag || !Array.isArray(note.tag)) return;

    const instanceDomain = await getInstanceDomain();
    const remoteDomain = inferRemoteDomainFromNote(note);

    for (const tag of note.tag) {
        if (tag.type !== 'Mention') continue;

        let mentionHref = normalizeHttpUrl(tag.href);
        if (!mentionHref) {
            const normalizedMention = normalizeMentionName(tag.name, remoteDomain);
            if (normalizedMention?.full) {
                const resolved = await resolveWebFinger(normalizedMention.full.replace(/^@/, ''));
                mentionHref = normalizeHttpUrl(resolved?.actorUrl);
            }
        }
        if (!mentionHref) continue;

        try {
            // 检查是否为本地用户
            const localNoteMatch = mentionHref.match(/\/ap\/users\/([^/]+)$/);
            if (localNoteMatch) {
                const localUser = await prisma.ow_users.findFirst({
                    where: { username: localNoteMatch[1], status: 'active' },
                    select: { id: true },
                });
                if (localUser) {
                    await prisma.ow_posts_mention.upsert({
                        where: { post_id_user_id: { post_id: postId, user_id: localUser.id } },
                        update: {},
                        create: { post_id: postId, user_id: localUser.id },
                    });
                    continue;
                }
            }

            // 远程用户提及 - 确保代理存在
            const allowed = await isActorAllowed(mentionHref);
            if (!allowed) continue;

            const proxyUser = await ensureProxyUser(mentionHref);
            if (proxyUser) {
                await prisma.ow_posts_mention.upsert({
                    where: { post_id_user_id: { post_id: postId, user_id: proxyUser.id } },
                    update: {},
                    create: { post_id: postId, user_id: proxyUser.id },
                });
            }
        } catch (err) {
            logger.debug(`[ap-fetch] 处理提及失败:`, err.message);
        }
    }
}

/**
 * 拉取并处理通过 inbox 接收到的 Create(Note)
 * 增强版：创建本地帖子记录而不仅是存储活动
 * @param {object} note - AP Note 对象
 * @param {object} remoteActor - 远程 Actor 对象
 * @returns {object|null} 创建的本地帖子
 */
export async function handleIncomingNote(note, remoteActor) {
    if (!note || !note.id) return null;

    // 检查实例
    const allowed = await isActorAllowed(remoteActor.id);
    if (!allowed) {
        logger.debug(`[ap-fetch] 拒绝来自非允许实例的帖子: ${remoteActor.id}`);
        return null;
    }

    // 确保代理用户
    const proxyUser = await ensureProxyUser(remoteActor.id, remoteActor);
    if (!proxyUser) return null;

    // 导入 note
    return await importRemoteNote(note, proxyUser);
}

/**
 * 处理通过 inbox 接收到的 Announce
 * @param {string} objectUrl - 被转推的 Note URL
 * @param {object} remoteActor - 远程 Actor
 * @param {object} activity - 完整的活动对象
 * @returns {object|null}
 */
export async function handleIncomingAnnounce(objectUrl, remoteActor, activity) {
    const allowed = await isActorAllowed(remoteActor.id);
    if (!allowed) return null;

    const proxyUser = await ensureProxyUser(remoteActor.id, remoteActor);
    if (!proxyUser) return null;

    return await importRemoteAnnounce(objectUrl, proxyUser, activity);
}

/**
 * 处理通过 inbox 接收到的 Like
 * @param {string} objectId - 被点赞的 Note URL
 * @param {object} remoteActor
 * @returns {object|null}
 */
export async function handleIncomingLike(objectId, remoteActor) {
    const post = await findPostByApId(objectId);
    if (!post) return null;

    const allowed = await isActorAllowed(remoteActor.id);
    if (!allowed) return null;

    const proxyUser = await ensureProxyUser(remoteActor.id, remoteActor);
    if (!proxyUser) return null;

    try {
        // 创建点赞记录
        await prisma.ow_posts_like.upsert({
            where: { user_id_post_id: { user_id: proxyUser.id, post_id: post.id } },
            update: {},
            create: { user_id: proxyUser.id, post_id: post.id },
        });

        // 更新帖子点赞计数
        await prisma.ow_posts.update({
            where: { id: post.id },
            data: { like_count: { increment: 1 } },
        });

        logger.debug(`[ap-fetch] 远程点赞: ${remoteActor.id} -> 帖子 #${post.id}`);
        return post;
    } catch (err) {
        logger.debug(`[ap-fetch] 处理远程点赞失败:`, err.message);
        return null;
    }
}

/**
 * 处理通过 inbox 接收到的 Undo(Like)
 */
export async function handleIncomingUndoLike(objectId, remoteActor) {
    const post = await findPostByApId(objectId);
    if (!post) return null;

    const proxyUser = await findProxyUserByActorUrl(remoteActor.id);
    if (!proxyUser) return null;

    try {
        const result = await prisma.ow_posts_like.deleteMany({
            where: { user_id: proxyUser.id, post_id: post.id },
        });

        if (result.count > 0) {
            await prisma.ow_posts.update({
                where: { id: post.id },
                data: { like_count: { decrement: 1 } },
            });
        }

        return post;
    } catch (err) {
        logger.debug(`[ap-fetch] 处理远程取消点赞失败:`, err.message);
        return null;
    }
}

/**
 * 处理帖子删除
 */
export async function handleIncomingDelete(objectId, remoteActor) {
    const post = await findPostByApId(objectId);
    if (!post) return null;

    // 确认是帖子作者
    const proxyUser = await findProxyUserByActorUrl(remoteActor.id);
    if (!proxyUser || post.author_id !== proxyUser.id) return null;

    try {
        await prisma.ow_posts.update({
            where: { id: post.id },
            data: { is_deleted: true },
        });
        logger.debug(`[ap-fetch] 远程帖子已删除: #${post.id}`);
        return post;
    } catch (err) {
        logger.debug(`[ap-fetch] 处理远程删除失败:`, err.message);
        return null;
    }
}

/**
 * 获取远程用户的帖子列表（从本地代理帖子中获取）
 * @param {number} proxyUserId - 代理用户 ID
 * @param {number} limit
 * @param {number} offset
 * @returns {Array}
 */
export async function getRemoteUserLocalPosts(proxyUserId, limit = 20, offset = 0) {
    return prisma.ow_posts.findMany({
        where: {
            AND: [await visibleWhere('post')],
            author_id: proxyUserId,
            is_deleted: false,
        },
        include: {
            author: {
                select: { id: true, username: true, display_name: true, avatar: true, type: true },
            },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
    });
}
