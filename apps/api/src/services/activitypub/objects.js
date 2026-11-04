/**
 * ActivityPub 对象序列化
 * 将本地帖子、活动等转换为 ActivityStreams 2.0 对象
 */

import { prisma } from '../prisma.js';
import logger from '../logger.js';
import { visibleWhere, canViewContent } from '../moderation/visibility.js';
import axios from 'axios';
import { AP_CONTEXT, AP_ACCEPT_TYPES, getApEndpointBaseUrl, getInstanceBaseUrl, getInstanceDomain, getStaticUrl } from './config.js';
import { getActorUrl } from './actor.js';
import { resolveWebFinger } from './federation.js';
import { v4 as uuidv4 } from 'uuid';
import twitterText from 'twitter-text';

const REMOTE_REF_PROBE_TIMEOUT_MS = 5000;
const REMOTE_REF_PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const remoteRefProbeCache = new Map();

/**
 * 生成帖子的 AP ID
 */
export async function getNoteId(postId) {
    const apBaseUrl = await getApEndpointBaseUrl();
    return `${apBaseUrl}/ap/notes/${postId}`;
}

/**
 * 生成帖子 URL（用于 Web 页面访问，指向前端）
 */
export async function getNoteUrl(postId) {
    const frontendBaseUrl = await getInstanceBaseUrl();
    return `${frontendBaseUrl}/app/posts/${postId}`;
}

/**
 * 生成活动 ID
 */
export async function generateActivityId(type) {
    const apBaseUrl = await getApEndpointBaseUrl();
    return `${apBaseUrl}/ap/activities/${type.toLowerCase()}-${uuidv4()}`;
}

/**
 * 获取帖子的关联媒体
 */
async function getPostMedia(postId) {
    const media = await prisma.ow_posts_media.findMany({
        where: { post_id: postId },
        include: { asset: true },
        orderBy: { order: 'asc' },
    });
    return media;
}

/**
 * 获取帖子的提及用户
 */
async function getPostMentions(postId) {
    const mentions = await prisma.ow_posts_mention.findMany({
        where: { post_id: postId },
        include: {
            user: {
                select: { id: true, username: true },
            },
        },
    });
    return mentions;
}

/**
 * 解析帖子的联邦引用 ID
 * 优先使用远程原始引用，避免回帖 inReplyTo 错指向本地代理 Note URL。
 * @param {number|null|undefined} relatedPostId
 * @param {object|null|undefined} relatedPost
 * @returns {Promise<string|null>}
 */
async function resolveRelatedNoteRef(relatedPostId, relatedPost = null) {
    if (!relatedPostId) return null;

    const hasReferenceFields =
        relatedPost &&
        typeof relatedPost === 'object' &&
        Object.prototype.hasOwnProperty.call(relatedPost, 'platform_refs') &&
        Object.prototype.hasOwnProperty.call(relatedPost, 'metadata');
    const visible = await prisma.ow_posts.findFirst({
        where: { id: Number(relatedPostId), AND: [await visibleWhere('post')] },
        select: hasReferenceFields ? { id: true } : { id: true, platform_refs: true, metadata: true },
    });
    if (!visible) return null;
    const candidate = hasReferenceFields ? relatedPost : visible;

    const isRemoteProxyPost = Boolean(candidate?.metadata?.remote);
    const apId = candidate?.platform_refs?.activitypub?.id;
    if (typeof apId === 'string' && /^https?:\/\//i.test(apId)) {
        if (!isRemoteProxyPost || await isPublicApObjectReachable(apId)) {
            return apId;
        }
        logger.warn(`[ap-objects] 远程引用不可公开抓取，回退本地代理引用: ${apId}`);
    }

    const remoteUrl = candidate?.metadata?.remote_url;
    if (typeof remoteUrl === 'string' && /^https?:\/\//i.test(remoteUrl)) {
        if (!isRemoteProxyPost || await isPublicApObjectReachable(remoteUrl)) {
            return remoteUrl;
        }
        logger.warn(`[ap-objects] 远程 remote_url 不可公开抓取，回退本地代理引用: ${remoteUrl}`);
    }

    return getNoteId(relatedPostId);
}

function readCachedProbeResult(url) {
    const cached = remoteRefProbeCache.get(url);
    if (!cached) return null;

    if (cached.expiresAt <= Date.now()) {
        remoteRefProbeCache.delete(url);
        return null;
    }

    return cached.ok;
}

function writeProbeCache(url, ok) {
    remoteRefProbeCache.set(url, {
        ok,
        expiresAt: Date.now() + REMOTE_REF_PROBE_CACHE_TTL_MS,
    });
}

async function isPublicApObjectReachable(url) {
    const cached = readCachedProbeResult(url);
    if (cached !== null) {
        return cached;
    }

    try {
        const response = await axios.get(url, {
            timeout: REMOTE_REF_PROBE_TIMEOUT_MS,
            maxRedirects: 3,
            headers: {
                Accept: AP_ACCEPT_TYPES[0],
                'User-Agent': 'ZeroCat-ActivityPub/1.0',
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const data = response?.data;
        const type = Array.isArray(data?.type) ? data.type.join(',') : String(data?.type || '');
        const ok = Boolean(data && typeof data === 'object' && data.id && type);
        writeProbeCache(url, ok);
        return ok;
    } catch {
        writeProbeCache(url, false);
        return false;
    }
}

/**
 * 将本地帖子转换为 AP Note 对象
 * @param {object} post 帖子记录（含 author 信息）
 * @returns {object} AP Note
 */
export async function postToNote(post) {
    if (!post || !await canViewContent('post', post, null)) return null;
    const apBaseUrl = await getApEndpointBaseUrl();
    const frontendBaseUrl = await getInstanceBaseUrl();
    const domain = await getInstanceDomain();
    const staticUrl = await getStaticUrl();
    const noteId = await getNoteId(post.id);
    const noteUrl = await getNoteUrl(post.id);

    // 获取作者信息
    let author;
    if (post.author) {
        author = post.author;
    } else {
        author = await prisma.ow_users.findUnique({
            where: { id: post.author_id },
            select: { id: true, username: true, display_name: true },
        });
    }

    if (!author) return null;

    const actorUrl = await getActorUrl(author.username);
    const tags = [];

    // ─── 使用 twitter-text + 自定义正则提取实体（@提及 + @user@domain + URL + #Hashtag）并构建 HTML ───
    const rawContent = post.content || '';

    // 获取帖子的提及用户信息
    let mentionUsers = [];
    try {
        const mentions = await getPostMentions(post.id);
        mentionUsers = mentions.map(m => m.user).filter(Boolean);
    } catch (err) {
        logger.debug('[ap-objects] 无法加载帖子提及:', err.message);
    }

    // 构建用户名→信息映射
    const usernameMap = new Map();
    for (const u of mentionUsers) {
        usernameMap.set(u.username.toLowerCase(), u);
    }

    // 1. 用自定义正则提取联邦提及 @username@domain.tld
    const fedMentionRegex = /@([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const fedMentions = [];
    let fedMatch;
    while ((fedMatch = fedMentionRegex.exec(rawContent)) !== null) {
        fedMentions.push({
            _type: 'fedMention',
            username: fedMatch[1],
            remoteDomain: fedMatch[2],
            indices: [fedMatch.index, fedMatch.index + fedMatch[0].length],
        });
    }

    // 2. 用 twitter-text 提取本地实体
    const ttEntities = twitterText.extractEntitiesWithIndices(rawContent);

    // 3. 合并实体，联邦提及优先（移除被联邦提及覆盖的 twitter-text 实体）
    const allEntities = [...fedMentions];
    for (const tte of ttEntities) {
        const [ts, te] = tte.indices;
        // 如果 twitter-text 实体与某个联邦提及重叠，跳过
        const overlaps = fedMentions.some(fm => ts < fm.indices[1] && te > fm.indices[0]);
        if (!overlaps) {
            allEntities.push(tte);
        }
    }
    allEntities.sort((a, b) => a.indices[0] - b.indices[0]);

    // 4. 预解析联邦提及的 actor URL（并行解析）
    const fedMentionCache = new Map();
    await Promise.all(fedMentions.map(async (fm) => {
        const key = `${fm.username}@${fm.remoteDomain}`;
        if (fedMentionCache.has(key)) return;
        try {
            // 如果是本站域名，直接用本站 actor URL
            if (fm.remoteDomain.toLowerCase() === domain.toLowerCase()) {
                fedMentionCache.set(key, {
                    href: `${apBaseUrl}/ap/users/${fm.username}`,
                    name: `@${fm.username}@${domain}`,
                    isLocal: true,
                });
                return;
            }
            const result = await resolveWebFinger(`${fm.username}@${fm.remoteDomain}`);
            if (result?.actorUrl) {
                fedMentionCache.set(key, {
                    href: result.actorUrl,
                    name: `@${fm.username}@${fm.remoteDomain}`,
                    isLocal: false,
                });
            }
        } catch (err) {
            logger.debug(`[ap-objects] 无法解析联邦提及 ${key}:`, err.message);
        }
    }));

    // 5. 逐段构建 HTML
    let htmlContent = '';
    let cursor = 0;
    for (const entity of allEntities) {
        const [start, end] = entity.indices;
        if (start > cursor) {
            htmlContent += escapeHtml(rawContent.slice(cursor, start));
        }

        if (entity._type === 'fedMention') {
            // ─── 联邦提及 @user@domain ───
            const key = `${entity.username}@${entity.remoteDomain}`;
            const resolved = fedMentionCache.get(key);
            if (resolved) {
                if (!tags.some(t => t.type === 'Mention' && t.href === resolved.href)) {
                    tags.push({ type: 'Mention', href: resolved.href, name: resolved.name });
                }
                htmlContent += `<span class="h-card"><a href="${resolved.href}" class="u-url mention">@<span>${escapeHtml(entity.username)}</span>@${escapeHtml(entity.remoteDomain)}</a></span>`;
            } else {
                // WebFinger 解析失败，保持原样
                htmlContent += escapeHtml(rawContent.slice(start, end));
            }
        } else if (entity.screenName !== undefined) {
            // ─── 本站 @提及 ───
            const user = usernameMap.get(entity.screenName.toLowerCase());
            if (user) {
                const href = `${apBaseUrl}/ap/users/${user.username}`;
                const fullMention = `@${user.username}@${domain}`;
                if (!tags.some(t => t.type === 'Mention' && t.href === href)) {
                    tags.push({ type: 'Mention', href, name: fullMention });
                }
                htmlContent += `<span class="h-card"><a href="${href}" class="u-url mention">@<span>${escapeHtml(user.username)}</span>@${escapeHtml(domain)}</a></span>`;
            } else {
                htmlContent += escapeHtml(rawContent.slice(start, end));
            }
        } else if (entity.url !== undefined) {
            const url = entity.url;
            const displayUrl = url.length > 40 ? url.substring(0, 37) + '...' : url;
            htmlContent += `<a href="${escapeHtml(url)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(displayUrl)}</a>`;
        } else if (entity.hashtag !== undefined) {
            const hashtagUrl = `${frontendBaseUrl}/tags/${encodeURIComponent(entity.hashtag)}`;
            if (!tags.some(t => t.type === 'Hashtag' && t.name === `#${entity.hashtag}`)) {
                tags.push({
                    type: 'Hashtag',
                    href: hashtagUrl,
                    name: `#${entity.hashtag}`,
                });
            }
            htmlContent += `<a href="${escapeHtml(hashtagUrl)}" class="mention hashtag" rel="tag">#<span>${escapeHtml(entity.hashtag)}</span></a>`;
        } else {
            htmlContent += escapeHtml(rawContent.slice(start, end));
        }

        cursor = end;
    }
    if (cursor < rawContent.length) {
        htmlContent += escapeHtml(rawContent.slice(cursor));
    }

    // ─── 处理嵌入对象 → 追加到 content 末尾 ───
    if (post.embed && typeof post.embed === 'object') {
        const embedResult = await buildEmbedHtml(post.embed, staticUrl, apBaseUrl, domain, tags);
        if (embedResult) {
            htmlContent += embedResult;
        }
    }

    // 将换行转为 <br>，并包裹在 <p> 中（Mastodon 标准格式）
    htmlContent = '<p>' + htmlContent.replace(/\n/g, '<br/>') + '</p>';

    const note = {
        '@context': AP_CONTEXT,
        id: noteId,
        type: 'Note',
        attributedTo: actorUrl,
        mediaType: 'text/html',
        content: htmlContent,
        published: post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString(),
        url: noteUrl,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorUrl}/followers`],
    };

    // 处理回复关系
    if (post.in_reply_to_id) {
        const replyRef = await resolveRelatedNoteRef(post.in_reply_to_id, post.in_reply_to);
        if (replyRef) {
            note.inReplyTo = replyRef;
        }
    }

    // 处理引用
    if (post.quoted_post_id) {
        const quotedNoteId = await resolveRelatedNoteRef(post.quoted_post_id, post.quoted_post);
        if (quotedNoteId) {
            note.quoteUrl = quotedNoteId;
            note._misskey_quote = quotedNoteId;
        }
    }

    // 处理媒体附件
    const allAttachments = [];
    try {
        const media = await getPostMedia(post.id);
        if (media.length > 0) {
            for (const m of media) {
                const asset = m.asset;
                if (!asset) continue;
                const p1 = asset.md5.substring(0, 2);
                const p2 = asset.md5.substring(2, 4);
                const mediaUrl = `${staticUrl}/assets/${p1}/${p2}/${asset.md5}.${asset.extension}`;
                allAttachments.push({
                    type: 'Document',
                    mediaType: asset.mime_type || `image/${asset.extension}`,
                    url: mediaUrl,
                    name: asset.filename || '',
                });
            }
        }
    } catch (err) {
        logger.debug('[ap-objects] 无法加载帖子媒体:', err.message);
    }
    if (allAttachments.length > 0) {
        note.attachment = allAttachments;
    }

    // 设置 tags（包含 Mention 和 Hashtag）
    if (tags.length > 0) {
        note.tag = tags;
    }

    // 将被提及的用户添加到 cc
    for (const u of mentionUsers) {
        const mentionActorUrl = `${apBaseUrl}/ap/users/${u.username}`;
        if (!note.cc.includes(mentionActorUrl)) {
            note.cc.push(mentionActorUrl);
        }
    }

    // 敏感内容标记
    if (post.metadata?.sensitive) {
        note.sensitive = true;
        note.summary = post.metadata.spoiler_text || 'Sensitive content';
    }

    return note;
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 生成 OG 卡片 URL（指向本服务提供的带 OG 元数据的页面，供 Mastodon 生成预览卡片）
 */
export function getCardUrl(baseUrl, type, id) {
    return `${baseUrl}/ap/card/${type}/${id}`;
}

/**
 * 将嵌入对象转换为追加到 content 末尾的 HTML 片段
 * embed 链接指向 OG 卡片端点，Mastodon 会抓取该端点的 OG 标签来生成预览卡片
 * Mastodon 使用帖子 HTML 中最后一个非 mention/hashtag 的链接生成卡片
 * @returns {string|null} HTML 片段
 */
async function buildEmbedHtml(embed, staticUrl, baseUrl, domain, tags) {
    try {
        switch (embed.type) {
            case 'project': {
                if (!embed.id) return null;
                const project = await prisma.ow_projects.findFirst({
                    where: { id: Number(embed.id), state: 'public', AND: [await visibleWhere('project')] },
                    select: {
                        id: true, name: true, title: true,
                        state: true,
                        author: { select: { id: true, username: true } },
                    },
                });
                if (!project || project.state === 'private') return null;
                const cardUrl = getCardUrl(baseUrl, 'project', project.id);
                return `<br/><a href="${cardUrl}">${escapeHtml(cardUrl)}</a>`;
            }

            case 'user': {
                if (!embed.id) return null;
                const user = await prisma.ow_users.findFirst({
                    where: { id: Number(embed.id), AND: [await visibleWhere('profile')] },
                    select: { id: true, username: true },
                });
                if (!user) return null;
                const userActorUrl = `${baseUrl}/ap/users/${user.username}`;
                const fullMention = `@${user.username}@${domain}`;
                if (!tags.some(t => t.type === 'Mention' && t.href === userActorUrl)) {
                    tags.push({ type: 'Mention', href: userActorUrl, name: fullMention });
                }
                const cardUrl = getCardUrl(baseUrl, 'user', user.id);
                return `<br/><a href="${cardUrl}">${escapeHtml(cardUrl)}</a>`;
            }

            case 'list': {
                if (!embed.id) return null;
                const list = await prisma.ow_projects_lists.findFirst({
                    where: { id: Number(embed.id), state: 'public', AND: [await visibleWhere('list')] },
                    select: { id: true, state: true },
                });
                if (!list || list.state === 'private') return null;
                const cardUrl = getCardUrl(baseUrl, 'list', list.id);
                return `<br/><a href="${cardUrl}">${escapeHtml(cardUrl)}</a>`;
            }

            case 'url': {
                if (!embed.url) return null;
                return `<br/><a href="${escapeHtml(embed.url)}">${escapeHtml(embed.url)}</a>`;
            }

            default:
                return null;
        }
    } catch (err) {
        logger.debug('[ap-objects] 无法构建嵌入 HTML:', err.message);
        return null;
    }
}

/**
 * 构建 Create 活动
 */
export async function buildCreateActivity(actor, object) {
    const id = await generateActivityId('create');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Create',
        actor: typeof actor === 'string' ? actor : actor.id,
        published: object.published || new Date().toISOString(),
        to: object.to,
        cc: object.cc,
        object,
    };
}

/**
 * 构建 Delete 活动
 */
export async function buildDeleteActivity(actorUrl, objectId) {
    const id = await generateActivityId('delete');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Delete',
        actor: actorUrl,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: {
            id: objectId,
            type: 'Tombstone',
        },
    };
}

/**
 * 构建 Like 活动
 */
export async function buildLikeActivity(actorUrl, objectId) {
    const id = await generateActivityId('like');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Like',
        actor: actorUrl,
        object: objectId,
    };
}

/**
 * 构建 Undo 活动
 */
export async function buildUndoActivity(actorUrl, originalActivity) {
    const id = await generateActivityId('undo');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Undo',
        actor: actorUrl,
        object: originalActivity,
    };
}

/**
 * 构建 Announce (转推/boost) 活动
 */
export async function buildAnnounceActivity(actorUrl, objectId) {
    const id = await generateActivityId('announce');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Announce',
        actor: actorUrl,
        published: new Date().toISOString(),
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorUrl}/followers`],
        object: objectId,
    };
}

/**
 * 构建 Follow 活动
 */
export async function buildFollowActivity(actorUrl, targetActorUrl) {
    const id = await generateActivityId('follow');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Follow',
        actor: actorUrl,
        object: targetActorUrl,
    };
}

/**
 * 构建 Accept 活动
 */
export async function buildAcceptActivity(actorUrl, originalActivity) {
    const id = await generateActivityId('accept');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Accept',
        actor: actorUrl,
        object: originalActivity,
    };
}

/**
 * 构建 Reject 活动
 */
export async function buildRejectActivity(actorUrl, originalActivity) {
    const id = await generateActivityId('reject');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Reject',
        actor: actorUrl,
        object: originalActivity,
    };
}

/**
 * 构建 Update 活动
 */
export async function buildUpdateActivity(actorUrl, object) {
    const id = await generateActivityId('update');
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'Update',
        actor: actorUrl,
        published: new Date().toISOString(),
        to: object.to,
        cc: object.cc,
        object,
    };
}

/**
 * 构建有序集合（OrderedCollection）
 */
export function buildOrderedCollection(id, totalItems, firstPage) {
    return {
        '@context': AP_CONTEXT,
        id,
        type: 'OrderedCollection',
        totalItems,
        first: firstPage,
    };
}

/**
 * 构建有序集合页（OrderedCollectionPage）
 */
export function buildOrderedCollectionPage(id, partOf, items, nextPage, prevPage) {
    const page = {
        '@context': AP_CONTEXT,
        id,
        type: 'OrderedCollectionPage',
        partOf,
        orderedItems: items,
    };
    if (nextPage) page.next = nextPage;
    if (prevPage) page.prev = prevPage;
    return page;
}
