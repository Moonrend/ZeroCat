import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const routes = [];
const router = { use() {} };
for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (path, ...handlers) => routes.push({ method, path, handlers });
}
const state = { users: [], groups: [], queries: [], visibility: [] };
const noop = () => {};
mock.module('express', { namedExports: { Router: () => router } });
mock.module('../services/logger.js', { defaultExport: { debug: noop, error: noop } });
mock.module('../services/config/zcconfig.js', { defaultExport: {} });
mock.module('../services/prisma.js', { namedExports: { prisma: {
    ow_users: {
        findMany: async () => state.users,
        count: async (args) => { state.queries.push({ type: 'users', args }); return 9; },
    },
    ow_projects: {
        groupBy: async (args) => { state.queries.push({ type: 'projects', args }); return state.groups; },
    },
} } });
mock.module('../middleware/auth.js', { namedExports: { needAdmin: noop } });
mock.module('./router_follows.js', { defaultExport: {} });
mock.module('../services/config/configTypes.js', { namedExports: { CONFIG_TYPES: {} } });
mock.module('../services/sitemap.js', { defaultExport: {} });
mock.module('../utils/avatarUrl.js', { namedExports: { buildAvatarURL: async () => 'avatar-url' } });
mock.module('../services/moderation/visibility.js', { namedExports: { visibleWhere: async (kind, viewerId) => {
    state.visibility.push({ kind, viewerId });
    return { visible_to: viewerId, kind };
} } });
mock.module('../controllers/users.js', { namedExports: { sanitizeFeaturedProjects: async user => user } });
await import('./router_api.js');

beforeEach(() => {
    state.users = [{ id: 2, avatar: 'hash' }];
    state.groups = [{ type: 'scratch', _count: { _all: 7 } }];
    state.queries = [];
    state.visibility = [];
});

async function get(path) {
    const res = { locals: { userid: 2 }, statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
        send(value) { this.body = value; return this; } };
    await routes.find(route => route.method === 'get' && route.path === path).handlers.at(-1)(
        { query: { id: '2' } }, res, error => { throw error; },
    );
    return res;
}

test('site stats aggregate requested project types once and keep absent types at zero', async () => {
    const res = await get('/info');
    assert.deepEqual(res.body, { user: 9, scratch: 7, python: 0, project: 7 });
    assert.equal(state.queries.filter(query => query.type === 'projects').length, 1);
    assert.deepEqual(state.queries.find(query => query.type === 'projects').args.where, {
        type: { in: ['scratch', 'python'] }, AND: [{ visible_to: 2, kind: 'project' }],
    });
});

test('user info statistics retain public visibility with one project query', async () => {
    const res = await get('/getuserinfo');
    assert.deepEqual(res.body.info.count, { pythoncount: 0, scratchcount: 7 });
    assert.equal(res.body.info.user.avatarURL, 'avatar-url');
    assert.equal(state.queries.length, 1);
    assert.equal(state.queries[0].args.where.state, 'public');
    assert.equal(state.visibility.filter(call => call.kind === 'project').length, 1);
});

test('missing users do not trigger site-wide project counts', async () => {
    state.users = [];
    const res = await get('/getuserinfo');
    assert.equal(res.statusCode, 404);
    assert.equal(state.queries.length, 0);
});
