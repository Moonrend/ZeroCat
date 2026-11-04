import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { empty, join, raw, sqltag } from '@prisma/client/runtime/client';

const url = path => new URL(path, import.meta.url).href;
const state = {};
mock.module(url('../../../generated/prisma/client.ts'), { namedExports: { Prisma: { empty, join, raw, sql: sqltag } } });
mock.module(url('../logger.js'), { defaultExport: { warn() {}, error() {}, debug() {}, info() {} } });
mock.module(url('../prisma.js'), { namedExports: { prisma: {
    ow_users: { async findMany(query) { state.userQueries.push(query); return state.local; } },
    ow_user_restrictions: {
        async findMany(query) {
            if (!query.where.user_id) {
                state.visibilityQueries.push(query);
                return [...state.hidden].map(user_id => ({ user_id }));
            }
            state.batchChecks.push(query);
            return [...state.hidden].filter(id => query.where.user_id.in.includes(id)).map(user_id => ({ user_id }));
        },
        async findFirst(query) {
            state.singleChecks.push(query);
            return state.hidden.has(query.where.user_id) ? { id: 1 } : null;
        },
    },
} } });
mock.module(url('./config.js'), { namedExports: {
    async isFederationEnabled() { return state.enabled; }, async getInstanceDomain() { return 'local.test'; },
} });
mock.module(url('./federation.js'), { namedExports: { async resolveWebFinger() {} } });
mock.module(url('./federationConfig.js'), { namedExports: {
    async isActorAllowed() { return true; }, async isRemoteSearchAllowed() { return true; },
} });
mock.module(url('./remoteUser.js'), { namedExports: {
    REMOTE_USER_TYPE: 'remote_activitypub', async ensureProxyUser() {}, async searchProxyUsers() { return state.remote; },
    async resolveAndEnsureProxyUser() { state.onResolve?.(); return state.resolved; },
} });
const { federatedUserSearch } = await import('./remoteSearch.js');
const user = (id, type = 'local') => ({ id, username: `user${id}`, display_name: `User ${id}`, type });
beforeEach(() => Object.assign(state, { enabled: true, local: [], remote: [], hidden: new Set(), batchChecks: [], singleChecks: [],
    userQueries: [], visibilityQueries: [], resolved: null, onResolve: null }));

test('federated results merge and deduplicate before one visibility query, then filter before applying limit', async () => {
    state.local = [user(1), user(7), user(2)];
    state.remote = [user(2), user(3)];
    state.hidden = new Set([1, 7]);
    const result = await federatedUserSearch('user', { currentUserId: 7, limit: 3 });
    assert.deepEqual(result.users.map(item => item.id), [7, 2, 3]);
    assert.deepEqual(result.users.map(item => item.is_remote), [false, false, true]);
    assert.equal(state.batchChecks.length, 1);
    assert.deepEqual(state.batchChecks[0].where.user_id.in, [1, 2, 3]);
    assert.deepEqual(state.batchChecks[0].where.categories, { hasSome: ['*', 'profile'] });
    assert.equal(state.singleChecks.length, 0);
});

test('empty federated results do not perform additional profile-mask queries', async () => {
    assert.deepEqual((await federatedUserSearch('absent')).users, []);
    assert.equal(state.batchChecks.length, 0);
    assert.equal(state.singleChecks.length, 0);
});

test('a freshly resolved remote profile receives its own current visibility check after network resolution', async () => {
    state.local = [user(2)];
    state.resolved = user(9, 'remote_activitypub');
    state.onResolve = () => state.hidden.add(9);
    const result = await federatedUserSearch('member@remote.test');
    assert.equal(result.remoteUser, null);
    assert.deepEqual(result.users.map(item => item.id), [2]);
    assert.equal(state.batchChecks.length, 1);
    assert.equal(state.singleChecks.length, 1);
    assert.equal(state.singleChecks[0].where.user_id, 9);
});

test('visible fresh remote resolution retains prepend behavior and does not duplicate an existing result', async () => {
    state.local = [user(2)];
    state.resolved = user(9, 'remote_activitypub');
    const first = await federatedUserSearch('member@remote.test', { limit: 1 });
    assert.deepEqual(first.users.map(item => item.id), [9, 2]);
    state.resolved = user(2, 'remote_activitypub');
    const second = await federatedUserSearch('member@remote.test', { limit: 1 });
    assert.deepEqual(second.users.map(item => item.id), [2]);
    assert.equal(second.remoteUser.id, 2);
});
