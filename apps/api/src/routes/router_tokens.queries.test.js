import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const routes = [];
const router = { use() {} };
for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (path, ...handlers) => routes.push({ method, path, handlers });
}
const state = { reads: 0, rows: [], unavailable: false };
const noop = () => {};
mock.module('express', { namedExports: { Router: () => router } });
mock.module('../services/logger.js', { defaultExport: { error: noop, warn: noop, info: noop } });
mock.module('../services/config/zcconfig.js', { defaultExport: { get: async () => [] } });
mock.module('../services/redis.js', { defaultExport: {} });
mock.module('../services/prisma.js', { namedExports: { prisma: {
    async $queryRaw(_sql, ...values) {
        state.reads++;
        if (state.unavailable) throw new Error('database unavailable');
        return state.rows.filter(row => row.target_type === 'global'
            || (values.includes(row.target_type) && values.includes(row.target_id)));
    },
} } });
mock.module('../middleware/auth.js', { namedExports: { needLogin: noop } });
mock.module('../middleware/sudo.js', { namedExports: { requireSudo: noop } });
mock.module('../middleware/scope.js', { namedExports: { requireResource: () => noop, requireScope: () => noop } });
mock.module('../services/auth/tokenService.js', { namedExports: {
    issueToken: noop, listUserTokens: noop, revokeToken: noop, introspectToken: noop,
} });
await import('./router_tokens.js');
const row = (scope, effect = 'allow') => ({ scope, effect, target_type: 'global', target_id: 'global' });
beforeEach(() => Object.assign(state, { reads: 0, rows: [], unavailable: false }));

async function catalog(locals = {}) {
    const res = { locals: { userid: 2, tokenType: 'session', scopes: [], ...locals }, json(value) { this.body = value; } };
    await routes.find(route => route.path === '/scopes').handlers.at(-1)({}, res);
    return res.body;
}

test('scope catalog reads policy once and retains narrower grants when manage is denied', async () => {
    state.rows = [row('project:manage'), row('project:delete', 'deny')];
    const result = await catalog();
    const names = result.data.map(item => item.name);
    assert.ok(names.includes('project:read'));
    assert.ok(names.includes('project:update'));
    assert.ok(!names.includes('project:delete'));
    assert.ok(!names.includes('project:manage'));
    assert.equal(state.reads, 1);
    assert.ok(result.presets.every(preset => preset.scopes.every(scope => names.includes(scope))));
});

test('catalog still intersects live account policy with a fixed token ceiling', async () => {
    state.rows = [row('project:manage')];
    const result = await catalog({ tokenType: 'personal', scopes: ['project:read'] });
    assert.deepEqual(result.data.map(item => item.name), ['project:read']);
    assert.equal(state.reads, 1);
});

test('debug evaluation shares one policy read without losing explicit denies or the token ceiling', async () => {
    state.rows = [row('project:manage'), row('project:delete', 'deny')];
    const res = { locals: { userid: 2, tokenType: 'personal', scopes: ['project:read'] },
        json(value) { this.body = value; }, status(value) { this.statusCode = value; return this; } };
    await routes.find(route => route.path === '/debug/evaluate').handlers.at(-1)(
        { body: { scope: ['project:read', 'project:update', 'project:delete'] } }, res);
    assert.deepEqual(res.body.data.results.map(result => [result.allowed, result.policy_allowed]),
        [[true, true], [false, true], [false, false]]);
    assert.equal(state.reads, 1);
});

test('debug evaluation still loads resource-bound grants for concrete scopes', async () => {
    state.rows = [{ scope: 'user:2:read', effect: 'allow', target_type: 'user', target_id: '2' }];
    const res = { locals: { userid: 2, tokenType: 'personal', scopes: ['user:2:read'] },
        json(value) { this.body = value; }, status(value) { this.statusCode = value; return this; } };
    await routes.find(route => route.path === '/debug/evaluate').handlers.at(-1)(
        { body: { scope: ['user:2:read'] } }, res);
    assert.equal(res.body.data.results[0].policy_allowed, true);
    assert.equal(res.body.data.results[0].allowed, true);
});

test('catalog reloads revoked grants for each request and fails closed on database failure', async () => {
    state.rows = [row('project:read')];
    assert.ok((await catalog()).data.some(item => item.name === 'project:read'));
    state.rows = [];
    assert.deepEqual((await catalog()).data, []);
    state.unavailable = true;
    assert.deepEqual((await catalog()).data, []);
    assert.equal(state.reads, 3);
});
