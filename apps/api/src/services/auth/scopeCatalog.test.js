import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { join, sqltag } from '@prisma/client/runtime/client';
const queries = [];
mock.module(new URL('../logger.js', import.meta.url).href, { defaultExport: { info() {}, error() {} } });
mock.module(new URL('../prisma.js', import.meta.url).href, { namedExports: { prisma: {
    async $executeRaw(query) { queries.push(query); return 1; },
} } });
mock.module(new URL('../../../generated/prisma/client.ts', import.meta.url).href, {
    namedExports: { Prisma: { join, sql: sqltag } },
});
const { syncScopeCatalog, SCOPE_CATALOG } = await import('./scopes.js');
test('catalog sync uses one parameterized upsert and updates only changed catalog fields', async () => {
    await syncScopeCatalog();
    assert.equal(queries.length, 1);
    const query = queries[0];
    const names = SCOPE_CATALOG.filter(item => item.name !== '*').map(item => item.name);
    assert.ok(names.every(name => query.values.includes(name)));
    assert.equal(query.values.includes('*'), false);
    assert.match(query.text, /INSERT INTO "oauth_scopes"/);
    assert.match(query.text, /IS DISTINCT FROM/);
    const updateSql = query.text.split('DO UPDATE SET')[1];
    assert.equal(updateSql.includes('"is_default"'), false);
    assert.equal(updateSql.includes('"requires_verification"'), false);
});
