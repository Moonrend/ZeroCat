import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const state = { calls: [], handlers: {} };
const noop = () => {};
const asyncNoop = async () => {};
const models = new Map();
const prisma = new Proxy({}, {
  get(_target, model) {
    if (model === "$transaction") return async (op) => {
      state.initializationOrder.push("transaction");
      return typeof op === "function" ? op(prisma) : Promise.all(op);
    };
    if (model === "$queryRaw" || model === "$queryRawUnsafe") return async (...args) => {
      state.calls.push({ operation: model, args });
      return state.handlers[model]?.(...args) ?? [];
    };
    if (!models.has(model)) models.set(model, new Proxy({}, {
      get(_model, method) {
        return async (args) => {
          const operation = `${model}.${method}`;
          state.calls.push({ operation, args });
          if (state.handlers[operation]) return state.handlers[operation](args);
          if (method === "findMany" || method === "groupBy") return [];
          if (method === "findFirst" || method === "findUnique") return null;
          if (method === "count") return 0;
          if (method.endsWith("Many")) return { count: 0 };
          return { id: 1, ...args?.data };
        };
      },
    }));
    return models.get(model);
  },
});

mock.module("../services/prisma.js", { namedExports: { prisma } });
mock.module("../services/projectFileStorage.js", { namedExports: {
  readProjectFile: async (hash) => {
    state.storageCalls.push({ operation: "read", hash });
    return state.readFile;
  },
  saveProjectFile: async (source, options) => {
    state.storageCalls.push({ operation: "save", source, options });
    state.initializationOrder.push("save");
    if (state.storageFailure) throw new Error("S3 unavailable");
    await Promise.resolve();
    state.initializationOrder.push("saved");
    return { sha256: createHash("sha256").update(source).digest("hex") };
  },
  hydrateProjectFile: async (row) => {
    state.storageCalls.push({ operation: "hydrate", row });
    if (state.storageFailure) throw new Error("S3 unavailable");
    return { ...row, source: row.storage_provider ? "stored source" : row.source };
  },
} });
mock.module("../services/logger.js", { defaultExport: { debug: noop, error: noop, warn: noop, info: noop } });
mock.module("../services/gorse.js", { defaultExport: { feedbackUserUnfollow: asyncNoop, feedbackProjectUnstar: asyncNoop } });
mock.module("../services/queue/queueManager.js", { defaultExport: { enqueueApUnfollowSync: asyncNoop, enqueueProjectGorseSync: asyncNoop } });
mock.module("../services/global.js", { namedExports: { validateUsername: () => ({ valid: true }) } });
mock.module("../utils/avatarUrl.js", { namedExports: { buildAvatarURL: async (value) => value } });
mock.module("../services/moderation/visibility.js", { namedExports: {
  visibleWhere: async (kind, viewerId, options) => ({ visibility: kind, viewerId, ...options }),
  visibleSql: async () => ({ text: "TRUE", values: [] }),
  canViewContent: async (_kind, value) => !!value && !value.hidden,
  assertCanWrite: async () => { if (state.writeRestriction) throw state.writeRestriction; },
  sanitizePublicUser: async (user) => user?.hidden ? null : user,
  sanitizeProfile: async (user) => user?.hidden ? null : user,
  sanitizeProfiles: async (users) => { state.profileBatches.push(users); return users.map(user => user?.hidden ? null : user || null); },
} });
mock.module("../services/auth/resourceOperation.js", { namedExports: {
  authorizeResourceOperation: async (userId) => {
    if (state.authorizationError) throw state.authorizationError;
    return state.authorizationDecision || { allowed: true, principalId: userId };
  },
  resourceAuthorizationContext: () => ({}),
} });
mock.module("../services/email/emailService.js", { namedExports: { sendEmail: asyncNoop } });
mock.module("../services/config/zcconfig.js", { defaultExport: { get: async () => "https://example.test" } });
mock.module("../services/pushNotification.js", { namedExports: { sendPushNotificationToUser: asyncNoop } });
mock.module("../services/email/emailTemplateService.js", { defaultExport: {} });

const users = await import("./users.js");
const projects = await import("./projects.js");
const lists = await import("./lists.js");
const follows = await import("./follows.js");
const stars = await import("./stars.js");
const notifications = await import("./notifications.js");
const events = await import("./events.js");
const blog = await import("./blog/postsController.js");

beforeEach(() => {
  state.calls = []; state.handlers = {}; state.profileBatches = [];
  state.storageCalls = []; state.storageFailure = false; state.readFile = null; state.initializationOrder = [];
  state.authorizationError = null; state.authorizationDecision = null; state.writeRestriction = null;
});
const calls = (operation) => state.calls.filter(call => call.operation === operation);
const response = () => ({ locals: {}, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("fork visibility is batched and hidden references and authors remain unavailable", async () => {
  state.handlers["ow_projects.findMany"] = () => [{ id: 10 }];
  const result = await projects.sanitizeProjectAuthors([
    { id: 1, fork: 10, author: { id: 2 } },
    { id: 2, fork: 10, author: { id: 2 } },
    { id: 3, fork: 11, author: { id: 3, hidden: true } },
  ], 4);
  assert.deepEqual(result.map(project => project.fork), [10, 10, null]);
  assert.equal(result[2].author, null);
  assert.equal(state.profileBatches.length, 1);
  assert.equal(state.profileBatches[0].length, 3);
  assert.equal(calls("ow_projects.findMany").length, 1);
  assert.deepEqual(calls("ow_projects.findMany")[0].args.where.AND[0], { id: { in: [10, 11] } });
});

test("featured project batches deduplicate IDs, preserve positions and bound query parameters", async () => {
  state.handlers["ow_projects.findMany"] = ({ where }) => where.id.in.filter(id => id === 10 || id === 1001).map(id => ({ id }));
  const input = [...Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, featured_projects: index + 1 })), null, { id: 1002, featured_projects: 10 }];
  const result = await users.sanitizeFeaturedProjectsBatch(input, 7);
  assert.equal(result.length, input.length);
  assert.equal(result[0].featured_projects, null);
  assert.equal(result[9].featured_projects, 10);
  assert.equal(result[1000].featured_projects, 1001);
  assert.equal(result[1001], null);
  assert.equal(result[1002].featured_projects, 10);
  assert.deepEqual(calls("ow_projects.findMany").map(call => call.args.where.id.in.length), [1000, 1]);
  assert.equal(calls("ow_projects.findMany")[0].args.where.AND[0].viewerId, 7);
});

test("tag replacement batches mutations and removes duplicate existing tags", async () => {
  state.handlers["ow_projects_tags.findMany"] = () => [{ id: 1, name: "keep" }, { id: 2, name: "keep" }, { id: 3, name: "old" }];
  await projects.handleTagsChange(9, ["keep", "new", "new", "other"]);
  assert.deepEqual(calls("ow_projects_tags.deleteMany")[0].args.where, { id: { in: [2, 3] } });
  assert.deepEqual(calls("ow_projects_tags.createMany")[0].args.data, [{ projectid: 9, name: "new" }, { projectid: 9, name: "other" }]);
  assert.equal(state.calls.length, 3);
});

test("list membership is filtered by relation and preserves project privacy", async () => {
  state.handlers["ow_projects_lists.findUnique"] = () => ({ id: 3, state: "public", authorid: 2 });
  await lists.getProjectList(3, 4);
  assert.equal(calls("ow_projects_list_items.findMany").length, 0);
  const query = calls("ow_projects.findMany")[0].args;
  assert.deepEqual(query.where.lists, { some: { listid: 3 } });
  assert.deepEqual(query.where.OR, [{ state: "public" }, { authorid: 4 }]);
  assert.equal(query.where.AND[0].viewerId, 4);
});

test("bidirectional relationships use one query and preserve same-user direction", async () => {
  state.handlers["ow_user_relationships.findMany"] = () => [
    { source_user_id: 1, target_user_id: 2, relationship_type: "follow" },
    { source_user_id: 2, target_user_id: 1, relationship_type: "block" },
  ];
  const result = await follows.getRelationshipsBetweenUsers(1, 2);
  assert.equal(result.isFollowing, true);
  assert.equal(result.isBlockedBy, true);
  assert.equal(result.isFollowedBy, false);
  assert.equal(state.calls.length, 1);
  state.handlers["ow_user_relationships.findMany"] = () => [{ source_user_id: 1, target_user_id: 1, relationship_type: "follow" }];
  const same = await follows.getRelationshipsBetweenUsers(1, 1);
  assert.equal(same.isFollowing, true);
  assert.equal(same.isFollowedBy, true);
});

test("missing relationship updates preserve the original error without a pre-read", async () => {
  state.handlers["ow_user_relationships.update"] = () => { throw Object.assign(new Error("missing"), { code: "P2025" }); };
  await assert.rejects(follows.updateFollowNote(1, 2, "note"), { message: "关注关系不存在" });
  await assert.rejects(follows.updateBlockReason(1, 2, "reason"), { message: "拉黑关系不存在" });
  assert.equal(calls("ow_user_relationships.findUnique").length, 0);
});

test("unfollow removes only enhanced settings with one conditional write", async () => {
  await follows.unfollowUser(1, 2);
  assert.deepEqual(calls("ow_notification_settings.deleteMany")[0].args.where, {
    user_id: 1, target_type: "USER", target_id: "2", level: "ENHANCED",
  });
  assert.equal(calls("ow_notification_settings.findUnique").length, 0);
});

test("unstar decrements only for a successfully deleted row", async () => {
  state.handlers["ow_projects.findUnique"] = () => ({ id: 2 });
  state.handlers["ow_projects_stars.deleteMany"] = () => ({ count: 0 });
  assert.deepEqual(await stars.unstarProject(1, 2), { count: 0 });
  assert.equal(calls("ow_projects.update").length, 0);
  state.handlers["ow_projects_stars.deleteMany"] = () => ({ count: 1 });
  await stars.unstarProject(1, 2);
  assert.deepEqual(calls("ow_projects.update")[0].args.data, { star_count: { decrement: 1 } });
  assert.equal(calls("ow_projects_stars.findFirst").length, 0);
});

test("notification statistics use aggregate counts and weighted channel groups", async () => {
  state.handlers.$queryRaw = () => [{ total: 5n, unread: 2n, hidden: 1n, push_error: 0n, today: 3n, week: 5n }];
  state.handlers["ow_notifications.groupBy"] = ({ by }) => by[0] === "notification_type"
    ? [{ notification_type: "custom", _count: { id: 5 } }]
    : [{ push_channels: ["email", "browser"], _count: { _all: 3 } }, { push_channels: ["email"], _count: { _all: 2 } }, { push_channels: null, _count: { _all: 8 } }];
  const basic = await notifications.getNotificationStats();
  assert.deepEqual(basic, { total: 5, unread: 2, today: 3, week: 5, byType: [{ type: "custom", count: 5 }] });
  assert.equal(state.calls.length, 2);
  state.calls = [];
  const enhanced = await notifications.getEnhancedNotificationStats();
  assert.deepEqual(enhanced.byChannel, [{ channel: "email", count: 5 }, { channel: "browser", count: 3 }]);
  assert.equal(enhanced.hidden, 1);
  assert.equal(state.calls.length, 3);
  const [sql, today, week] = calls("$queryRaw")[0].args;
  assert.match(sql.join("?"), /COUNT\(\*\) FILTER/);
  assert.equal(today.getHours(), 0);
  assert.ok(week instanceof Date);
});

test("event hydration batches actors and targets and strips event snapshots", async () => {
  state.handlers.$queryRawUnsafe = () => [1, 2, 3].map(id => ({ id, actor_id: 7, target_type: "post", target_id: id, event_data: { secret: true } }));
  state.handlers["ow_users.findMany"] = () => [{ id: 7, username: "actor", display_name: "Actor", type: "user" }];
  state.handlers["ow_posts.findMany"] = () => [{ id: 1, content: "one" }, { id: 3, content: "three" }];
  const result = await events.getActorEvents(7, 10, 0, false, 4);
  assert.deepEqual(result.map(event => event.id), [1, 3]);
  assert.deepEqual(result[0].event_data, {});
  assert.equal(calls("ow_users.findMany").length, 1);
  assert.equal(calls("ow_posts.findMany").length, 1);
  assert.equal(calls("ow_posts.findUnique").length, 0);
  assert.equal(calls("ow_posts.findMany")[0].args.where.AND[0].viewerId, 4);
});

test("recipient batches preserve input order, duplicates and per-recipient failures", async () => {
  state.handlers["ow_users.findMany"] = () => [{ id: 2, username: "two" }, { id: 1, username: "one" }];
  const result = await notifications.adminSendUnified({
    recipients: [1, 2, 1, 99, "invalid"], recipientType: "user_id", adminId: 7,
    notificationConfig: { title: "notice", content: "content", pushChannels: [], hidden: true },
  });
  assert.deepEqual(result.successful.map(recipient => recipient.user_id), [1, 2, 1]);
  assert.deepEqual(result.failed, [99, "invalid"]);
  assert.equal(calls("ow_users.findMany").length, 1);
  assert.deepEqual(calls("ow_users.findMany")[0].args.where.id.in, [1, 2, 99]);
});

test("recipient query failures affect only their bounded chunk and retain repeated failures", async () => {
  state.handlers["ow_users.findMany"] = ({ where }) => {
    if (where.id.in[0] === 1) throw new Error("chunk unavailable");
    return [{ id: 1001, username: "last" }];
  };
  const result = await notifications.adminSendUnified({
    recipients: [...Array.from({ length: 1001 }, (_, index) => index + 1), 1], recipientType: "user_id", adminId: 7,
    notificationConfig: { title: "notice", content: "content", pushChannels: [], hidden: true },
  });
  assert.deepEqual(result.successful.map(recipient => recipient.user_id), [1001]);
  assert.equal(result.failed.length, 1001);
  assert.equal(result.failed.at(-1), 1);
  assert.match(result.errors[0].error, /chunk unavailable/);
  assert.deepEqual(calls("ow_users.findMany").map(call => call.args.where.id.in.length), [1000, 1]);
});

test("event comments with unavailable parent resources are excluded after batched checks", async () => {
  state.handlers.$queryRawUnsafe = () => [{ id: 1, actor_id: 7, target_type: "comment", target_id: 8 }];
  state.handlers["ow_users.findMany"] = () => [{ id: 7 }];
  state.handlers["ow_comment.findMany"] = () => [{ id: 8, page_type: "project", page_id: "9" }];
  const result = await events.getActorEvents(7, 10, 0, false, 4);
  assert.deepEqual(result, []);
  assert.deepEqual(calls("ow_projects.findMany")[0].args.where.id.in, [9]);
  assert.equal(calls("ow_projects.findMany")[0].args.where.AND[0].viewerId, 4);
});

test("blog names probe collision suffixes in bounded batches", async () => {
  state.handlers["ow_projects.findMany"] = ({ where }) => where.name.in[0] === "article"
    ? where.name.in.map(name => ({ name })) : [{ name: "article-32" }];
  const res = response();
  res.locals.userid = 7;
  await blog.createPost({ body: { title: "Article" } }, res);
  assert.equal(res.body.data.name, "article-33");
  assert.equal(calls("ow_projects.findMany").length, 2);
  assert.equal(calls("ow_projects.findMany")[0].args.where.name.in.length, 32);
});

test("blog content uses a joined lookup and preserves a missing file as null", async () => {
  state.handlers["ow_projects.findFirst"] = () => ({ id: 9, type: "article", state: "public", default_branch: "main" });
  state.handlers.$queryRaw = () => [{ commit_file: "missing", sha256: null, source: null, create_time: null, create_userid: null }];
  const res = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.file, null);
  assert.equal(calls("$queryRaw").length, 1);
  assert.equal(calls("ow_projects_branch.findFirst").length, 0);
  assert.deepEqual(state.storageCalls, []);
});

test("project file helpers await shared storage and preserve source serialization and empty content", async () => {
  const source = { targets: [], meta: { version: 1 } };
  const serialized = JSON.stringify(source);
  assert.equal(await projects.setProjectFile(source), createHash("sha256").update(serialized).digest("hex"));
  assert.equal(state.storageCalls[0].source, serialized);
  await projects.setProjectFile("text");
  assert.equal(state.storageCalls[1].source, JSON.stringify("text"));
  state.readFile = { sha256: "empty", source: "", create_userid: 7, create_time: null };
  assert.deepEqual(await projects.getProjectFile("empty"), { source: "" });
  state.readFile = null;
  assert.equal(await projects.getProjectFile("missing"), null);
  assert.deepEqual(state.storageCalls.slice(2), [{ operation: "read", hash: "empty" }, { operation: "read", hash: "missing" }]);
  state.storageFailure = true;
  await assert.rejects(projects.setProjectFile(source), /S3 unavailable/);
  assert.deepEqual(state.calls, []);
});

test("blog details hydrate joined S3 metadata once and expose only the legacy file fields", async () => {
  const metadata = {
    sha256: "a".repeat(64), source: null, create_time: new Date("2026-01-01"), create_userid: 7,
    storage_provider: "s3", storage_bucket: "private", storage_key: "file-key",
    content_size: 13n, content_sha256: "b".repeat(64), content_type: "text/plain; charset=utf-8",
  };
  state.handlers["ow_projects.findFirst"] = () => ({ id: 9, type: "article", state: "public", default_branch: "main" });
  state.handlers.$queryRaw = () => [{ commit_file: metadata.sha256, ...metadata }];
  const res = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.storageCalls, [{ operation: "hydrate", row: metadata }]);
  assert.deepEqual(res.body.data.file, {
    sha256: metadata.sha256, source: "stored source", create_time: metadata.create_time, create_userid: 7,
  });
  assert.doesNotThrow(() => JSON.stringify(res.body));
  assert.equal(calls("$queryRaw").length, 1);
  const sql = calls("$queryRaw")[0].args[0].join("?");
  for (const column of ["storage_provider", "storage_bucket", "storage_key", "content_size", "content_sha256", "content_type"]) {
    assert.ok(sql.includes(`f.${column}`), column);
  }
  assert.equal(state.calls.some(call => call.operation.startsWith("ow_projects_file.")), false);
});

test("blog details fail closed when the storage service cannot read the body", async (t) => {
  t.mock.method(console, "error", noop);
  state.handlers["ow_projects.findFirst"] = () => ({ id: 9, type: "article", state: "public" });
  state.handlers.$queryRaw = () => [{ commit_file: "stored", sha256: "stored", source: "stale body", storage_provider: "s3" }];
  state.storageFailure = true;
  const res = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.status, "error");
  assert.equal(res.body.data, undefined);
  assert.equal(state.storageCalls.length, 1);
});

test("blog details preserve legacy empty bodies and absent branch results", async () => {
  state.handlers["ow_projects.findFirst"] = () => ({ id: 9, type: "article", state: "public" });
  const file = { sha256: "empty", source: "", create_time: null, create_userid: 7 };
  state.handlers.$queryRaw = () => [{ commit_file: "empty", ...file }];
  const res = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: {} }, res);
  assert.deepEqual(res.body.data.file, file);
  state.handlers.$queryRaw = () => [];
  const absent = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: {} }, absent);
  assert.equal(Object.hasOwn(absent.body.data, "file"), false);
  assert.equal(state.storageCalls.length, 1);
});

test("inaccessible blog details reject before any file lookup or hydration", async () => {
  state.authorizationDecision = { allowed: false, principalId: 8 };
  for (const post of [null, { id: 9, state: "public", hidden: true }, { id: 9, authorid: 7, state: "private" }]) {
    state.handlers["ow_projects.findFirst"] = () => post;
    const res = response();
    res.locals.userid = 8;
    await blog.getPostDetail({ params: { id: "9" }, headers: {} }, res);
    assert.equal(res.statusCode, 404);
  }
  assert.equal(calls("$queryRaw").length, 0);
  assert.deepEqual(state.storageCalls, []);
});

test("delegation denial stops blog content before storage access", async (t) => {
  t.mock.method(console, "error", noop);
  state.handlers["ow_projects.findFirst"] = () => ({ id: 9, state: "public" });
  state.authorizationError = Object.assign(new Error("denied"), { status: 403 });
  const res = response();
  await blog.getPostDetail({ params: { id: "9" }, headers: { "x-zerocat-delegation": "3" } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls("$queryRaw").length, 0);
  assert.deepEqual(state.storageCalls, []);
});

test("blog initialization finishes storage before starting its transaction and starts none on storage failure", async (t) => {
  t.mock.method(console, "error", noop);
  const res = response();
  res.locals.userid = 7;
  await blog.createPost({ body: { title: "Stored article" } }, res);
  assert.equal(res.statusCode, 200);
  const save = state.storageCalls[0];
  const expectedHash = createHash("sha256").update("").digest("hex");
  assert.deepEqual(save, { operation: "save", source: "", options: { userId: 7, sha256: expectedHash } });
  assert.deepEqual(state.initializationOrder, ["save", "saved", "transaction"]);
  assert.equal(calls("ow_projects_commits.create")[0].args.data.commit_file, expectedHash);
  assert.equal(state.calls.some(call => call.operation.startsWith("ow_projects_file.")), false);
  state.calls = [];
  state.initializationOrder = [];
  state.storageFailure = true;
  const failed = response();
  failed.locals.userid = 7;
  await blog.createPost({ body: { title: "Failed article" } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(state.initializationOrder, ["save"]);
  assert.equal(calls("ow_projects.create").length, 0);
  assert.equal(calls("ow_projects_commits.create").length, 0);
  assert.equal(calls("ow_projects_branch.create").length, 0);
});

test("blog restrictions reject creation before storage writes", async (t) => {
  t.mock.method(console, "error", noop);
  state.writeRestriction = Object.assign(new Error("read only"), { status: 403 });
  const res = response();
  res.locals.userid = 7;
  await blog.createPost({ body: { title: "Blocked article" } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.status, "error");
  assert.deepEqual(state.storageCalls, []);
  assert.deepEqual(state.calls, []);
});
