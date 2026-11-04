import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const state = { posts: [], calls: [], writes: [], restriction: null };
const noop = () => {};
const asyncNoop = async () => {};

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return value.every((clause) => matches(row, clause));
    if (key === "OR") return value.some((clause) => matches(row, clause));
    if (value && typeof value === "object") {
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("lt" in value) return row[key] < value.lt;
    }
    return row[key] === value;
  });
}

const db = {
  ow_posts: {
    async findMany(args) {
      state.calls.push(args);
      const rows = state.posts.filter((row) => matches(row, args.where));
      return rows.slice(0, args.take ?? rows.length);
    },
    async findFirst(args) { return (await this.findMany(args))[0] || null; },
    async count({ where }) { return state.posts.filter((row) => matches(row, where)).length; },
    async groupBy() { return []; },
    async create({ data }) {
      state.writes.push("create");
      if (state.allowCreate) return post(100, data.author_id, data);
      throw new Error("Unexpected content creation");
    },
  },
  ow_projects: { async findMany(args) { state.embedQueries.push({ model: "project", args }); return state.embeddedProjects; } },
  ow_users: { async findMany(args) { state.embedQueries.push({ model: "user", args }); return state.embeddedUsers; } },
  ow_assets: { async findMany({ where }) { return where.AND[0].id.in.map(id => ({ id })); } },
  ow_posts_media: { async createMany(args) { state.mediaWrites.push(args); return { count: args.data.length }; } },
  ow_analytics_event: { async groupBy(args) { state.analyticsQueries.push(args); return []; } },
  ow_posts_like: { async findMany() { return []; }, async groupBy() { return []; } },
  ow_posts_bookmark: { async findMany() { return []; }, async groupBy() { return []; } },
  ow_user_restrictions: { async findMany() { return []; } },
  async $queryRaw(sql, ...values) { state.rawQueries.push({ sql: sql.join("?"), values }); return [{ count: 2n }]; },
  async $transaction(callback) { return callback(db); },
};

mock.module("../services/prisma.js", { namedExports: { prisma: db } });
mock.module("twitter-text", { defaultExport: { parseTweet: (value) => ({ valid: true, weightedLength: value.length }) } });
mock.module("./notifications.js", { namedExports: { createNotification: asyncNoop } });
mock.module("./events.js", { namedExports: { createEvent: asyncNoop } });
mock.module("../services/config/zcconfig.js", { defaultExport: { get: async () => "https://static.example.test" } });
mock.module("../services/logger.js", { defaultExport: { debug: noop, error: noop, warn: noop } });
mock.module("../services/queue/queueManager.js", { defaultExport: { enqueueSocialPostSync: asyncNoop, enqueueUserEmbedding: asyncNoop, enqueuePostEmbedding: asyncNoop } });
mock.module("../services/gorse.js", { defaultExport: { upsertPost: asyncNoop } });
mock.module("../services/embedding.js", { namedExports: {} });
mock.module("../services/analytics.js", { namedExports: { getAnalytics: asyncNoop } });
mock.module("../services/postPreview.js", { namedExports: { getPostUrlPreview: asyncNoop } });
mock.module("../utils/avatarUrl.js", { namedExports: { toAvatarURL: (avatar) => avatar || null } });
mock.module("../services/moderation/visibility.js", { namedExports: {
  visibleWhere: async (_kind, viewerId) => ({ AND: [
    { is_deleted: false, deleted_at: null },
    { OR: [{ hidden: false }, { author_id: viewerId }] },
  ] }),
  sanitizeProfile: async (user, viewerId) => user?.profile_hidden && user.id !== viewerId ? null : user,
  sanitizeProfiles: async (users, viewerId) => {
    state.profileBatches.push(users);
    return users.map(user => (user?.profile_hidden || state.hiddenProfiles.has(user?.id)) && user?.id !== viewerId ? null : user || null);
  },
} });
mock.module("../services/moderation/restrictions.js", { namedExports: {
  assertCanWrite: async () => { if (state.restriction) throw state.restriction; },
  activeRestrictionWhere: () => ({}),
} });
mock.module("../services/moderation/lifecycle.js", { namedExports: {
  softDeleteContent: async (...args) => { state.writes.push(args); },
  restoreContent: async (...args) => { state.writes.push(args); },
} });

const { getUserPosts, getUserReplies, getPostById, getPostAnalytics, createPost, likePost, deletePost, getDeletedPosts } = await import("./posts.js");

function post(id, authorId, extra = {}) {
  return {
    id, author_id: authorId, author: { id: authorId, username: `user${authorId}` },
    post_type: "normal", content: `post ${id}`, is_deleted: false, deleted_at: null,
    hidden: false, created_at: new Date(1000 + id), post_media: [], mentions: [],
    reply_count: 0, retweet_count: 0, like_count: 0, bookmark_count: 0,
    ...extra,
  };
}

beforeEach(() => {
  state.posts = [];
  state.calls = [];
  state.writes = [];
  state.restriction = null;
  state.analyticsQueries = [];
  state.mediaWrites = [];
  state.rawQueries = [];
  state.allowCreate = false;
  state.profileBatches = [];
  state.hiddenProfiles = new Set();
  state.embedQueries = [];
  state.embeddedProjects = [];
  state.embeddedUsers = [];
});

test("filters hidden posts before applying the requested page size", async () => {
  state.posts = [post(1, 2, { hidden: true }), post(2, 2), post(3, 2)];
  const result = await getUserPosts({ userId: 2, viewerId: 3, limit: 1 });
  assert.deepEqual(result.posts.map((item) => item.id), [2]);
  assert.equal(result.has_more, true);
  assert.ok(state.calls[0].where.AND, "the page query must carry live visibility");
});

test("forwards the viewer to quoted-post hydration and sanitizes author profiles", async () => {
  state.posts = [
    post(1, 2, { post_type: "quote", quoted_post_id: 2, author: { id: 2, profile_hidden: true, username: "hidden-profile" } }),
    post(2, 3, { hidden: true, post_media: [{ asset: { id: 9, md5: "secret", extension: "png" } }] }),
  ];
  const other = await getUserPosts({ userId: 2, viewerId: 4 });
  assert.deepEqual(other.includes.posts, {});
  assert.equal(other.posts[0].author, null);
  const owner = await getUserPosts({ userId: 2, viewerId: 3 });
  assert.equal(owner.includes.posts[2].content, "post 2");
  assert.equal(owner.includes.posts[2].media[0].id, 9);
});

test("list and referenced posts share one statistics batch without altering pagination", async () => {
  state.posts = [post(1, 2, { quoted_post_id: 2 }), post(2, 3)];
  const result = await getUserPosts({ userId: 2, viewerId: 4, limit: 1 });
  assert.deepEqual(result.posts.map(item => item.id), [1]);
  assert.equal(result.includes.posts[2].id, 2);
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, state.posts[0].created_at.toISOString());
  assert.equal(state.analyticsQueries.length, 1);
  assert.deepEqual(state.analyticsQueries[0].where.target_id.in, [1, 2]);
});

test("post authors and mentions share one profile batch with positions preserved", async () => {
  state.hiddenProfiles.add(3);
  state.posts = [
    post(1, 2, { mentions: [{ user: { id: 3, username: "hidden" } }, { user: { id: 4, username: "visible" } }] }),
    post(2, 2, { mentions: [{ user: { id: 2, username: "author" } }] }),
  ];
  const result = await getUserPosts({ userId: 2, viewerId: 6 });
  assert.equal(state.profileBatches.length, 1);
  assert.equal(state.profileBatches[0].length, 5);
  assert.deepEqual(result.posts.map(post => post.author.id), [2, 2]);
  assert.deepEqual(result.posts.map(post => post.mentions.map(user => user.id)), [[4], [2]]);
});

test("embedded resources are deduplicated per kind without exposing unavailable targets", async () => {
  state.embeddedProjects = [{ id: 10 }];
  state.embeddedUsers = [{ id: 7, username: "visible" }];
  state.posts = [
    post(1, 2, { embed: { type: "project", id: 10 } }),
    post(2, 2, { embed: { type: "article", id: 10 } }),
    post(3, 2, { embed: { type: "project", id: 11 } }),
    post(4, 2, { embed: { type: "user", username: "visible" } }),
    post(5, 2, { embed: { type: "url", url: "https://example.test" } }),
  ];
  const result = await getUserPosts({ userId: 2, viewerId: 6 });
  assert.deepEqual(result.posts.map(post => post.embed), [
    { type: "project", id: 10 }, { type: "article", id: 10 }, null,
    { type: "user", id: 7 }, { type: "url", url: "https://example.test" },
  ]);
  assert.equal(state.embedQueries.length, 2);
  assert.deepEqual(state.embedQueries.find(query => query.model === "project").args.where.AND[0].OR, [{ id: 10 }, { id: 11 }]);
});

test("reply lists batch shared ancestors and terminate cyclic chains", async () => {
  state.posts = [
    post(10, 2, { post_type: "reply", in_reply_to_id: 3 }),
    post(11, 2, { post_type: "reply", in_reply_to_id: 3 }),
    post(3, 4, { post_type: "reply", in_reply_to_id: 1 }),
    post(1, 5, { post_type: "reply", in_reply_to_id: 3 }),
  ];
  const result = await getUserReplies({ userId: 2, viewerId: 6 });
  assert.deepEqual(result.items.map(item => item.ancestors.map(ancestor => ancestor.id)), [[1, 3], [1, 3]]);
  assert.deepEqual(state.calls.filter(query => query.where.id?.in).map(query => query.where.id.in), [[3], [1]]);
  assert.equal(state.analyticsQueries.length, 1);
});

test("reply includes exclude primary posts and ancestors without reloading their cross-references", async () => {
  state.posts = [
    post(10, 2, { post_type: "reply", in_reply_to_id: 3, quoted_post_id: 3, retweet_post_id: 1 }),
    post(11, 2, { post_type: "reply", in_reply_to_id: 3, quoted_post_id: 20 }),
    post(3, 4, { post_type: "reply", in_reply_to_id: 1, quoted_post_id: 10 }),
    post(1, 5, { quoted_post_id: 11 }),
    post(20, 7),
  ];
  const result = await getUserReplies({ userId: 2, viewerId: 6 });
  assert.deepEqual(result.items.map(item => item.post.id), [10, 11]);
  assert.deepEqual(result.items.map(item => item.ancestors.map(ancestor => ancestor.id)), [[1, 3], [1, 3]]);
  assert.deepEqual(Object.keys(result.includes.posts), ["20"]);
  const idBatches = state.calls.map(query => query.where.id?.in || query.where.AND?.find(clause => clause.id?.in)?.id.in).filter(Boolean);
  assert.deepEqual(idBatches, [[3], [1], [20]]);
  assert.equal(state.analyticsQueries.length, 1);
  assert.deepEqual(new Set(state.analyticsQueries[0].where.target_id.in), new Set([10, 11, 1, 3, 20]));
});

test("reply ancestor traversal stops at hidden parents and does not disclose their ancestors", async () => {
  state.posts = [
    post(10, 2, { post_type: "reply", in_reply_to_id: 3 }),
    post(3, 4, { post_type: "reply", in_reply_to_id: 1, hidden: true }),
    post(1, 5),
  ];
  const result = await getUserReplies({ userId: 2, viewerId: 6 });
  assert.deepEqual(result.items[0].ancestors, []);
  assert.deepEqual(result.includes.posts, {});
  assert.ok(!state.calls.some(query => query.where.id?.in?.includes(1)));
});

test("deleted details and referenced media remain unavailable to the author", async () => {
  state.posts = [post(1, 2, { quoted_post_id: 2 }), post(2, 2, {
    is_deleted: true, deleted_at: new Date(), post_media: [{ asset: { id: 9, md5: "secret", extension: "png" } }],
  })];
  assert.equal(await getPostById(2, 2), null);
  const result = await getUserPosts({ userId: 2, viewerId: 2 });
  assert.deepEqual(result.includes.posts, {});
  assert.deepEqual(result.posts.map((item) => item.id), [1]);
});

test("post media writes are batched with deduplicated attachment order", async () => {
  state.allowCreate = true;
  await createPost({ authorId: 2, content: "media post", mediaIds: [9, 8, 9, 7] });
  assert.equal(state.mediaWrites.length, 1);
  assert.deepEqual(state.mediaWrites[0].data, [
    { post_id: 100, asset_id: 9, order: 0 },
    { post_id: 100, asset_id: 8, order: 1 },
    { post_id: 100, asset_id: 7, order: 2 },
  ]);
});

test("post analytics reuse view totals and count distinct devices without loading event rows", async () => {
  state.posts = [post(1, 2)];
  const result = await getPostAnalytics({ postId: 1, viewerId: 2 });
  assert.equal(result.view_count, 0);
  assert.equal(result.visitor_count, 2);
  assert.equal(state.analyticsQueries.length, 1);
  assert.equal(state.rawQueries.length, 1);
  assert.match(state.rawQueries[0].sql, /SELECT DISTINCT device_id/);
  assert.deepEqual(state.rawQueries[0].values, [1]);
});

test("read-only restrictions reject controller writes before any database mutation", async () => {
  state.restriction = Object.assign(new Error("read only"), { status: 403, code: "ACCOUNT_READ_ONLY" });
  await assert.rejects(createPost({ authorId: 2, content: "content" }), { code: "ACCOUNT_READ_ONLY" });
  await assert.rejects(likePost({ userId: 2, postId: 1 }), { code: "ACCOUNT_READ_ONLY" });
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.calls, []);
});

test("normal deletion uses the shared lifecycle and rejects unapproved foreign ownership", async () => {
  state.posts = [post(1, 2)];
  await assert.rejects(deletePost({ userId: 3, postId: 1 }), { status: 403 });
  assert.deepEqual(state.writes, []);
  await deletePost({ userId: 2, postId: 1 });
  assert.deepEqual(state.writes, [["post", 1, 2, { authorizationContext: {} }]]);
});

test("author recycle bin preserves content and marks administrative deletion non-restorable", async () => {
  state.posts = [
    post(1, 2, { is_deleted: true, deleted_at: new Date(), deletion_source: "admin" }),
    post(2, 3, { is_deleted: true, deleted_at: new Date(), deletion_source: "author" }),
  ];
  const result = await getDeletedPosts({ userId: 2 });
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].content, "post 1");
  assert.equal(result.posts[0].can_restore, false);
  assert.equal(result.posts[0].is_deleted, true);
});
