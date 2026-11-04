import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
const state = { sql: [], visibility: [] };
const routes = [];
mock.module('express', { namedExports: { Router: () => ({ get: (path, handler) => routes.push(handler) }) } });
mock.module('../services/logger.js', { defaultExport: { error() {}, warn() {} } });
mock.module('../services/activitypub/index.js', { namedExports: { federatedUserSearch: async () => ({}), parseFediAddress: () => null } });
mock.module('../services/moderation/visibility.js', { namedExports: {
    visibleWhere: async kind => { state.visibility.push(kind); return {}; },
    visibleSql: async () => ({ text: 'true', values: [] }),
    sanitizeProfiles: async profiles => profiles,
} });
mock.module('../services/prisma.js', { namedExports: { prisma: {
    async $queryRawUnsafe(sql, ...values) {
        state.sql.push({ sql, values });
        return sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ sha256: 'hash', preview: 'indexed preview' }];
    },
} } });
await import('./router_search.js');
beforeEach(() => { state.sql = []; state.visibility = []; });
async function search(userid, query = {}) {
    const res = { locals: { userid }, status() { return this; }, send(body) { this.body = body; } };
    await routes[0]({ query: { scope: 'project_files', keyword: 'needle', ...query } }, res, error => { throw error; });
    return res.body;
}

test('file search supports migrated indexes and legacy bodies with identical owner filters', async () => {
    const result = await search(7, { page: 2, perPage: 5 });
    assert.equal(result.totalCount, 1);
    assert.equal(result.projectFiles[0].preview, 'indexed preview');
    assert.deepEqual(state.visibility, []);
    assert.equal(state.sql.length, 2);
    for (const { sql, values } of state.sql) {
        assert.match(sql, /storage_provider = 's3' AND search_vector @@/);
        assert.match(sql, /storage_provider IS DISTINCT FROM 's3'/);
        assert.match(sql, /create_userid = ANY/);
        assert.ok(values.some(value => Array.isArray(value) && value.length === 1 && value[0] === 7));
    }
    assert.match(state.sql[0].sql, /COALESCE\(search_preview/);
    assert.deepEqual(state.sql[0].values.slice(-2), [5, 5]);
});

test('anonymous file search never queries storage or metadata', async () => {
    assert.equal((await search(null)).totalCount, 0);
    assert.deepEqual(state.sql, []);
});

test('file search cannot enumerate another owner by supplying their ID', async () => {
    assert.equal((await search(7, { userId: '8' })).totalCount, 0);
    assert.deepEqual(state.sql, []);
});
