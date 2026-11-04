import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';

const url = path => new URL(path, import.meta.url).href;
const noop = () => {};
const pass = (req, res, next) => next();
const state = {};
const groupModel = name => ({
    async groupBy(args) {
        state.calls.push({ name, method: 'groupBy', args });
        if (state.failure) throw state.failure;
        return state.groups[name];
    },
});
const db = {
    ow_scratch_extensions: groupModel('extensions'),
    ow_users: {
        ...groupModel('users'),
        async count(args) { state.calls.push({ name: 'users', method: 'count', args }); return state.recent; },
    },
    ow_projects: {
        ...groupModel('projects'),
        async findMany(args) {
            state.calls.push({ name: 'projects', method: 'findMany', args });
            return 'view_count' in args.orderBy ? state.viewed : state.starred;
        },
    },
    ow_oauth_applications: {
        async findFirst(args) {
            state.calls.push({ name: 'oauth', method: 'findFirst', args });
            return state.application;
        },
        async update(args) {
            state.calls.push({ name: 'oauth', method: 'update', args });
            return { ...state.application, ...args.data, client_secret: 'secret', owner: { id: 3 }, _count: { authorizations: 5, access_tokens: 2 } };
        },
    },
    ow_oauth_authorizations: {
        async updateMany(args) { state.calls.push({ name: 'oauth-authorizations', method: 'updateMany', args }); return { count: 5 }; },
    },
    async $transaction(queries) {
        state.transactions.push(queries.length);
        return Promise.all(queries);
    },
};
mock.module(url('../../services/prisma.js'), { namedExports: { prisma: db } });
mock.module(url('../../services/logger.js'), { defaultExport: { error: noop, warn: noop, info: noop } });
mock.module(url('../../services/extensionReview.js'), { namedExports: { setReviewStatus: noop, getAutoApproveUsers: noop, setAutoApproveUsers: noop } });
mock.module(url('../../services/global.js'), { namedExports: { validateUsername: noop } });
mock.module(url('../../services/config/zcconfig.js'), { defaultExport: { get: noop } });
mock.module(url('../../middleware/sudo.js'), { namedExports: { requireSudo: pass } });
mock.module(url('../../middleware/scope.js'), { namedExports: { requireScope: scope => (req, res, next) => { state.scopes.push(scope); next(); } } });
mock.module(url('../../services/auth/tokenService.js'), { namedExports: { revokeTokensWhere: async args => { state.revocations.push(args); } } });
mock.module(url('../../services/auth/permissionAdministration.js'), { namedExports: { setUserRoles: noop } });
mock.module(url('../../services/auth/policyEngine.js'), { namedExports: {
    assignDefaultRolesToUser: noop, assignRoleToUser: noop, getUserPolicy: noop,
    getUserRoleAssignments: noop, listRoles: noop, clearUserPolicyCache: noop,
    policyAllowsScope: noop, revokeRoleFromUser: noop, SYSTEM_ROLE_KEYS: {},
} });
mock.module(url('../../services/admin/userManagementService.js'), { namedExports: {
    createUserManagementService: () => ({}), USER_FIELDS: {}, CONTACT_FIELDS: {}, SESSION_FIELDS: {},
    safeContact: value => value, safeUser: value => value, UserManagementError: class extends Error {},
} });
mock.module(url('../../services/moderation/lifecycle.js'), { namedExports: { softDeleteContent: noop, restoreContent: noop } });
mock.module(url('../../services/moderation/restrictions.js'), { namedExports: { assertCanWrite: noop } });
const routers = {
    extensions: (await import('./extensions.js')).default,
    users: (await import('./users.js')).default,
    projects: (await import('./projects.js')).default,
    oauth: (await import('./oauth.js')).default,
};
let server, origin;
before(async () => {
    const app = express();
    app.use(express.json());
    for (const [name, router] of Object.entries(routers)) app.use(`/${name}`, router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => Object.assign(state, {
    calls: [], transactions: [], scopes: [], revocations: [], failure: null,
    groups: { extensions: [], users: [], projects: [] }, recent: 0, viewed: [], starred: [],
    application: { id: 9, type: 'web', is_verified: false, status: 'active', auto_authorize: false },
}));
const getStats = async name => {
    const response = await fetch(`${origin}/${name}/stats/overview`);
    assert.equal(response.status, 200);
    return response.json();
};

test('extension statistics preserve overlapping counts and ignore unknown statuses as categories', async () => {
    state.groups.extensions = [
        { status: 'developing', scratchCompatible: true, _count: 2 },
        { status: 'verified', scratchCompatible: false, _count: 3 },
        { status: 'verified', scratchCompatible: true, _count: 5 },
        { status: 'total', scratchCompatible: true, _count: 7 },
        { status: '__proto__', scratchCompatible: false, _count: 1 },
        { status: 'pending', scratchCompatible: null, _count: 4 },
    ];
    assert.deepEqual(await getStats('extensions'), { status: 'success', data: {
        total: 22, developing: 2, pending: 4, verified: 8, rejected: 0, scratchCompatible: 14,
    } });
    assert.deepEqual(state.calls, [{ name: 'extensions', method: 'groupBy', args: { by: ['status', 'scratchCompatible'], _count: true } }]);
});

test('user statistics retain category shape and seven-day cutoff in two transactional queries', async () => {
    state.groups.users = [
        { status: 'active', type: 'guest', _count: 4 },
        { status: 'active', type: 'admin', _count: 2 },
        { status: 'banned', type: 'guest', _count: 3 },
        { status: 'constructor', type: '__proto__', _count: 1 },
    ];
    state.recent = 3;
    const beforeRequest = Date.now();
    assert.deepEqual(await getStats('users'), {
        totalUsers: 10,
        usersByStatus: [{ status: 'active', _count: 6 }, { status: 'banned', _count: 3 }, { status: 'constructor', _count: 1 }],
        usersByType: [{ type: 'guest', _count: 7 }, { type: 'admin', _count: 2 }, { type: '__proto__', _count: 1 }],
        newUsersLast7Days: 3,
    });
    assert.equal(state.calls.length, 2);
    assert.deepEqual(state.calls[0].args, { by: ['status', 'type'], _count: true });
    const cutoff = state.calls[1].args.where.regTime.gte.getTime();
    assert.ok(cutoff >= beforeRequest - 7 * 86400000 && cutoff <= Date.now() - 7 * 86400000);
    assert.deepEqual(state.transactions, [2]);
});

test('project statistics retain nullable types, separate rankings, and scope middleware', async () => {
    state.groups.projects = [
        { state: 'public', type: 'scratch', _count: 3 },
        { state: 'private', type: 'scratch', _count: 2 },
        { state: 'public', type: null, _count: 4 },
    ];
    state.viewed = [{ id: 1, name: 'a', title: 'A', view_count: 9 }];
    state.starred = [{ id: 2, name: 'b', title: 'B', star_count: 5 }];
    assert.deepEqual(await getStats('projects'), {
        totalProjects: 9,
        projectsByState: [{ state: 'public', _count: 7 }, { state: 'private', _count: 2 }],
        projectsByType: [{ type: 'scratch', _count: 5 }, { type: null, _count: 4 }],
        mostViewed: state.viewed, mostStarred: state.starred,
    });
    assert.equal(state.calls.length, 3);
    assert.deepEqual(state.calls[0].args, { by: ['state', 'type'], _count: true });
    assert.deepEqual(state.transactions, [3]);
    assert.deepEqual(state.scopes, ['admin:hidden_content:read']);
    assert.equal(state.calls[1].args.take, 5);
    assert.equal(state.calls[2].args.take, 5);
});

test('empty statistics retain zero values and empty category arrays', async () => {
    assert.deepEqual(await getStats('extensions'), { status: 'success', data: { total: 0, developing: 0, pending: 0, verified: 0, rejected: 0, scratchCompatible: 0 } });
    assert.deepEqual(await getStats('users'), { totalUsers: 0, usersByStatus: [], usersByType: [], newUsersLast7Days: 0 });
    assert.deepEqual(await getStats('projects'), { totalProjects: 0, projectsByState: [], projectsByType: [], mostViewed: [], mostStarred: [] });
});

test('statistics database failures keep the existing generic 500 response', async () => {
    state.failure = new Error('database unavailable');
    const quiet = mock.method(console, 'error', noop);
    try {
        for (const name of ['extensions', 'users', 'projects']) {
            const response = await fetch(`${origin}/${name}/stats/overview`);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { error: 'Internal server error' });
        }
    } finally { quiet.mock.restore(); }
});

for (const [suffix, body, select, expected] of [
    ['', { name: 'Renamed' }, { id: true, type: true }, { name: 'Renamed' }],
    ['/verified', {}, { id: true, is_verified: true }, { is_verified: true }],
    ['/auto-authorize', { auto_authorize: true }, { id: true }, { auto_authorize: true }],
]) {
    test(`OAuth mutation ${suffix || 'update'} avoids loading owner/counts before the write`, async () => {
        const response = await fetch(`${origin}/oauth/applications/9${suffix}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.application.client_secret, undefined);
        assert.deepEqual(result.application.owner, { id: 3 });
        for (const [field, value] of Object.entries(expected)) assert.equal(result.application[field], value);
        assert.deepEqual(state.calls[0].args, { where: { OR: [{ id: 9 }, { client_id: '9' }] }, select });
        assert.ok(state.calls[1].args.include.owner);
        assert.ok(state.calls[1].args.include._count);
    });
}

test('OAuth detail still includes related data and deletion retains token and authorization revocation', async () => {
    const detail = await fetch(`${origin}/oauth/applications/client-id`);
    assert.equal(detail.status, 200);
    assert.ok(state.calls[0].args.include.owner);
    assert.ok(state.calls[0].args.include._count);
    state.calls = [];
    const deleted = await fetch(`${origin}/oauth/applications/client-id`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(state.calls[0].args, { where: { client_id: 'client-id' }, select: { id: true, status: true } });
    assert.deepEqual(state.revocations, [{ application_id: 9, type: 'oauth' }]);
    assert.deepEqual(state.calls[2].args, { where: { application_id: 9 }, data: { status: 'revoked' } });
});

test('missing OAuth application still returns 404 without performing writes', async () => {
    state.application = null;
    const response = await fetch(`${origin}/oauth/applications/missing/verified`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: 'error', message: 'Application not found' });
    assert.equal(state.calls.length, 1);
});
