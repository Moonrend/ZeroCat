import { prisma } from "../services/prisma.js";
import twitterText from "twitter-text";
import { createNotification } from "./notifications.js";
import { createEvent } from './events.js';
import zcconfig from "../services/config/zcconfig.js";
import logger from "../services/logger.js";
import queueManager from "../services/queue/queueManager.js";
import gorseService from "../services/gorse.js";
import * as embeddingService from "../services/embedding.js";
import { getAnalytics } from "../services/analytics.js";
import { getPostUrlPreview } from "../services/postPreview.js";
import { toAvatarURL } from "../utils/avatarUrl.js";
import { visibleWhere, sanitizeProfiles } from "../services/moderation/visibility.js";
import { assertCanWrite } from "../services/moderation/restrictions.js";
import { softDeleteContent, restoreContent } from "../services/moderation/lifecycle.js";

async function visiblePostWhere(where, viewerId = null) {
  return { AND: [where, await visibleWhere("post", viewerId)] };
}

async function visibleInteractionUserWhere(viewerId = null) {
  return { AND: [
    await visibleWhere("profile", viewerId),
    await visibleWhere("profile", viewerId, { category: "relations" }),
  ] };
}

function postNotFound(message = "帖子不存在") {
  return Object.assign(new Error(message), { status: 404, code: "ZC_ERROR_CONTENT_NOT_FOUND" });
}

const POST_CHAR_LIMIT = 280;
const MAX_MEDIA_COUNT = 4;

// 预初始化的静态URL（模块加载时初始化）
let staticUrl = null;

async function initStaticUrl() {
  if (staticUrl === null) {
    const rawUrl = await zcconfig.get("s3.staticurl");
    // 使用URL解析处理首末斜杠问题
    const url = new URL(rawUrl);
    staticUrl = url.origin + url.pathname.replace(/\/+$/, "");
  }
  return staticUrl;
}

function buildMediaUrl(md5, extension) {
  if (!staticUrl || !md5) return null;
  const prefix1 = md5.substring(0, 2);
  const prefix2 = md5.substring(2, 4);
  return `${staticUrl}/assets/${prefix1}/${prefix2}/${md5}.${extension}`;
}

function buildAuthorAvatarUrl(avatar) {
  return toAvatarURL(avatar, staticUrl);
}

function dedupeMediaIds(mediaIds) {
  // 去重并保持顺序
  return [...new Set(mediaIds.map((id) => Number(id)))];
}

const EMBED_TYPES = ["project", "list", "user", "url","article"];

function validateEmbed(embed) {
  if (!embed) return null;
  if (typeof embed !== "object" || Array.isArray(embed)) return null;
  if (!embed.type || !EMBED_TYPES.includes(embed.type)) {
    throw new Error("不支持的嵌入类型");
  }

  // 如果是url类型，验证url字段存在且有效
  if (embed.type === "url") {
    if (!embed.url || typeof embed.url !== "string") {
      throw new Error("url类型嵌入必须包含有效的url字段");
    }
    // 验证URL格式
    try {
      new URL(embed.url);
    } catch (e) {
      throw new Error("无效的URL格式");
    }
  }

  return embed;
}

async function validatePostAttachments(authorId, mediaIds, embed) {
  if (mediaIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("无效的媒体 ID");
  if (mediaIds.length) {
    const assets = await prisma.ow_assets.findMany({
      where: { AND: [{ id: { in: mediaIds }, uploader_id: Number(authorId) }, await visibleWhere("asset", authorId)] },
      select: { id: true },
    });
    if (assets.length !== mediaIds.length) throw postNotFound("媒体不存在");
  }
  if (!embed || embed.type === "url") return embed;
  const kind = { project: "project", article: "project", list: "list", user: "profile" }[embed.type];
  const model = { project: "ow_projects", list: "ow_projects_lists", profile: "ow_users" }[kind];
  const identity = embed.id ? { id: Number(embed.id) } : kind === "profile" && embed.username ? { username: String(embed.username) } : null;
  if (!identity || (identity.id !== undefined && (!Number.isSafeInteger(identity.id) || identity.id <= 0))) throw postNotFound();
  const target = await prisma[model].findFirst({
    where: { AND: [identity, await visibleWhere(kind, authorId)] },
    select: { id: true },
  });
  if (!target) throw postNotFound();
  return { type: embed.type, id: target.id };
}

function countPostCharacters(content = "") {
  if (!content) return 0;
  return twitterText.parseTweet(content).weightedLength;
}

function analyzePostContent(content = "") {
  const tweet = twitterText.parseTweet(content || "");
  logger.debug(tweet);
  return {
    characterCount: tweet.weightedLength,
    valid: tweet.valid,
  };
}

function extractMentionUsernames(content = "") {
  if (!content) return [];
  const usernames = new Set();
  // Username length in schema is up to 64; require a non-word prefix to avoid matching emails.
  const regex = /(?:^|[^\w@])@([a-zA-Z0-9_]{1,64})\b/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    usernames.add(String(match[1] || "").trim());
  }
  return [...usernames].filter(Boolean);
}

async function resolveMentionedUsers(content, authorId) {
  const usernames = extractMentionUsernames(content);
  if (usernames.length === 0) return [];

  const users = await prisma.ow_users.findMany({
    where: {
      OR: usernames.map((username) => ({
        username: {
          equals: username,
          mode: "insensitive",
        },
      })),
      AND: [await visibleWhere("profile", authorId)],
    },
    select: {
      id: true,
      username: true,
      display_name: true,
    },
  });

  return users.filter((user) => user.id !== authorId);
}

function formatNotificationActorName(user) {
  const displayName = typeof user?.display_name === "string" ? user.display_name.trim() : "";
  const username = typeof user?.username === "string" ? user.username.trim() : "";
  return displayName || username || "有人";
}

async function getNotificationActorName(userId) {
  if (!userId) return "有人";
  const user = await prisma.ow_users.findUnique({
    where: { id: Number(userId) },
    select: {
      username: true,
      display_name: true,
    },
  });
  return formatNotificationActorName(user);
}

function getPostTargetLabel(post) {
  return post?.in_reply_to_id ? "回复" : "帖子";
}

function buildPostPreview(content, maxLength = 40) {
  if (!content) return "";
  const normalized = String(content).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function buildLeanSelect() {
  return {
    id: true,
    author_id: true,
    post_type: true,
    content: true,
    in_reply_to_id: true,
    thread_root_id: true,
    quoted_post_id: true,
    retweet_post_id: true,
    reply_count: true,
    retweet_count: true,
    like_count: true,
    bookmark_count: true,
    is_deleted: true,
    embed: true,
    platform_refs: true,
    created_at: true,
    embedding_at: true,
    author: {
      select: { id: true, username: true, display_name: true, avatar: true },
    },
    post_media: {
      select: {
        id: true,
        order: true,
        asset: { select: { id: true, md5: true, extension: true, mime_type: true } },
      },
    },
    mentions: {
      select: {
        user: { select: { id: true, username: true } },
      },
    },
  };
}

/**
 * 格式化平台同步引用信息
 * 返回帖子在各平台的同步状态（Twitter、Bluesky、ActivityPub）
 */
function formatPlatformRefs(refs) {
  if (!refs || typeof refs !== 'object') return null;

  const result = {};
  let hasAny = false;

  if (refs.twitter) {
    result.twitter = {
      id: refs.twitter.id || null,
      url: refs.twitter.id ? `https://x.com/i/status/${refs.twitter.id}` : null,
      kind: refs.twitter.kind || null,
    };
    hasAny = true;
  }

  if (refs.bluesky) {
    result.bluesky = {
      uri: refs.bluesky.uri || null,
      cid: refs.bluesky.cid || null,
      kind: refs.bluesky.kind || null,
    };
    hasAny = true;
  }

  if (refs.activitypub) {
    result.activitypub = {
      id: refs.activitypub.id || null,
      url: refs.activitypub.url || null,
    };
    hasAny = true;
  }

  return hasAny ? result : null;
}

function formatPost(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    type: raw.post_type,
    content: raw.is_deleted ? null : raw.content,
    created_at: raw.created_at,
    is_deleted: raw.is_deleted,
    author: raw.author ? {
      ...raw.author,
      avatarURL: buildAuthorAvatarUrl(raw.author.avatar),
    } : raw.author,
    stats: {
      replies: raw.reply_count,
      retweets: raw.retweet_count,
      likes: raw.like_count,
      bookmarks: raw.bookmark_count,
      views: 0,
    },
    reply_to_id: raw.in_reply_to_id,
    quote_of_id: raw.quoted_post_id,
    retweet_of_id: raw.retweet_post_id,
    thread_id: raw.thread_root_id,
    media: (raw.is_deleted || raw.deleted_at ? [] : raw.post_media || [])
      .map((m) => {
        if (!m.asset?.id) return null;
        const extension = m.asset.extension || m.asset.mime_type?.split("/")[1] || "webp";
        return {
          id: m.asset.id,
          url: buildMediaUrl(m.asset.md5, extension),
          mime_type: m.asset.mime_type,
          order: m.order,
        };
      })
      .filter(Boolean),
    mentions: (raw.mentions || [])
      .map((m) => ({
        id: m.user?.id,
        username: m.user?.username,
      }))
      .filter((m) => m.id),
    embed: raw.is_deleted ? null : raw.embed || null,
    embedding_at: raw.embedding_at || null,
    platform_refs: raw.is_deleted ? null : formatPlatformRefs(raw.platform_refs),
  };
}

async function serializePosts(raws, viewerId = null) {
  await initStaticUrl();
  const posts = raws.map(formatPost);
  const profiles = await sanitizeProfiles(posts.flatMap(post => post ? [post.author, ...post.mentions] : []), viewerId);
  let offset = 0;
  for (const post of posts) {
    if (!post) continue;
    post.author = profiles[offset++];
    const end = offset + post.mentions.length;
    post.mentions = profiles.slice(offset, end).filter(Boolean);
    offset = end;
  }
  const embedGroups = new Map();
  for (const post of posts) {
    if (!post?.embed || post.embed.type === "url") continue;
    const embed = post.embed;
    const kind = { project: "project", article: "project", list: "list", user: "profile" }[embed.type];
    const model = { project: "ow_projects", list: "ow_projects_lists", profile: "ow_users" }[kind];
    const identity = embed.id ? { id: Number(embed.id) } : kind === "profile" && embed.username ? { username: String(embed.username) } : null;
    if (!model || !identity) { post.embed = null; continue; }
    const key = identity.id !== undefined ? `id:${identity.id}` : `username:${identity.username}`;
    if (!embedGroups.has(kind)) embedGroups.set(kind, { model, identities: new Map(), entries: [] });
    const group = embedGroups.get(kind);
    group.identities.set(key, identity);
    group.entries.push({ post, key, type: embed.type });
  }
  await Promise.all([...embedGroups].map(async ([kind, group]) => {
    const identities = [...group.identities.values()];
    const visibility = await visibleWhere(kind, viewerId);
    const targets = new Map();
    for (let start = 0; start < identities.length; start += 1000) {
      const rows = await prisma[group.model].findMany({
        where: { AND: [{ OR: identities.slice(start, start + 1000) }, visibility] },
        select: { id: true, ...(kind === "profile" ? { username: true } : {}) },
      });
      for (const row of rows) {
        targets.set(`id:${row.id}`, row.id);
        if (kind === "profile") targets.set(`username:${row.username}`, row.id);
      }
    }
    for (const { post, key, type } of group.entries) {
      const id = targets.get(key);
      post.embed = id === undefined ? null : { type, id };
    }
  }));
  return posts;
}

export async function serializePost(raw, viewerId = null) {
  return (await serializePosts([raw], viewerId))[0];
}

async function getPostViewCountMap(postIds) {
  const normalizedIds = [...new Set((postIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (normalizedIds.length === 0) return new Map();

  const rows = await prisma.ow_analytics_event.groupBy({
    by: ["target_id"],
    where: {
      target_type: "post",
      target_id: { in: normalizedIds },
    },
    _count: { _all: true },
  });

  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.target_id), Number(row._count?._all || 0));
  }
  return map;
}

async function attachPostViewCounts(posts, viewerId = null) {
  if (!posts || posts.length === 0) return posts || [];
  const ids = posts.map((post) => post.id);
  const [viewMap, visibility, users] = await Promise.all([
    getPostViewCountMap(ids), visibleWhere("post", viewerId), visibleInteractionUserWhere(viewerId),
  ]);
  const [replies, retweets, quotes, likes, bookmarks] = await Promise.all([
    prisma.ow_posts.groupBy({ by: ["in_reply_to_id"], where: { in_reply_to_id: { in: ids }, AND: [visibility] }, _count: { _all: true } }),
    prisma.ow_posts.groupBy({ by: ["retweet_post_id"], where: { retweet_post_id: { in: ids }, AND: [visibility] }, _count: { _all: true } }),
    prisma.ow_posts.groupBy({ by: ["quoted_post_id"], where: { quoted_post_id: { in: ids }, AND: [visibility] }, _count: { _all: true } }),
    prisma.ow_posts_like.groupBy({ by: ["post_id"], where: { post_id: { in: ids }, user: { is: users } }, _count: { _all: true } }),
    prisma.ow_posts_bookmark.groupBy({ by: ["post_id"], where: { post_id: { in: ids }, user: { is: users } }, _count: { _all: true } }),
  ]);
  const counts = (rows, field) => new Map(rows.map((row) => [Number(row[field]), Number(row._count?._all || 0)]));
  const replyMap = counts(replies, "in_reply_to_id");
  const retweetMap = counts(retweets, "retweet_post_id");
  const quoteMap = counts(quotes, "quoted_post_id");
  const likeMap = counts(likes, "post_id");
  const bookmarkMap = counts(bookmarks, "post_id");
  return posts.map((post) => ({
    ...post,
    stats: {
      replies: replyMap.get(Number(post.id)) || 0,
      retweets: (retweetMap.get(Number(post.id)) || 0) + (quoteMap.get(Number(post.id)) || 0),
      likes: likeMap.get(Number(post.id)) || 0,
      bookmarks: bookmarkMap.get(Number(post.id)) || 0,
      views: viewMap.get(Number(post.id)) || 0,
    },
  }));
}

function collectReferencedIds(posts) {
  const ids = new Set();
  for (const p of posts) {
    if (p.reply_to_id) ids.add(p.reply_to_id);
    if (p.quote_of_id) ids.add(p.quote_of_id);
    if (p.retweet_of_id) ids.add(p.retweet_of_id);
  }
  const postIds = new Set(posts.map((p) => p.id));
  for (const id of ids) {
    if (postIds.has(id)) ids.delete(id);
  }
  return [...ids];
}

async function fetchReferencedPosts(ids, viewerId = null) {
  if (ids.length === 0) return {};
  const raws = await prisma.ow_posts.findMany({
    where: await visiblePostWhere({ id: { in: ids } }, viewerId),
    select: buildLeanSelect(),
  });

  const formatted = await serializePosts(raws, viewerId);
  const enriched = await attachPostViewCounts(formatted, viewerId);

  const map = {};
  for (const post of enriched) {
    map[post.id] = post;
  }
  return map;
}

async function addViewerContext(posts, viewerId) {
  if (!viewerId || posts.length === 0) {
    return posts.map((p) => ({ ...p, viewer_context: null }));
  }

  const postIds = posts.map((p) => p.id);

  const [likes, bookmarks, retweets] = await Promise.all([
    prisma.ow_posts_like.findMany({
      where: { user_id: viewerId, post_id: { in: postIds } },
      select: { post_id: true },
    }),
    prisma.ow_posts_bookmark.findMany({
      where: { user_id: viewerId, post_id: { in: postIds } },
      select: { post_id: true },
    }),
    prisma.ow_posts.findMany({
      where: {
        author_id: viewerId,
        retweet_post_id: { in: postIds },
        ...await visibleWhere("post", viewerId),
        post_type: "retweet",
      },
      select: { retweet_post_id: true },
    }),
  ]);

  const likedIds = new Set(likes.map((l) => l.post_id));
  const bookmarkedIds = new Set(bookmarks.map((b) => b.post_id));
  const retweetedIds = new Set(retweets.map((r) => r.retweet_post_id));

  return posts.map((p) => ({
    ...p,
    viewer_context: {
      liked: likedIds.has(p.id),
      bookmarked: bookmarkedIds.has(p.id),
      retweeted: retweetedIds.has(p.id),
    },
  }));
}

async function buildListResponse(rawPosts, limit, viewerId = null) {
  const refIds = collectReferencedIds(rawPosts.map(formatPost));
  const referencedRaws = refIds.length ? await prisma.ow_posts.findMany({
    where: await visiblePostWhere({ id: { in: refIds } }, viewerId),
    select: buildLeanSelect(),
  }) : [];
  let enriched = await serializePosts([...rawPosts, ...referencedRaws], viewerId);
  enriched = await addViewerContext(enriched, viewerId);
  enriched = await attachPostViewCounts(enriched, viewerId);
  const posts = enriched.slice(0, rawPosts.length);
  const referencedPosts = Object.fromEntries(enriched.slice(rawPosts.length).map((post) => [post.id, post]));

  const hasMore = rawPosts.length === Number(limit);
  const nextCursor =
    rawPosts.length > 0
      ? rawPosts[rawPosts.length - 1].created_at.toISOString()
      : null;

  return {
    posts,
    includes: { posts: referencedPosts },
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

function buildEmbedSubsetClauses(value, path = []) {
  const field = path.length > 0 ? `embed.${path.join(".")}` : "embed";

  if (value === undefined) return [];

  if (value === null || Array.isArray(value)) {
    if (path.length === 0) {
      throw new Error("embeddata 必须是对象");
    }

    return [{
      embed: {
        path,
        equals: value,
      },
    }];
  }

  if (typeof value === "object") {
    const clauses = [];

    for (const [rawKey, childValue] of Object.entries(value)) {
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (!key) {
        throw new Error("embeddata 字段名不能为空");
      }

      clauses.push(...buildEmbedSubsetClauses(childValue, [...path, key]));
    }

    return clauses;
  }

  if (typeof value === "string") {
    if (!value.trim()) {
      throw new Error(`${field} 不能为空字符串`);
    }

    return [{
      embed: {
        path,
        equals: value,
      },
    }];
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} 必须是有限数字`);
    }

    return [{
      embed: {
        path,
        equals: value,
      },
    }];
  }

  if (typeof value === "boolean") {
    return [{
      embed: {
        path,
        equals: value,
      },
    }];
  }

  throw new Error(`${field} 类型不支持`);
}

function normalizePositiveInt(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("cursor 必须是正整数");
  }
  return parsed;
}
async function notifyMentions(mentionedUsers, actorId, postId, actor) {
  const actorName = actor ? formatNotificationActorName(actor) : await getNotificationActorName(actorId);

  await Promise.all(
    mentionedUsers.map((user) =>
      createNotification({
        notificationType: "post_mention",
        notificationRequirement: "BASIC",
        title: `${actorName} 提到了你`,
        content: `${actorName} 在一条动态中提到了你`,
        userId: user.id,
        actorId,
        targetType: "post",
        targetId: postId,
        data: {
          post_id: postId,
          mentioned_user: user.username,
        },
      })
    )
  );

  const userIds = mentionedUsers.map((u) => u.id);
  if (userIds.length > 0) {
    await prisma.ow_posts_mention.updateMany({
      where: {
        post_id: postId,
        user_id: { in: userIds },
      },
      data: {
        notified: true,
      },
    });
  }
}

export async function createPost({ authorId, content, mediaIds = [], embed }) {
  const viewerId = authorId;
  await assertCanWrite(authorId, "post", "create");
  // 确保静态URL已初始化
  await initStaticUrl();

  // 去重 mediaIds
  const uniqueMediaIds = dedupeMediaIds(mediaIds);

  const { characterCount, valid } = analyzePostContent(content);
  if (!content || characterCount === 0) {
    throw new Error("内容不能为空");
  }
  if (!valid) {
    throw new Error("内容超过字数限制");
  }

  if (uniqueMediaIds.length > MAX_MEDIA_COUNT) {
    throw new Error(`最多只能上传${MAX_MEDIA_COUNT}张图片`);
  }

  const validatedEmbed = await validatePostAttachments(authorId, uniqueMediaIds, validateEmbed(embed));
  const mentionedUsers = await resolveMentionedUsers(content, authorId);
  const mentionedUserIds = mentionedUsers.map((user) => user.id);

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.ow_posts.create({
      data: {
        author_id: authorId,
        post_type: "normal",
        content,
        character_count: characterCount,
        ...(validatedEmbed ? { embed: validatedEmbed } : {}),
      },
      select: buildLeanSelect(),
    });

    if (uniqueMediaIds.length > 0) {
      await tx.ow_posts_media.createMany({
        data: uniqueMediaIds.map((assetId, index) => ({
          post_id: created.id,
          asset_id: assetId,
          order: index,
        })),
      });
    }

    if (mentionedUserIds.length > 0) {
      await tx.ow_posts_mention.createMany({
        data: mentionedUserIds.map((userId) => ({
          post_id: created.id,
          user_id: userId,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  if (mentionedUsers.length > 0) {
    await notifyMentions(mentionedUsers, authorId, post.id, post.author);
  }

  const authorName = formatNotificationActorName(post.author);

  // 触发 post_create 事件
  createEvent(
    'post_create',
    authorId,
    'post',
    post.id,
    {
      post_content: content,
      notification_title: `${authorName} 发布了新帖子`,
      notification_content: ``,
    }
  ).catch(e => logger.error('[event] create post_create event failed:', e.message));

  queueManager.enqueueSocialPostSync(authorId, post.id, "create").catch((error) => {
    logger.warn("推文社交同步入队失败(create):", error.message);
  });

  // 同步帖子到 Gorse 推荐系统
  gorseService.upsertPost(post).catch(e => logger.debug('[gorse] createPost upsert failed:', e.message));

  // 异步生成帖子向量
  queueManager.enqueuePostEmbedding(post.id).catch(e => logger.debug('[embedding] createPost enqueue failed:', e.message));

  // 异步刷新作者用户向量（帖子变化影响用户画像）
  queueManager.enqueueUserEmbedding(authorId, false, 'post_create').catch(e => logger.debug('[embedding] createPost user enqueue failed:', e.message));

  const formattedPost = await serializePost(post, viewerId);
  const [postWithViews] = await attachPostViewCounts([formattedPost], viewerId);
  return {
    post: postWithViews,
    includes: { posts: {} },
  };
}

export async function replyToPost({
  authorId,
  content,
  mediaIds = [],
  replyToId,
  embed,
}) {
  const viewerId = authorId;
  await assertCanWrite(authorId, "post", "create");
  // 确保静态URL已初始化
  await initStaticUrl();

  // 去重 mediaIds
  const uniqueMediaIds = dedupeMediaIds(mediaIds);

  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(replyToId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true, thread_root_id: true, in_reply_to_id: true },
  });
  if (!target) {
    throw postNotFound();
  }

  const { characterCount, valid } = analyzePostContent(content);
  if (!content || characterCount === 0) {
    throw new Error("内容不能为空");
  }
  if (!valid) {
    throw new Error("内容超过字数限制");
  }
  if (uniqueMediaIds.length > MAX_MEDIA_COUNT) {
    throw new Error(`最多只能上传${MAX_MEDIA_COUNT}张图片`);
  }

  const validatedEmbed = await validatePostAttachments(authorId, uniqueMediaIds, validateEmbed(embed));
  const threadRootId = target.thread_root_id || target.id;
  const mentionedUsers = await resolveMentionedUsers(content, authorId);
  const mentionedUserIds = mentionedUsers.map((user) => user.id);

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.ow_posts.create({
      data: {
        author_id: authorId,
        post_type: "reply",
        content,
        character_count: characterCount,
        in_reply_to_id: target.id,
        thread_root_id: threadRootId,
        ...(validatedEmbed ? { embed: validatedEmbed } : {}),
      },
      select: buildLeanSelect(),
    });

    await tx.ow_posts.update({
      where: { id: target.id },
      data: { reply_count: { increment: 1 } },
    });

    if (uniqueMediaIds.length > 0) {
      await tx.ow_posts_media.createMany({
        data: uniqueMediaIds.map((assetId, index) => ({
          post_id: created.id,
          asset_id: assetId,
          order: index,
        })),
      });
    }

    if (mentionedUserIds.length > 0) {
      await tx.ow_posts_mention.createMany({
        data: mentionedUserIds.map((userId) => ({
          post_id: created.id,
          user_id: userId,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  if (target.author_id && target.author_id !== authorId) {
    const actorName = formatNotificationActorName(post.author);
    const targetLabel = getPostTargetLabel(target);
    await createNotification({
      notificationType: "post_reply",
      notificationRequirement: "BASIC",
      title: `${actorName} 回复了你的${targetLabel}`,
      content: `${actorName} 回复了你的${targetLabel}`,
      userId: target.author_id,
      actorId: authorId,
      targetType: "post",
      targetId: target.id,
      data: { post_id: post.id },
    });
  }

  if (mentionedUsers.length > 0) {
    await notifyMentions(mentionedUsers, authorId, post.id, post.author);
  }

  queueManager.enqueueSocialPostSync(authorId, post.id, "reply").catch((error) => {
    logger.warn("推文社交同步入队失败(reply):", error.message);
  });

  // Gorse 反馈：回复 + 同步新帖子
  gorseService.feedbackPostReply(authorId, target.id).catch(e => logger.debug('[gorse] reply feedback failed:', e.message));
  gorseService.upsertPost(post).catch(e => logger.debug('[gorse] reply upsert failed:', e.message));

  // 异步生成回复帖子向量
  queueManager.enqueuePostEmbedding(post.id).catch(e => logger.debug('[embedding] reply enqueue failed:', e.message));
  queueManager.enqueueUserEmbedding(authorId, false, 'post_reply').catch(e => logger.debug('[embedding] reply user enqueue failed:', e.message));

  const formattedPost = await serializePost(post, viewerId);
  const [postWithViews] = await attachPostViewCounts([formattedPost], viewerId);
  const refIds = collectReferencedIds([postWithViews]);
  const referencedPosts = await fetchReferencedPosts(refIds, viewerId);

  return {
    post: postWithViews,
    includes: { posts: referencedPosts },
  };
}

export async function retweetPost({ authorId, retweetPostId }) {
  const viewerId = authorId;
  await assertCanWrite(authorId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(retweetPostId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true, post_type: true, retweet_post_id: true, in_reply_to_id: true, content: true, embed: true },
  });
  if (!target) {
    throw postNotFound();
  }

  // 如果目标本身就是转推，自动追溯到原始推文
  let originalId = target.id;
  let originalAuthorId = target.author_id;
  // 默认使用目标帖子自身内容（目标是原始帖的情况）
  let originalContent = target.content;
  let originalEmbed = target.embed;
  if (target.post_type === "retweet" && target.retweet_post_id) {
    const original = await prisma.ow_posts.findFirst({
      where: { id: target.retweet_post_id, ...await visibleWhere("post", viewerId) },
      select: { id: true, author_id: true, content: true, embed: true },
    });
    if (!original) {
      throw new Error("原始推文不存在");
    }
    originalId = original.id;
    originalAuthorId = original.author_id;
    originalContent = original.content;
    originalEmbed = original.embed;
  }

  // 检查是否已经转推过该原始推文
  const existing = await prisma.ow_posts.findFirst({
    where: {
      author_id: authorId,
      retweet_post_id: originalId,
      post_type: "retweet",
      ...await visibleWhere("post", viewerId),
    },
    select: { id: true },
  });
  if (existing) {
    throw new Error("你已经转推过该推文");
  }

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.ow_posts.create({
      data: {
        author_id: authorId,
        post_type: "retweet",
        retweet_post_id: originalId,
        content: null,
        character_count: 0,
      },
      select: buildLeanSelect(),
    });

    await tx.ow_posts.update({
      where: { id: originalId },
      data: { retweet_count: { increment: 1 } },
    });

    return created;
  });

  if (originalAuthorId && originalAuthorId !== authorId) {
    const actorName = formatNotificationActorName(post.author);
    const targetLabel = getPostTargetLabel(target);
    await createNotification({
      notificationType: "post_retweet",
      notificationRequirement: "BASIC",
      title: `${actorName} 转发了你的${targetLabel}`,
      content: `${actorName} 转发了你的${targetLabel}`,
      userId: originalAuthorId,
      actorId: authorId,
      targetType: "post",
      targetId: originalId,
      data: { post_id: post.id },
    });
  }

  queueManager.enqueueSocialPostSync(authorId, post.id, "retweet").catch((error) => {
    logger.warn("推文社交同步入队失败(retweet):", error.message);
  });

  // Gorse 反馈：转推 + 推送转推帖子（使用原帖内容作为 Comment，以便语义检索）
  gorseService.feedbackPostRetweet(authorId, originalId).catch(e => logger.debug('[gorse] retweet feedback failed:', e.message));
  gorseService.upsertPost({
    ...post,
    content: originalContent,   // 填充原帖文字，转推本身 content 为 null
    embed: originalEmbed,
  }).catch(e => logger.debug('[gorse] retweet upsert failed:', e.message));

  // 纯转推不生成向量，但刷新作者用户向量
  queueManager.enqueueUserEmbedding(authorId, false, 'post_retweet').catch(e => logger.debug('[embedding] retweet user enqueue failed:', e.message));

  const formattedPost = await serializePost(post, viewerId);
  const [postWithViews] = await attachPostViewCounts([formattedPost], viewerId);
  const refIds = collectReferencedIds([postWithViews]);
  const referencedPosts = await fetchReferencedPosts(refIds, viewerId);

  return {
    post: postWithViews,
    includes: { posts: referencedPosts },
  };
}

export async function unretweetPost({ authorId, retweetPostId }) {
  const viewerId = authorId;
  await assertCanWrite(authorId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(retweetPostId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const retweet = await prisma.ow_posts.findFirst({
    where: await visiblePostWhere({
      author_id: authorId,
      retweet_post_id: target.id,
      post_type: "retweet",
    }, viewerId),
    select: { id: true },
  });
  if (!retweet) return { count: 0, retweetId: null };
  await softDeleteContent("post", retweet.id, authorId);
  const result = { count: 1, retweetId: retweet.id };

  if (result.count > 0 && result.retweetId) {
    queueManager.enqueueSocialPostSync(authorId, result.retweetId, "unretweet").catch((error) => {
      logger.warn("推文社交同步入队失败(unretweet):", error.message);
    });
    queueManager.enqueueUserEmbedding(authorId, false, 'post_unretweet').catch(e => logger.debug('[embedding] unretweet user enqueue failed:', e.message));
  }

  return result;
}

export async function quotePost({
  authorId,
  quotedPostId,
  content,
  mediaIds = [],
  embed,
}) {
  const viewerId = authorId;
  await assertCanWrite(authorId, "post", "create");
  // 确保静态URL已初始化
  await initStaticUrl();

  // 去重 mediaIds
  const uniqueMediaIds = dedupeMediaIds(mediaIds);

  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(quotedPostId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true, in_reply_to_id: true },
  });
  if (!target) {
    throw postNotFound();
  }

  const { characterCount, valid } = analyzePostContent(content);
  if (!content || characterCount === 0) {
    throw new Error("内容不能为空");
  }
  if (!valid) {
    throw new Error("内容超过字数限制");
  }
  if (uniqueMediaIds.length > MAX_MEDIA_COUNT) {
    throw new Error(`最多只能上传${MAX_MEDIA_COUNT}张图片`);
  }

  const validatedEmbed = await validatePostAttachments(authorId, uniqueMediaIds, validateEmbed(embed));
  const mentionedUsers = await resolveMentionedUsers(content, authorId);
  const mentionedUserIds = mentionedUsers.map((user) => user.id);

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.ow_posts.create({
      data: {
        author_id: authorId,
        post_type: "quote",
        content,
        character_count: characterCount,
        quoted_post_id: target.id,
        ...(validatedEmbed ? { embed: validatedEmbed } : {}),
      },
      select: buildLeanSelect(),
    });

    await tx.ow_posts.update({
      where: { id: target.id },
      data: { retweet_count: { increment: 1 } },
    });

    if (uniqueMediaIds.length > 0) {
      await tx.ow_posts_media.createMany({
        data: uniqueMediaIds.map((assetId, index) => ({
          post_id: created.id,
          asset_id: assetId,
          order: index,
        })),
      });
    }

    if (mentionedUserIds.length > 0) {
      await tx.ow_posts_mention.createMany({
        data: mentionedUserIds.map((userId) => ({
          post_id: created.id,
          user_id: userId,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  if (target.author_id && target.author_id !== authorId) {
    const actorName = formatNotificationActorName(post.author);
    const targetLabel = getPostTargetLabel(target);
    await createNotification({
      notificationType: "post_quote",
      notificationRequirement: "BASIC",
      title: `${actorName} 引用了你的${targetLabel}`,
      content: `${actorName} 引用了你的${targetLabel}`,
      userId: target.author_id,
      actorId: authorId,
      targetType: "post",
      targetId: target.id,
      data: { post_id: post.id },
    });
  }

  if (mentionedUsers.length > 0) {
    await notifyMentions(mentionedUsers, authorId, post.id, post.author);
  }

  queueManager.enqueueSocialPostSync(authorId, post.id, "quote").catch((error) => {
    logger.warn("推文社交同步入队失败(quote):", error.message);
  });

  // Gorse 反馈：引用 + 同步新帖子
  gorseService.feedbackPostQuote(authorId, target.id).catch(e => logger.debug('[gorse] quote feedback failed:', e.message));
  gorseService.upsertPost(post).catch(e => logger.debug('[gorse] quote upsert failed:', e.message));

  // 异步生成引用帖子向量
  queueManager.enqueuePostEmbedding(post.id).catch(e => logger.debug('[embedding] quote enqueue failed:', e.message));
  queueManager.enqueueUserEmbedding(authorId, false, 'post_quote').catch(e => logger.debug('[embedding] quote user enqueue failed:', e.message));

  const formattedPost = await serializePost(post, viewerId);
  const [postWithViews] = await attachPostViewCounts([formattedPost], viewerId);
  const refIds = collectReferencedIds([postWithViews]);
  const referencedPosts = await fetchReferencedPosts(refIds, viewerId);

  return {
    post: postWithViews,
    includes: { posts: referencedPosts },
  };
}

export async function likePost({ userId, postId }) {
  const viewerId = userId;
  await assertCanWrite(userId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true, in_reply_to_id: true },
  });
  if (!target) throw postNotFound();

  const like = await prisma.$transaction(async (tx) => {
    const existing = await tx.ow_posts_like.findUnique({
      where: { user_id_post_id: { user_id: userId, post_id: target.id } },
    });
    if (existing) return existing;

    const created = await tx.ow_posts_like.create({
      data: {
        user_id: userId,
        post_id: target.id,
      },
    });

    await tx.ow_posts.update({
      where: { id: target.id },
      data: { like_count: { increment: 1 } },
    });

    return created;
  });

  if (target.author_id && target.author_id !== userId) {
    const actorName = await getNotificationActorName(userId);
    const targetLabel = getPostTargetLabel(target);
    await createNotification({
      notificationType: "post_like",
      notificationRequirement: "BASIC",
      title: `${actorName} 喜欢了你的${targetLabel}`,
      content: `${actorName} 喜欢了你的${targetLabel}`,
      userId: target.author_id,
      actorId: userId,
      targetType: "post",
      targetId: target.id,
      data: { post_id: target.id },
    });
  }

  queueManager.enqueueSocialPostSync(userId, target.id, "like").catch((error) => {
    logger.warn("推文社交同步入队失败(like):", error.message);
  });

  // Gorse 反馈：点赞
  gorseService.feedbackPostLike(userId, target.id).catch(e => logger.debug('[gorse] like feedback failed:', e.message));

  // 点赞影响用户画像，刷新用户向量
  queueManager.enqueueUserEmbedding(userId, false, 'post_like').catch(e => logger.debug('[embedding] like user enqueue failed:', e.message));

  return like;
}

export async function unlikePost({ userId, postId }) {
  const viewerId = userId;
  await assertCanWrite(userId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const result = await prisma.$transaction(async (tx) => {
    const deleted = await tx.ow_posts_like.deleteMany({
      where: { user_id: userId, post_id: target.id },
    });

    if (deleted.count > 0) {
      await tx.ow_posts.update({
        where: { id: target.id },
        data: { like_count: { decrement: 1 } },
      });
    }

    return deleted;
  });

  if (result.count > 0) {
    queueManager.enqueueSocialPostSync(userId, target.id, "unlike").catch((error) => {
      logger.warn("推文社交同步入队失败(unlike):", error.message);
    });
    // Gorse 反馈：取消点赞
    gorseService.feedbackPostUnlike(userId, target.id).catch(e => logger.debug('[gorse] unlike feedback failed:', e.message));
    queueManager.enqueueUserEmbedding(userId, false, 'post_unlike').catch(e => logger.debug('[embedding] unlike user enqueue failed:', e.message));
  }

  return result;
}

export async function bookmarkPost({ userId, postId }) {
  const viewerId = userId;
  await assertCanWrite(userId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const bookmark = await prisma.$transaction(async (tx) => {
    const existing = await tx.ow_posts_bookmark.findUnique({
      where: { user_id_post_id: { user_id: userId, post_id: target.id } },
    });
    if (existing) return existing;

    const created = await tx.ow_posts_bookmark.create({
      data: {
        user_id: userId,
        post_id: target.id,
      },
    });

    await tx.ow_posts.update({
      where: { id: target.id },
      data: { bookmark_count: { increment: 1 } },
    });

    return created;
  });

  queueManager.enqueueSocialPostSync(userId, target.id, "bookmark").catch((error) => {
    logger.warn("推文社交同步入队失败(bookmark):", error.message);
  });

  // Gorse 反馈：收藏
  gorseService.feedbackPostBookmark(userId, target.id).catch(e => logger.debug('[gorse] bookmark feedback failed:', e.message));

  // 收藏影响用户画像，刷新用户向量
  queueManager.enqueueUserEmbedding(userId, false, 'post_bookmark').catch(e => logger.debug('[embedding] bookmark user enqueue failed:', e.message));

  return bookmark;
}

export async function unbookmarkPost({ userId, postId }) {
  const viewerId = userId;
  await assertCanWrite(userId, "post", "interact");
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const result = await prisma.$transaction(async (tx) => {
    const deleted = await tx.ow_posts_bookmark.deleteMany({
      where: { user_id: userId, post_id: target.id },
    });

    if (deleted.count > 0) {
      await tx.ow_posts.update({
        where: { id: target.id },
        data: { bookmark_count: { decrement: 1 } },
      });
    }

    return deleted;
  });

  if (result.count > 0) {
    queueManager.enqueueSocialPostSync(userId, target.id, "unbookmark").catch((error) => {
      logger.warn("推文社交同步入队失败(unbookmark):", error.message);
    });
    // Gorse 反馈：取消收藏
    gorseService.feedbackPostUnbookmark(userId, target.id).catch(e => logger.debug('[gorse] unbookmark feedback failed:', e.message));
    queueManager.enqueueUserEmbedding(userId, false, 'post_unbookmark').catch(e => logger.debug('[embedding] unbookmark user enqueue failed:', e.message));
  }

  return result;
}

/**
 * 标记帖子为已读（上报 Gorse read 反馈）
 * 登录用户：记录个人阅读反馈，用于个性化推荐去重
 * 未登录用户：直接忽略，不做任何操作
 */
export async function markPostRead({ userId, postId }) {
  if (!userId) return { acknowledged: false, reason: 'not_logged_in' };
  const post = await prisma.ow_posts.findFirst({
    where: await visiblePostWhere({ id: Number(postId) }, userId),
    select: { id: true },
  });
  if (!post) throw postNotFound();

  // 异步上报 Gorse，不阻塞响应
  gorseService.feedbackPostRead(userId, postId).catch(e =>
    logger.debug('[gorse] markPostRead feedback failed:', e.message)
  );

  return { acknowledged: true };
}

export async function deletePost({ userId, postId, authorization = null, authorizationContext = {} }) {
  await assertCanWrite(userId, "post", "delete");
  const post = await prisma.ow_posts.findFirst({
    where: await visiblePostWhere({ id: Number(postId) }, userId),
    select: { id: true, author_id: true },
  });
  if (!post) throw postNotFound();
  if (Number(post.author_id) !== Number(userId) && !authorization?.allowed) {
    throw Object.assign(new Error("没有权限删除该推文"), { status: 403, code: "ZC_ERROR_SCOPE_RESOURCE_FORBIDDEN" });
  }
  await softDeleteContent("post", post.id, userId, { authorizationContext });
  return { id: post.id, deleted: true };
}

export async function getDeletedPosts({ userId, cursor, page, limit = 20 }) {
  await initStaticUrl();
  const safeLimit = normalizePositiveInt(limit, 20);
  const safePage = normalizePositiveInt(page, 1, 100000);
  const ownerWhere = { author_id: Number(userId), OR: [{ is_deleted: true }, { deleted_at: { not: null } }] };
  const posts = await prisma.ow_posts.findMany({
    where: { ...ownerWhere, ...(cursor ? { id: { lt: Number(cursor) } } : {}) },
    orderBy: { id: "desc" },
    take: safeLimit,
    ...(page && !cursor ? { skip: (safePage - 1) * safeLimit } : {}),
    select: { ...buildLeanSelect(), deleted_at: true, deletion_source: true },
  });
  return {
    total: await prisma.ow_posts.count({ where: ownerWhere }),
    page: safePage,
    limit: safeLimit,
    posts: (await serializePosts(posts.map(raw => ({ ...raw, is_deleted: false, deleted_at: null })), userId))
      .map((post, index) => ({
        ...post,
        is_deleted: true,
        deleted_at: posts[index].deleted_at,
        can_restore: posts[index].deletion_source !== "admin" && posts[index].deletion_source !== "administrative",
      })),
    next_cursor: posts.length === safeLimit ? String(posts[posts.length - 1].id) : null,
    has_more: posts.length === safeLimit,
  };
}

export async function restorePost({ userId, postId, authorizationContext = {} }) {
  await assertCanWrite(userId, "post", "restore");
  const post = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), author_id: Number(userId) },
    select: { id: true },
  });
  if (!post) throw postNotFound();
  await restoreContent("post", post.id, userId, { authorizationContext });
  return { id: post.id, restored: true };
}

/**
 * 获取帖子的祖先链（向上遍历到最顶级帖子）
 * @param {number} postId - 起始帖子ID
 * @param {number} maxDepth - 最大遍历深度，防止无限循环
 * @returns {Promise<Array>} 祖先帖子列表，从最顶级到直接父贴的顺序
 */
async function getAncestorChains(postIds, viewerId = null, maxDepth = 50) {
  const starts = [...new Set(postIds.filter(Boolean).map(Number))];
  const records = new Map();
  let frontier = starts;
  const visibility = starts.length ? await visibleWhere("post", viewerId) : null;
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const rows = await prisma.ow_posts.findMany({
      where: { id: { in: frontier }, AND: [visibility] },
      select: buildLeanSelect(),
    });
    for (const id of frontier) records.set(id, null);
    for (const row of rows) records.set(row.id, row);
    frontier = [...new Set(rows.map(row => row.in_reply_to_id).filter(id => id && !records.has(id)))];
  }
  return new Map(starts.map(start => {
    const chain = [];
    const visited = new Set();
    let currentId = start;
    while (currentId && chain.length < maxDepth && !visited.has(currentId)) {
      visited.add(currentId);
      const row = records.get(currentId);
      if (!row) break;
      chain.push(row);
      currentId = row.in_reply_to_id;
    }
    return [start, chain.reverse()];
  }));
}

async function getAncestorChain(postId, viewerId = null, maxDepth = 50) {
  return (await getAncestorChains([postId], viewerId, maxDepth)).get(Number(postId)) || [];
}

/**
 * 获取作者点赞的回复ID列表
 * @param {number} postId - 帖子ID
 * @param {number} authorId - 作者ID
 * @returns {Promise<Set<number>>} 作者点赞的回复ID集合
 */
async function getAuthorLikedReplyIds(postId, authorId, viewerId = null) {
  const likes = await prisma.ow_posts_like.findMany({
    where: {
      user_id: authorId,
      user: { is: await visibleInteractionUserWhere(viewerId) },
      post: {
        in_reply_to_id: postId,
        ...await visibleWhere("post", viewerId),
      },
    },
    select: { post_id: true },
  });
  return new Set(likes.map((l) => l.post_id));
}

/**
 * 获取帖子的直接回复，并分类为精选和普通回复
 * @param {number} postId - 帖子ID
 * @param {number} authorId - 原帖作者ID
 * @param {number} postLikeCount - 原帖的点赞数
 * @param {number} viewerId - 查看者ID
 * @returns {Promise<{featured: Array, regular: Array}>} 分类后的回复
 */
async function getRepliesWithClassification(postId, authorId, postLikeCount, viewerId = null) {
  // 获取所有直接回复
  const directReplies = await prisma.ow_posts.findMany({
    where: {
      in_reply_to_id: Number(postId),
      ...await visibleWhere("post", viewerId),
    },
    orderBy: [{ like_count: "desc" }, { created_at: "asc" }],
    select: buildLeanSelect(),
  });

  if (directReplies.length === 0) {
    return { featured: [], regular: [] };
  }

  // 获取作者点赞的回复ID
  const authorLikedIds = await getAuthorLikedReplyIds(postId, authorId, viewerId);

  // 格式化回复并添加viewer context
  let formattedReplies = await serializePosts(directReplies, viewerId);
  formattedReplies = await addViewerContext(formattedReplies, viewerId);
  formattedReplies = await attachPostViewCounts(formattedReplies, viewerId);

  // 分类回复
  const featured = [];
  const regular = [];

  for (let i = 0; i < directReplies.length; i++) {
    const raw = directReplies[i];
    const formatted = formattedReplies[i];

    const isAuthorLiked = authorLikedIds.has(raw.id);
    const hasHighLikes = formatted.stats.likes > postLikeCount;

    if (isAuthorLiked || hasHighLikes) {
      featured.push({
        ...formatted,
        featured_reason: isAuthorLiked
          ? hasHighLikes
            ? "author_liked_and_high_likes"
            : "author_liked"
          : "high_likes",
      });
    } else {
      regular.push(formatted);
    }
  }

  return { featured, regular };
}

export async function getPostById(postId, viewerId = null) {
  await initStaticUrl();
  const raw = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: buildLeanSelect(),
  });
  if (!raw) return null;

  let post = await serializePost(raw, viewerId);
  const [enriched] = await addViewerContext([post], viewerId);
  post = enriched;
  [post] = await attachPostViewCounts([post], viewerId);

  // 获取祖先链（如果是回复帖子）
  let ancestors = [];
  if (raw.in_reply_to_id) {
    const ancestorRaws = await getAncestorChain(raw.in_reply_to_id, viewerId);
    // 排除当前帖子本身（如果意外出现）
    const filteredAncestors = ancestorRaws.filter((a) => a.id !== raw.id);
    ancestors = await serializePosts(filteredAncestors, viewerId);
    ancestors = await addViewerContext(ancestors, viewerId);
    ancestors = await attachPostViewCounts(ancestors, viewerId);
  }

  // 获取分类后的回复
  const { featured: featuredReplies, regular: regularReplies } =
    await getRepliesWithClassification(raw.id, raw.author_id, post.stats.likes, viewerId);

  // 收集所有需要引用的帖子ID
  const allPosts = [post, ...ancestors, ...featuredReplies, ...regularReplies];
  const refIds = collectReferencedIds(allPosts);

  // 排除已在响应中的帖子
  const existingIds = new Set(allPosts.map((p) => p.id));
  const filteredRefIds = refIds.filter((id) => !existingIds.has(id));

  let referencedPosts = await fetchReferencedPosts(filteredRefIds, viewerId);

  if (viewerId && Object.keys(referencedPosts).length > 0) {
    const refPostsArray = Object.values(referencedPosts);
    const enrichedRefs = await addViewerContext(refPostsArray, viewerId);
    referencedPosts = {};
    for (const p of enrichedRefs) {
      referencedPosts[p.id] = p;
    }
  }

  return {
    post,
    ancestors, // 祖先链，从最顶级到直接父贴
    replies: {
      featured: featuredReplies, // 精选回复（作者点赞/高赞）
      regular: regularReplies, // 普通回复
    },
    includes: { posts: referencedPosts },
  };
}

export async function getRelatedPosts({
  embedData,
  cursor,
  limit = 20,
  includeReplies = false,
  viewerId = null,
}) {
  await initStaticUrl();

  if (
    embedData === null ||
    typeof embedData !== "object" ||
    Array.isArray(embedData)
  ) {
    throw new Error("embeddata 必须是对象");
  }

  const clauses = buildEmbedSubsetClauses(embedData);
  if (clauses.length === 0) {
    throw new Error("embeddata 至少提供一个筛选条件");
  }

  const safeLimit = normalizePositiveInt(limit, 20);
  const safeCursor = normalizeCursor(cursor);

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      embed: { not: null },
      ...(includeReplies ? {} : { post_type: { not: "reply" } }),
      ...(safeCursor ? { created_at: { lt: new Date(safeCursor) } } : {}),
      AND: [...clauses, await visibleWhere("post", viewerId)],
    },
    orderBy: { created_at: "desc" },
    take: safeLimit,
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, safeLimit, viewerId);
}

export async function getUserPosts({
  userId,
  cursor,
  limit = 20,
  includeReplies = false,
  viewerId = null,
}) {
  await initStaticUrl();
  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      author_id: Number(userId),
      ...await visibleWhere("post", viewerId),
      ...(includeReplies ? {} : { post_type: { not: "reply" } }),
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, viewerId);
}

export async function getHomeFeed({
  userId = null,
  cursor,
  limit = 20,
  includeReplies = false,
  followingOnly = false,
}) {
  const viewerId = userId;
  await initStaticUrl();

  // 获取当前用户关注列表（用于 followingOnly 以及联邦帖子过滤）
  let followedIds = [];
  if (userId) {
    const follows = await prisma.ow_user_relationships.findMany({
      where: {
        source_user_id: Number(userId),
        relationship_type: "follow",
      },
      select: { target_user_id: true },
    });
    followedIds = follows.map((rel) => rel.target_user_id).filter(Boolean);
  }

  let authorFilter = {};
  if (followingOnly && userId) {
    const authorIds = [Number(userId), ...followedIds];
    authorFilter = { author_id: { in: authorIds } };
  }

  // 联邦社交（ActivityPub）帖子过滤规则：
  // - 未登录用户：不展示任何联邦帖子
  // - 已登录 + followingOnly：已通过 authorFilter 限定为关注列表，无需额外过滤
  // - 已登录 + 全局时间线：排除未被当前用户关注的联邦用户帖子
  let federationFilter = {};
  if (!userId) {
    // 未登录：排除所有远程用户的帖子
    federationFilter = { author: { type: { not: "remote_activitypub" } } };
  } else if (!followingOnly) {
    // 已登录 + 全局时间线：仅展示已关注的联邦用户帖子
    federationFilter = {
      NOT: {
        author: { type: "remote_activitypub" },
        author_id: { notIn: followedIds },
      },
    };
  }

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      ...(includeReplies ? {} : { post_type: { not: "reply" } }),
      ...authorFilter,
      AND: [federationFilter, await visibleWhere("post", viewerId)],
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, userId);
}

/**
 * 全局时间线 — 展示所有帖子（含联邦社交帖），按帖子原始发布时间排序
 * 仅限已登录用户访问
 */
export async function getGlobalFeed({
  userId,
  cursor,
  limit = 20,
  includeReplies = false,
}) {
  const viewerId = userId;
  await initStaticUrl();

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);

  // cursor 为 ISO 8601 时间戳字符串，用于基于 created_at 的分页
  let cursorFilter = {};
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate.getTime())) {
      cursorFilter = { created_at: { lt: cursorDate } };
    }
  }

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      ...await visibleWhere("post", viewerId),
      ...(includeReplies ? {} : { post_type: { not: "reply" } }),
      ...cursorFilter,
    },
    orderBy: { created_at: "desc" },
    take: safeLimit,
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, safeLimit, viewerId);
}

export async function getThread(postId, { cursor, limit = 50, viewerId = null } = {}) {
  await initStaticUrl();

  // 获取请求的帖子
  const raw = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: buildLeanSelect(),
  });
  if (!raw) return null;

  let post = await serializePost(raw, viewerId);
  const [enrichedPost] = await addViewerContext([post], viewerId);
  post = enrichedPost;
  [post] = await attachPostViewCounts([post], viewerId);

  // 获取祖先链（如果是回复帖子）
  let ancestors = [];
  let rootAuthorId = raw.author_id;
  if (raw.in_reply_to_id) {
    const ancestorRaws = await getAncestorChain(raw.in_reply_to_id, viewerId);
    const filteredAncestors = ancestorRaws.filter((a) => a.id !== raw.id);
    rootAuthorId = filteredAncestors[0]?.author_id || raw.author_id;
    ancestors = await serializePosts(filteredAncestors, viewerId);
    ancestors = await addViewerContext(ancestors, viewerId);
    ancestors = await attachPostViewCounts(ancestors, viewerId);
  }

  // 确定线程根ID
  const threadRootId = raw.thread_root_id || raw.id;

  // 获取线程中的所有回复
  const repliesRaw = await prisma.ow_posts.findMany({
    where: {
      ...await visibleWhere("post", viewerId),
      thread_root_id: threadRootId,
      ...(cursor ? { created_at: { gt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "asc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  let replies = await serializePosts(repliesRaw, viewerId);
  replies = await addViewerContext(replies, viewerId);
  replies = await attachPostViewCounts(replies, viewerId);

  // 获取根帖作者点赞的所有回复ID
  const allReplyIds = repliesRaw.map((r) => r.id);
  const authorLikedIds = allReplyIds.length > 0
    ? new Set(
        (
          await prisma.ow_posts_like.findMany({
            where: {
              user_id: rootAuthorId,
              user: { is: await visibleInteractionUserWhere(viewerId) },
              post_id: { in: allReplyIds },
            },
            select: { post_id: true },
          })
        ).map((l) => l.post_id)
      )
    : new Set();

  // 将回复按父帖ID分组，并分类为精选/普通
  const repliesByParent = {};
  const rootLikeCount = ancestors.length > 0 ? ancestors[0].stats.likes : post.stats.likes;

  for (let i = 0; i < repliesRaw.length; i++) {
    const rawReply = repliesRaw[i];
    const formatted = replies[i];
    const parentId = rawReply.in_reply_to_id || threadRootId;

    if (!repliesByParent[parentId]) {
      repliesByParent[parentId] = { featured: [], regular: [] };
    }

    const isAuthorLiked = authorLikedIds.has(rawReply.id);
    const hasHighLikes = formatted.stats.likes > rootLikeCount;

    if (isAuthorLiked || hasHighLikes) {
      repliesByParent[parentId].featured.push({
        ...formatted,
        featured_reason: isAuthorLiked
          ? hasHighLikes
            ? "author_liked_and_high_likes"
            : "author_liked"
          : "high_likes",
      });
    } else {
      repliesByParent[parentId].regular.push(formatted);
    }
  }

  // 收集引用的帖子
  const allPosts = [post, ...ancestors, ...replies];
  const refIds = collectReferencedIds(allPosts);
  const existingIds = new Set(allPosts.map((p) => p.id));
  const filteredRefIds = refIds.filter((id) => !existingIds.has(id));
  let referencedPosts = await fetchReferencedPosts(filteredRefIds, viewerId);

  if (viewerId && Object.keys(referencedPosts).length > 0) {
    const refPostsArray = Object.values(referencedPosts);
    const enrichedRefs = await addViewerContext(refPostsArray, viewerId);
    referencedPosts = {};
    for (const p of enrichedRefs) {
      referencedPosts[p.id] = p;
    }
  }

  const hasMore = repliesRaw.length === Number(limit);
  const nextCursor =
    repliesRaw.length > 0
      ? repliesRaw[repliesRaw.length - 1].created_at.toISOString()
      : null;

  return {
    post,                              // 请求的帖子（始终是主体）
    ancestors,                         // 祖先链（从根帖到直接父帖）
    replies_by_parent: repliesByParent, // 按父帖分组的回复
    includes: { posts: referencedPosts },
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

export async function getMentions({ userId, cursor, limit = 20 }) {
  const viewerId = userId;
  await initStaticUrl();
  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      ...await visibleWhere("post", viewerId),
      mentions: {
        some: {
          user_id: Number(userId),
        },
      },
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, userId);
}

/**
 * 获取帖子的所有转推
 */
export async function getPostRetweets({ postId, cursor, limit = 20, viewerId = null }) {
  await initStaticUrl();

  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      retweet_post_id: target.id,
      post_type: "retweet",
      ...await visibleWhere("post", viewerId),
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, viewerId);
}

/**
 * 获取帖子的所有引用
 */
export async function getPostQuotes({ postId, cursor, limit = 20, viewerId = null }) {
  await initStaticUrl();

  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true },
  });
  if (!target) throw postNotFound();

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      quoted_post_id: target.id,
      post_type: "quote",
      ...await visibleWhere("post", viewerId),
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, viewerId);
}

/**
 * 获取帖子的点赞用户列表（仅发帖人可见）
 */
export async function getPostLikes({ postId, cursor, limit = 20, viewerId }) {
  await initStaticUrl();

  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true },
  });
  if (!target) throw postNotFound();

  // 仅发帖人可见
  if (!viewerId || target.author_id !== Number(viewerId)) {
    throw new Error("无权查看点赞列表");
  }

  const likes = await prisma.ow_posts_like.findMany({
    where: {
      post_id: target.id,
      user: { is: await visibleInteractionUserWhere(viewerId) },
      ...(cursor ? { id: { lt: Number(cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: Number(limit),
    select: {
      id: true,
      created_at: true,
      user: {
        select: { id: true, username: true, display_name: true, avatar: true },
      },
    },
  });

  const users = likes.map((l) => ({
    id: l.user?.id,
    username: l.user?.username,
    display_name: l.user?.display_name,
    avatar: l.user?.avatar,
    liked_at: l.created_at,
  }));

  const hasMore = likes.length === Number(limit);
  const nextCursor = likes.length > 0 ? String(likes[likes.length - 1].id) : null;

  return {
    users,
    total: await prisma.ow_posts_like.count({ where: { post_id: target.id, user: { is: await visibleInteractionUserWhere(viewerId) } } }),
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

/**
 * 获取帖子的互动分析（转推数、引用数、点赞数等）
 */
export async function getPostAnalytics({ postId, viewerId }) {
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: {
      id: true,
      author_id: true,
      reply_count: true,
      retweet_count: true,
      like_count: true,
      bookmark_count: true,
    },
  });
  if (!target) throw postNotFound();

  // 仅发帖人可见详细分析
  const isAuthor = viewerId && target.author_id === Number(viewerId);

  // 获取引用数（quote类型）
  const quoteCount = await prisma.ow_posts.count({
    where: {
      quoted_post_id: target.id,
      post_type: "quote",
      ...await visibleWhere("post", viewerId),
    },
  });

  const [{ stats }] = await attachPostViewCounts([{ id: target.id }], viewerId);

  const result = {
    post_id: target.id,
    reply_count: stats.replies,
    retweet_count: Math.max(0, stats.retweets - quoteCount),
    quote_count: quoteCount,
    like_count: stats.likes,
  };

  // Count distinct visitors in SQL, retaining the existing single null-device bucket.
  const [visitors] = await prisma.$queryRaw`
    SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT device_id FROM ow_analytics_event
      WHERE target_type = 'post' AND target_id = ${target.id}
    ) devices
  `;
  const viewCount = stats.views;
  result.view_count = viewCount;
  result.visitor_count = Number(visitors.count);
  result.engagement_count =
    stats.replies + stats.retweets + stats.likes + stats.bookmarks;
  result.engagement_rate =
    viewCount > 0 ? Number(((result.engagement_count / viewCount) * 100).toFixed(2)) : 0;

  // 仅作者可见收藏数
  if (isAuthor) {
    result.bookmark_count = stats.bookmarks;
  }

  return result;
}

/**
 * 获取帖子浏览分析明细（基于 ow_analytics_event / ow_analytics_device）
 * 仅发帖人可查看
 */
export async function getPostViewAnalytics({ postId, viewerId, startDate, endDate }) {
  const target = await prisma.ow_posts.findFirst({
    where: { id: Number(postId), ...await visibleWhere("post", viewerId) },
    select: { id: true, author_id: true },
  });
  if (!target) throw postNotFound();

  if (!viewerId || target.author_id !== Number(viewerId)) {
    throw new Error("无权查看帖子浏览分析");
  }

  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const parsedStart = startDate ? new Date(startDate) : defaultStart;
  const parsedEnd = endDate ? new Date(endDate) : now;

  if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
    throw new Error("无效的日期格式");
  }

  if (parsedStart > parsedEnd) {
    throw new Error("开始时间不能晚于结束时间");
  }

  const rangeStart = new Date(parsedStart);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(parsedEnd);
  rangeEnd.setHours(23, 59, 59, 999);

  const analytics = await getAnalytics(
    "post",
    target.id,
    parsedStart.toISOString().split("T")[0],
    parsedEnd.toISOString().split("T")[0]
  );

  const [
    likes,
    bookmarks,
    replies,
    retweets,
    quotes,
  ] = await Promise.all([
    prisma.ow_posts_like.findMany({
      where: {
        post_id: target.id,
        user: { is: await visibleInteractionUserWhere(viewerId) },
        created_at: { gte: rangeStart, lte: rangeEnd },
      },
      select: { created_at: true },
    }),
    prisma.ow_posts_bookmark.findMany({
      where: {
        post_id: target.id,
        user: { is: await visibleInteractionUserWhere(viewerId) },
        created_at: { gte: rangeStart, lte: rangeEnd },
      },
      select: { created_at: true },
    }),
    prisma.ow_posts.findMany({
      where: {
        in_reply_to_id: target.id,
        post_type: "reply",
        ...await visibleWhere("post", viewerId),
        created_at: { gte: rangeStart, lte: rangeEnd },
      },
      select: { created_at: true },
    }),
    prisma.ow_posts.findMany({
      where: {
        retweet_post_id: target.id,
        post_type: "retweet",
        ...await visibleWhere("post", viewerId),
        created_at: { gte: rangeStart, lte: rangeEnd },
      },
      select: { created_at: true },
    }),
    prisma.ow_posts.findMany({
      where: {
        quoted_post_id: target.id,
        post_type: "quote",
        ...await visibleWhere("post", viewerId),
        created_at: { gte: rangeStart, lte: rangeEnd },
      },
      select: { created_at: true },
    }),
  ]);

  const bucketByDay = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const day = new Date(row.created_at).toISOString().slice(0, 10);
      map.set(day, (map.get(day) || 0) + 1);
    }
    return map;
  };

  const likesByDay = bucketByDay(likes);
  const bookmarksByDay = bucketByDay(bookmarks);
  const repliesByDay = bucketByDay(replies);
  const retweetsByDay = bucketByDay(retweets);
  const quotesByDay = bucketByDay(quotes);

  const allDays = new Set([
    ...likesByDay.keys(),
    ...bookmarksByDay.keys(),
    ...repliesByDay.keys(),
    ...retweetsByDay.keys(),
    ...quotesByDay.keys(),
  ]);

  const engagementSeries = [...allDays]
    .sort()
    .map((day) => {
      const likeCount = likesByDay.get(day) || 0;
      const bookmarkCount = bookmarksByDay.get(day) || 0;
      const replyCount = repliesByDay.get(day) || 0;
      const retweetCount = retweetsByDay.get(day) || 0;
      const quoteCount = quotesByDay.get(day) || 0;
      return {
        x: `${day}T00:00:00`,
        y: likeCount + bookmarkCount + replyCount + retweetCount + quoteCount,
      };
    });

  const impressions = analytics?.overview?.pageviews?.value || 0;
  const engagements =
    likes.length + bookmarks.length + replies.length + retweets.length + quotes.length;
  const engagementRate = impressions > 0
    ? Number(((engagements / impressions) * 100).toFixed(2))
    : 0;

  return {
    post_id: target.id,
    range: {
      start_date: parsedStart.toISOString().split("T")[0],
      end_date: parsedEnd.toISOString().split("T")[0],
    },
    twitter_like_overview: {
      impressions,
      detail_expands: impressions,
      engagements,
      engagement_rate: engagementRate,
      likes: likes.length,
      replies: replies.length,
      reposts: retweets.length,
      quotes: quotes.length,
      bookmarks: bookmarks.length,
    },
    engagement_breakdown: {
      likes: likes.length,
      replies: replies.length,
      reposts: retweets.length,
      quotes: quotes.length,
      bookmarks: bookmarks.length,
    },
    twitter_like_timeseries: {
      impressions: analytics?.timeseries?.pageviews || [],
      visitors: analytics?.timeseries?.sessions || [],
      engagements: engagementSeries,
    },
    ...analytics,
  };
}

/**
 * 构建带祖先链的回帖列表响应
 */
async function buildRepliesListResponse(rawPosts, limit, viewerId = null) {
  const chains = await getAncestorChains(rawPosts.map(post => post.in_reply_to_id), viewerId);
  const uniqueRaws = new Map(rawPosts.map(post => [post.id, post]));
  for (const chain of chains.values()) {
    for (const post of chain) {
      if (!uniqueRaws.has(post.id)) uniqueRaws.set(post.id, post);
    }
  }
  const enriched = await buildListResponse([...uniqueRaws.values()], Infinity, viewerId);
  const postMap = new Map(enriched.posts.map(post => [post.id, post]));
  const postsWithAncestors = rawPosts.map(raw => ({
    post: postMap.get(raw.id),
    ancestors: (chains.get(raw.in_reply_to_id) || []).filter(ancestor => ancestor.id !== raw.id)
      .map(ancestor => postMap.get(ancestor.id)),
  }));
  const referencedPosts = enriched.includes.posts;

  const hasMore = rawPosts.length === Number(limit);
  const nextCursor =
    rawPosts.length > 0
      ? rawPosts[rawPosts.length - 1].created_at.toISOString()
      : null;

  return {
    items: postsWithAncestors,
    includes: { posts: referencedPosts },
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

/**
 * 获取用户的所有回帖（带祖先链）
 */
export async function getUserReplies({ userId, cursor, limit = 20, viewerId = null }) {
  await initStaticUrl();

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      author_id: Number(userId),
      post_type: "reply",
      ...await visibleWhere("post", viewerId),
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildRepliesListResponse(rawPosts, limit, viewerId);
}

/**
 * 获取用户的所有主贴（非回复）
 */
export async function getUserOriginalPosts({ userId, cursor, limit = 20, viewerId = null }) {
  await initStaticUrl();

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      author_id: Number(userId),
      post_type: "normal",
      ...await visibleWhere("post", viewerId),
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, viewerId);
}

/**
 * 获取用户的所有带媒体的帖子
 */
export async function getUserMediaPosts({ userId, cursor, limit = 20, viewerId = null }) {
  await initStaticUrl();

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      author_id: Number(userId),
      ...await visibleWhere("post", viewerId),
      post_media: {
        some: {},
      },
      ...(cursor ? { created_at: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { created_at: "desc" },
    take: Number(limit),
    select: buildLeanSelect(),
  });

  return buildListResponse(rawPosts, limit, viewerId);
}

/**
 * 获取用户喜欢的帖子（仅自己可见）
 */
export async function getUserLikedPosts({ userId, cursor, limit = 20, viewerId }) {
  await initStaticUrl();

  // 仅自己可见
  if (!viewerId || Number(userId) !== Number(viewerId)) {
    throw new Error("无权查看喜欢列表");
  }

  const likes = await prisma.ow_posts_like.findMany({
    where: {
      user_id: Number(userId),
      post: {
        ...await visibleWhere("post", viewerId),
      },
      ...(cursor ? { id: { lt: Number(cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: Number(limit),
    select: {
      id: true,
      post: {
        select: buildLeanSelect(),
      },
    },
  });

  const rawPosts = likes.map((l) => l.post).filter(Boolean);
  const { posts, includes: { posts: referencedPosts } } = await buildListResponse(rawPosts, Infinity, viewerId);

  const hasMore = likes.length === Number(limit);
  const nextCursor = likes.length > 0 ? String(likes[likes.length - 1].id) : null;

  return {
    posts,
    includes: { posts: referencedPosts },
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

/**
 * 获取用户的收藏（仅自己可见）
 */
export async function getUserBookmarks({ userId, cursor, limit = 20, viewerId }) {
  await initStaticUrl();

  // 仅自己可见
  if (!viewerId || Number(userId) !== Number(viewerId)) {
    throw new Error("无权查看收藏列表");
  }

  const bookmarks = await prisma.ow_posts_bookmark.findMany({
    where: {
      user_id: Number(userId),
      post: {
        ...await visibleWhere("post", viewerId),
      },
      ...(cursor ? { id: { lt: Number(cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: Number(limit),
    select: {
      id: true,
      post: {
        select: buildLeanSelect(),
      },
    },
  });

  const rawPosts = bookmarks.map((b) => b.post).filter(Boolean);
  const { posts, includes: { posts: referencedPosts } } = await buildListResponse(rawPosts, Infinity, viewerId);

  const hasMore = bookmarks.length === Number(limit);
  const nextCursor = bookmarks.length > 0 ? String(bookmarks[bookmarks.length - 1].id) : null;

  return {
    posts,
    includes: { posts: referencedPosts },
    next_cursor: hasMore ? nextCursor : null,
    has_more: hasMore,
  };
}

export { countPostCharacters, POST_CHAR_LIMIT, MAX_MEDIA_COUNT };

/**
 * 获取 Gorse 个性化推荐帖子列表
 * 已登录用户使用个性化推荐，未登录用户使用热门/最新帖子
 */
export async function getRecommendedFeed({
  userId = null,
  limit = 20,
  offset = 0,
}) {
  const viewerId = userId;
  await initStaticUrl();

  let postIds;
  if (userId) {
    postIds = await gorseService.getRecommendedPostIds(userId, { limit, offset });
  } else {
    postIds = await gorseService.getLatestPostIds({ limit, offset });
  }

  // 如果 Gorse 无结果，降级到按时间排序
  if (!postIds || postIds.length === 0) {
    return getHomeFeed({ userId, limit, includeReplies: false, followingOnly: false });
  }

  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      id: { in: postIds },
      ...await visibleWhere("post", viewerId),
    },
    select: buildLeanSelect(),
  });

  // 按 Gorse 推荐顺序排序
  const postMap = new Map(rawPosts.map(p => [p.id, p]));
  const orderedRaw = postIds
    .map(id => postMap.get(id))
    .filter(Boolean);

  const { posts, includes: { posts: referencedPosts } } = await buildListResponse(orderedRaw, Infinity, viewerId);

  const hasMore = postIds.length === limit;

  return {
    posts,
    includes: { posts: referencedPosts },
    next_offset: hasMore ? offset + limit : null,
    has_more: hasMore,
  };
}

// ======================== 混合推荐（帖子 + 作品 + 用户） ========================

/**
 * 获取混合推荐信息流：帖子、作品、用户交错排列
 * 已登录用户使用 Gorse 个性化推荐，未登录用户仅返回最新帖子
 */
export async function getMixedRecommendFeed({
  userId = null,
  limit = 20,
  offset = 0,
}) {
  const viewerId = userId;
  await initStaticUrl();

  if (!userId) {
    // 未登录用户降级为普通帖子推荐
    return getRecommendedFeed({ userId, limit, offset });
  }

  // 并行获取三类推荐 ID
  const [postIds, projectIds, userIds] = await Promise.all([
    gorseService.getRecommendedPostIds(userId, { limit: limit + 5, offset }),
    gorseService.getRecommendedProjectIds(userId, { limit: 8, offset: Math.floor(offset / 3) }),
    gorseService.getRecommendedUserIds(userId, { limit: 5, offset: Math.floor(offset / 4) }),
  ]);

  // 如果全部为空，降级为时间线
  if ((!postIds || postIds.length === 0) && (!projectIds || projectIds.length === 0)) {
    return getRecommendedFeed({ userId, limit, offset });
  }

  // 并行获取实际数据
  const [rawPosts, rawProjects, rawUsers] = await Promise.all([
    postIds && postIds.length > 0
      ? prisma.ow_posts.findMany({
          where: { id: { in: postIds }, ...await visibleWhere("post", viewerId) },
          select: buildLeanSelect(),
        })
      : Promise.resolve([]),
    projectIds && projectIds.length > 0
      ? prisma.ow_projects.findMany({
          where: {
            id: { in: projectIds },
            AND: [await visibleWhere("project", viewerId), { state: 'public' }],
            authorid: { not: userId },
          },
          select: {
            id: true, name: true, title: true, description: true,
            type: true, thumbnail: true, authorid: true,
            view_count: true, star_count: true, like_count: true,
            time: true,
            author: {
              select: { id: true, username: true, display_name: true, avatar: true },
            },
          },
        })
      : Promise.resolve([]),
    userIds && userIds.length > 0
      ? prisma.ow_users.findMany({
          where: { AND: [{ id: { in: userIds }, status: 'active', NOT: { id: userId } }, await visibleWhere("profile", viewerId)] },
          select: {
            id: true, username: true, display_name: true,
            bio: true, avatar: true, motto: true,
          },
        })
      : Promise.resolve([]),
  ]);

  // 按 Gorse 顺序排列
  const postMap = new Map(rawPosts.map(p => [p.id, p]));
  const orderedPosts = postIds.map(id => postMap.get(id)).filter(Boolean);

  const projectMap = new Map(rawProjects.map(p => [Number(p.id), p]));
  const orderedProjects = projectIds.map(id => projectMap.get(Number(id))).filter(Boolean);

  const userMap = new Map(rawUsers.map(u => [Number(u.id), u]));
  const orderedUsers = userIds.map(id => userMap.get(Number(id))).filter(Boolean);

  // 格式化帖子
  let posts = await serializePosts(orderedPosts, viewerId);
  posts = await addViewerContext(posts, userId);
  posts = await attachPostViewCounts(posts, viewerId);

  // 为作品附加头像 URL
  const projectAuthors = await sanitizeProfiles(orderedProjects.map(project => project.author ? {
    ...project.author,
    avatarURL: buildAuthorAvatarUrl(project.author.avatar),
  } : null), viewerId);
  const projectsWithAvatar = orderedProjects.map((project, index) => ({ ...project, author: projectAuthors[index] }));

  // 为用户附加头像 URL
  const usersWithAvatar = await Promise.all(orderedUsers.map(async (u) => ({
    ...u,
    avatarURL: buildAuthorAvatarUrl(u.avatar),
  })));

  // 交错排列：帖子为主，每隔 3-4 个帖子插入一个作品或用户
  const items = [];
  let postIdx = 0;
  let projectIdx = 0;
  let userIdx = 0;
  let postCount = 0;

  while (postIdx < posts.length || projectIdx < projectsWithAvatar.length || userIdx < usersWithAvatar.length) {
    // 每 3 个帖子后插入一个非帖子内容
    if (postCount > 0 && postCount % 3 === 0 && (projectIdx < projectsWithAvatar.length || userIdx < usersWithAvatar.length)) {
      if (projectIdx < projectsWithAvatar.length && (userIdx >= usersWithAvatar.length || projectIdx <= userIdx)) {
        items.push({ type: 'project', data: projectsWithAvatar[projectIdx++] });
      } else if (userIdx < usersWithAvatar.length) {
        items.push({ type: 'user', data: usersWithAvatar[userIdx++] });
      }
    }

    if (postIdx < posts.length) {
      items.push({ type: 'post', data: posts[postIdx++] });
      postCount++;
    } else if (projectIdx < projectsWithAvatar.length) {
      items.push({ type: 'project', data: projectsWithAvatar[projectIdx++] });
    } else if (userIdx < usersWithAvatar.length) {
      items.push({ type: 'user', data: usersWithAvatar[userIdx++] });
    } else {
      break;
    }
  }

  // 截取到请求的 limit
  const pagedItems = items.slice(0, limit);
  const hasMore = items.length > limit || postIds.length === limit + 5;

  // 收集引用帖子
  const refIds = collectReferencedIds(posts);
  let referencedPosts = await fetchReferencedPosts(refIds, viewerId);
  if (Object.keys(referencedPosts).length > 0) {
    const refPostsArray = Object.values(referencedPosts);
    const enriched = await addViewerContext(refPostsArray, userId);
    referencedPosts = {};
    for (const p of enriched) {
      referencedPosts[p.id] = p;
    }
  }

  return {
    items: pagedItems,
    includes: { posts: referencedPosts },
    next_offset: hasMore ? offset + limit : null,
    has_more: hasMore,
  };
}

// ======================== 向量相似帖子 ========================

/**
 * 获取与指定帖子相似的帖子（基于向量相似度搜索）
 * @param {Object} params
 * @param {number} params.postId - 帖子 ID
 * @param {number} [params.limit=10] - 返回数量
 * @param {number|null} [params.viewerId] - 当前查看者 ID
 * @param {number|null} [params.minSimilarity] - 相似度下限（0~1）
 * @returns {Promise<Object>}
 */
export async function getSimilarPosts({ postId, limit = 10, viewerId = null, minSimilarity = null }) {
  await initStaticUrl();

  const enabled = await zcconfig.get('embedding.enabled');
  if (!enabled) {
    return { posts: [], includes: { posts: {} }, message: 'Embedding 服务未启用' };
  }

  const nPostId = Number(postId);
  if (isNaN(nPostId)) throw new Error('无效的帖子 ID');

  const sourcePost = await prisma.ow_posts.findFirst({
    where: { id: nPostId, ...await visibleWhere("post", viewerId) },
    select: {
      id: true,
      post_type: true,
      content: true,
      embed: true,
    },
  });
  if (!sourcePost) {
    throw new Error('帖子不存在');
  }

  let vector = await embeddingService.getEmbedding('post', nPostId);
  if (!vector) {
    const sourceText = embeddingService.buildPostText(sourcePost);
    if (!sourceText) {
      return { posts: [], includes: { posts: {} }, message: '该帖子无可用于向量的内容' };
    }

    vector = await embeddingService.generateEmbedding(sourceText);
    if (!vector) {
      return { posts: [], includes: { posts: {} }, message: '该帖子向量生成失败' };
    }

    try {
      await embeddingService.saveEmbedding('post', nPostId, vector, embeddingService.hashText(sourceText));
      await prisma.ow_posts.update({ where: { id: nPostId }, data: { embedding_at: new Date() } });
    } catch (e) {
      logger.debug(`[embedding] on-demand save post embedding failed: ${e.message}`);
    }
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const similarityThreshold =
    minSimilarity === null || minSimilarity === undefined
      ? null
      : Math.min(Math.max(Number(minSimilarity), 0), 1);

  // 搜索相似帖子（排除自身）
  const similarResults = await embeddingService.searchSimilar('post', vector, safeLimit + 20, [nPostId]);
  if (!similarResults || similarResults.length === 0) {
    return {
      posts: [],
      includes: { posts: {} },
      source_post_id: nPostId,
      min_similarity: similarityThreshold,
    };
  }

  const filteredResults =
    similarityThreshold === null
      ? similarResults
      : similarResults.filter((r) => Number(r.similarity) >= similarityThreshold);

  if (filteredResults.length === 0) {
    return {
      posts: [],
      includes: { posts: {} },
      source_post_id: nPostId,
      min_similarity: similarityThreshold,
    };
  }

  // 查询帖子详情（过滤已删除）
  const candidateIds = filteredResults.map(r => r.entityId);
  const rawPosts = await prisma.ow_posts.findMany({
    where: {
      id: { in: candidateIds },
      ...await visibleWhere("post", viewerId),
    },
    select: buildLeanSelect(),
  });

  // 按相似度排序
  const similarityMap = new Map(filteredResults.map(r => [r.entityId, r.similarity]));
  rawPosts.sort((a, b) => (similarityMap.get(b.id) || 0) - (similarityMap.get(a.id) || 0));

  // 截取到 safeLimit
  const trimmed = rawPosts.slice(0, safeLimit);

  let posts = await serializePosts(trimmed, viewerId);
  posts = await addViewerContext(posts, viewerId);
  posts = await attachPostViewCounts(posts, viewerId);

  // 附加相似度分数
  posts = posts.map(p => ({
    ...p,
    similarity: similarityMap.get(p.id) || 0,
  }));

  const refIds = collectReferencedIds(posts);
  let referencedPosts = await fetchReferencedPosts(refIds, viewerId);
  if (viewerId && Object.keys(referencedPosts).length > 0) {
    const refPostsArray = Object.values(referencedPosts);
    const enriched = await addViewerContext(refPostsArray, viewerId);
    referencedPosts = {};
    for (const p of enriched) {
      referencedPosts[p.id] = p;
    }
  }

  return {
    posts,
    includes: { posts: referencedPosts },
    source_post_id: nPostId,
    min_similarity: similarityThreshold,
  };
}

/**
 * 获取 Embedding 服务基本信息（面向前端的公开接口）
 * 不暴露 API Key 等敏感信息
 */
export async function getEmbeddingInfo() {
  const enabled = await zcconfig.get('embedding.enabled');
  if (!enabled) {
    return { enabled: false };
  }

  const [provider, model, dimensions] = await Promise.all([
    zcconfig.get('embedding.provider'),
    zcconfig.get('embedding.model'),
    zcconfig.get('embedding.dimensions'),
  ]);

  let stats = null;
  try {
    const countResult = await prisma.$queryRawUnsafe(`
      SELECT entity_type, COUNT(*)::int as cnt
      FROM ow_embeddings
      GROUP BY entity_type
    `);
    stats = {};
    for (const row of countResult) {
      stats[row.entity_type] = row.cnt;
    }
  } catch {
    // pgvector 尚未初始化
    stats = null;
  }

  return {
    enabled: true,
    provider: provider || 'openai',
    model: model || 'text-embedding-3-small',
    dimensions: Number(dimensions) || 1536,
    stats,
  };
}

/**
 * 获取 URL 预览元数据（用于发帖时链接卡片）
 */
export async function getUrlPreview({ url, forceRefresh = false }) {
  return getPostUrlPreview(url, { forceRefresh });
}

