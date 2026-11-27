import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
mock.module(url('../services/logger.js'), { defaultExport: { error() {} } });
mock.module(url('../services/prisma.js'), { namedExports: { prisma: {} } });
mock.module(url('../services/commentService/spaceManager.js'), { namedExports: {
    async getSpaceConfig() { return {}; },
    async getSpaceUser() { return null; },
} });
mock.module(url('../services/commentService/walineAuth.js'), { namedExports: {
    async verifyWalineToken() { return { valid: false, userId: null, scopes: [] }; },
    isWalineScopeGranted(scopes, required) {
        return Array.isArray(scopes) && (scopes.includes(required) || scopes.includes('comment:manage'));
    },
} });

const { isSpaceAdmin } = await import('./walineSpaceResolver.js');

test('moderator role alone does not restore management authority', () => {
    assert.equal(isSpaceAdmin({
        walineUser: { type: 'moderator', scopes: ['comment:create'] },
    }), false);
});

test('moderator role with comment:manage retains management authority', () => {
    assert.equal(isSpaceAdmin({
        walineUser: { type: 'moderator', scopes: ['comment:manage'] },
    }), true);
});
