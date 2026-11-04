import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const state = { projectVisible: true, token: null, commits: [], filesRead: 0, type: "scratch", writes: [], dbCalls: [], branchCount: 1 };
const routes = [];
const guards = [];
const router = { use(handler) { guards.push(handler); } };
for (const method of ["get", "post", "put", "delete"]) router[method] = (path, ...handlers) => routes.push({ method, path, handlers });
const noop = () => {};
const pass = (_req, _res, next) => next();
const argsMatch = (record, where) => Object.entries(where).every(([key, value]) => record[key] === value);

mock.module("express", { namedExports: { Router: () => router } });
mock.module("../services/logger.js", { defaultExport: { error: noop, debug: noop, warn: noop } });
mock.module("../services/config/zcconfig.js", { defaultExport: { get: async () => "test-secret" } });
const db = {
  ow_projects: {
    findFirst: async (args) => {
      state.dbCalls.push({ model: 'project', operation: 'findFirst', args });
      if (args.where.name) return null;
      return state.projectVisible ? { id: 1, type: state.type, authorid: 2, state: 'public', default_branch: 'main',
        author: { id: 2, username: 'author' }, project_tags: [{ id: 4, name: 'tag', created_at: 'date' }] } : null;
    },
    create: async (args) => {
      state.dbCalls.push({ model: 'project', operation: 'create', args });
      return { id: 3, ...args.data };
    },
  },
  ow_projects_branch: {
    findMany: async () => [{ name: 'main', latest_commit_hash: 'fork-tip', description: '', protected: false },
      { name: 'feature', latest_commit_hash: 'fork-tip', description: 'feature', protected: true }],
    create: async (args) => { state.dbCalls.push({ model: 'branch', operation: 'create', args }); return args.data; },
    createMany: async (args) => { state.dbCalls.push({ model: 'branch', operation: 'createMany', args }); return { count: args.data.length }; },
    updateMany: async (args) => { state.dbCalls.push({ model: 'branch', operation: 'updateMany', args }); return { count: state.branchCount }; },
  },
  ow_projects_commits: {
    findUnique: async ({ where }) => state.commits.find((commit) => argsMatch(commit, where)) || null,
    create: async (args) => { state.dbCalls.push({ model: 'commit', operation: 'create', args }); return args.data; },
  },
  ow_projects_file: { findFirst: async ({ where }) => { state.filesRead++; return { sha256: where.sha256, source: 'protected source' }; } },
  ow_target_configs: {
    findMany: async () => { state.dbCalls.push({ model: 'config', operation: 'findMany' }); return [{ key: 'scratch.clouddata.anonymouswrite', value: 'true' }]; },
    upsert: async (args) => ({ value: args.update.value, updated_at: 'date' }),
  },
  $queryRaw: async (_sql, ...values) => {
    const pending = ['fork-tip'];
    const seen = new Set();
    while (pending.length) {
      const id = pending.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = state.commits.find(row => row.id === id);
      if (!commit) continue;
      if (values.includes(commit.id) || values.includes(commit.commit_file)) return [commit];
      if (commit.parent_commit_id) pending.push(commit.parent_commit_id);
    }
    return [];
  },
  $transaction: async (run) => run(db),
};
mock.module("../services/prisma.js", { namedExports: { prisma: db } });
mock.module("../services/projectFileStorage.js", { namedExports: {
  readProjectFile: async sha256 => { state.filesRead++; return { sha256, source: 'protected source' }; },
  saveProjectFile: async () => { if (state.storageFailure) throw new Error('S3 unavailable'); },
} });
mock.module("../default_project.js", { defaultExport: { scratch: 'default-source' } });
mock.module("../controllers/projects.js", { namedExports: {
  authorSelectionFields: noop, extractProjectData: noop, handleTagsChange: noop,
  projectSelectionFields: noop, sanitizeProjectAuthors: async (projects) => projects,
} });
mock.module("jsonwebtoken", { defaultExport: { verify: () => state.token } });
mock.module("../services/auth/tokenUtils.js", { namedExports: { createTypedJWT: async () => { state.issuedTokens++; return "signed"; } } });
mock.module("../services/auth/tokenManager.js", { namedExports: { verifyFileAccessToken: async () => state.token.data.sha256 } });
mock.module("../controllers/projectRecommendations.js", { namedExports: {
  getContextRecommendedProjects: noop, getRecommendedProjectsForUser: noop, getSimilarProjectsByProject: noop,
} });
mock.module("../middleware/auth.js", { namedExports: { needLogin: pass } });
mock.module("../middleware/scope.js", { namedExports: { requireScope: () => pass, requireResource: () => pass } });
mock.module("../services/auth/permissionManager.js", { namedExports: { hasProjectPermission: async () => true } });
mock.module("../services/projectCollaborationService.js", { namedExports: { userCanActOnProject: async () => true } });
mock.module("../controllers/users.js", { namedExports: { getUserByUsername: noop } });
mock.module("../controllers/events.js", { namedExports: { createEvent: noop } });
mock.module("../services/analytics.js", { namedExports: { getAnalytics: noop } });
mock.module("../services/redis.js", { defaultExport: {} });
mock.module("../services/queue/queueManager.js", { defaultExport: { enqueueProjectGorseSync: async () => {} } });
mock.module("../services/gorse.js", { defaultExport: {} });
mock.module("../services/commitService.js", { namedExports: {
  createBranchIfNotExists: noop, getCommitParentId: noop, updateBranchLatestCommit: noop,
} });
mock.module("../services/moderation/visibility.js", { namedExports: {
  visibleWhere: async () => ({}), sanitizeProfile: async (user) => user, sanitizeProfiles: async (users) => users,
} });
mock.module("../services/moderation/restrictions.js", { namedExports: { assertCanWrite: async (userId, category, action) => {
  state.writes.push({ userId, category, action });
} } });
mock.module("../services/moderation/lifecycle.js", { namedExports: { softDeleteContent: noop, restoreContent: noop } });
mock.module("../middleware/sudo.js", { namedExports: { requireSudo: pass } });
await import("./router_project.js");

async function download(sha256 = "file-a") {
  const req = { params: { sha256 }, query: { accessFileToken: "signed", content: "true" } };
  const res = {
    locals: { userid: 2 }, statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }, contentType() { return this; },
  };
  const handler = routes.find((route) => route.path === "/files/:sha256").handlers.at(-1);
  await handler(req, res, (error) => { throw error; });
  return res;
}

beforeEach(() => {
  state.projectVisible = true;
  state.type = "scratch";
  state.writes = [];
  state.filesRead = 0;
  state.storageFailure = false;
  state.issuedTokens = 0;
  state.dbCalls = [];
  state.branchCount = 1;
  state.token = { type: "file", data: { project_id: 1, sha256: "file-a", userid: 2 } };
  state.commits = [{ id: "fork-tip", project_id: 99, commit_file: "file-a", parent_commit_id: null }];
});

test("unsupported delegated project enumeration is rejected, including empty headers", () => {
  const res = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  guards[0]({ method: "GET", path: "/public", headers: { "x-zerocat-delegation": "" } }, res, () => assert.fail("must deny"));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "ZC_ERROR_DELEGATION_NOT_SUPPORTED");
  let advanced = false;
  guards[0]({ method: "GET", path: "/id/7", headers: { "x-zerocat-delegation": "12" } }, res, () => { advanced = true; });
  assert.equal(advanced, true);
});

test("article writes recheck both categories for the actual actor and delegated owner", async () => {
  state.type = "article";
  const route = routes.find(route => route.method === "put" && route.path === "/id/:id");
  const res = { locals: { userid: 2, authorization: { allowed: true, actorId: 2, principalId: 3 } } };
  let advanced = false;
  await route.handlers[2]({ params: { id: 1 }, headers: {} }, res, () => { advanced = true; });
  assert.equal(advanced, true);
  assert.deepEqual(state.writes, [
    { userId: 2, category: "project", action: "update" }, { userId: 2, category: "blog", action: "update" },
    { userId: 3, category: "project", action: "update" }, { userId: 3, category: "blog", action: "update" },
  ]);
});

test("rejects signed-token hash substitution before opening a file", async () => {
  const result = await download("file-b");
  assert.equal(result.statusCode, 404);
  assert.equal(state.filesRead, 0);
});

test("checks current project visibility for an already-issued token", async () => {
  state.projectVisible = false;
  const result = await download();
  assert.equal(result.statusCode, 404);
  assert.equal(state.filesRead, 0);
});

test("rejects legacy file tokens without a bound project", async () => {
  delete state.token.data.project_id;
  const result = await download();
  assert.equal(result.statusCode, 404);
  assert.equal(state.filesRead, 0);
});

test("permits retained fork content through the visible fork's reachable commit graph", async () => {
  const result = await download();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, "protected source");
  assert.equal(state.filesRead, 1);
});

test("rejects an unrelated file despite a valid project and signature", async () => {
  state.commits = [{ id: "fork-tip", commit_file: "different-file", parent_commit_id: null }];
  const result = await download();
  assert.equal(result.statusCode, 404);
  assert.equal(state.filesRead, 0);
});

async function invokeRoute(method, path, request = {}) {
  const req = { params: {}, query: {}, body: {}, headers: {}, ...request };
  const res = { locals: { userid: 2 }, statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; } };
  await routes.find(route => route.method === method && route.path === path).handlers.at(-1)(req, res, error => { throw error; });
  return res;
}

test('new projects initialize their branch and commit without rereading or rewriting the project', async () => {
  const result = await invokeRoute('post', '/', { body: { name: 'new-project', type: 'scratch' } });
  assert.equal(result.body.status, 'success');
  assert.equal(result.body.id, 3);
  const writes = state.dbCalls.filter(call => call.operation === 'create');
  assert.deepEqual(writes.map(call => call.model), ['project', 'branch', 'commit']);
  assert.equal(writes[0].args.data.default_branch, 'main');
  assert.equal(writes[1].args.data.latest_commit_hash, writes[2].args.data.id);
  assert.equal(writes[2].args.data.commit_file, 'default-source');
});

test('fork copies all branch heads and flags in one bulk write', async () => {
  const result = await invokeRoute('post', '/fork', { body: { projectid: 1, branch: 'all', name: 'fork' } });
  assert.equal(result.body.status, 'success');
  const writes = state.dbCalls.filter(call => call.model === 'branch');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].operation, 'createMany');
  assert.deepEqual(writes[0].args.data, [
    { projectid: 3, name: 'main', creator: 2, latest_commit_hash: 'fork-tip', description: '', protected: false },
    { projectid: 3, name: 'feature', creator: 2, latest_commit_hash: 'fork-tip', description: 'feature', protected: true },
  ]);
});

test('branch description updates keep missing-branch errors with a single scoped write', async () => {
  const request = { query: { projectid: '1', branch: 'main' }, body: { description: 'updated' } };
  const result = await invokeRoute('post', '/branches/description', request);
  assert.equal(result.body.status, 'success');
  assert.deepEqual(state.dbCalls, [{ model: 'branch', operation: 'updateMany',
    args: { where: { projectid: 1, name: 'main' }, data: { description: 'updated' } } }]);
  state.branchCount = 0;
  const missing = await invokeRoute('post', '/branches/description', request);
  assert.equal(missing.statusCode, 404);
});

test('branch description rejects missing or malformed selectors before any bulk write', async () => {
  for (const query of [{ projectid: '1' }, { projectid: '1', branch: '' },
    { projectid: '1', branch: { not: '' } }, { branch: 'main' }, { projectid: '1junk', branch: 'main' }]) {
    const result = await invokeRoute('post', '/branches/description', { query, body: { description: 'updated' } });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(state.dbCalls.length, 0);
});

test('project detail reuses loaded relations and preserves both tag response shapes', async () => {
  const result = await invokeRoute('get', '/id/:id', { params: { id: '1' } });
  assert.equal(result.body.author.username, 'author');
  assert.deepEqual(result.body.tags, [{ id: 4, name: 'tag', created_at: 'date' }]);
  assert.deepEqual(result.body.project_tags, [{ id: 4, name: 'tag' }]);
  assert.equal(state.dbCalls.filter(call => call.model === 'project').length, 2);
});

test('failed object uploads cannot issue a file token or return a successful save', async () => {
  state.storageFailure = true;
  const result = await invokeRoute('post', '/savefile', {
    body: 'source body', query: { projectid: '1' }, is: type => type === 'text/plain',
  });
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.status, 'error');
  assert.equal(state.issuedTokens, 0);
});

test('cloud configuration uses a single canonical read after saving', async () => {
  const result = await invokeRoute('put', '/id/:id/cloudconfig', { params: { id: '1' }, body: { anonymouswrite: true } });
  assert.equal(result.body.status, 'success');
  assert.equal(result.body.data[0].value, true);
  assert.equal(result.body.data[1].value, true);
  assert.equal(state.dbCalls.filter(call => call.model === 'config').length, 1);
});
