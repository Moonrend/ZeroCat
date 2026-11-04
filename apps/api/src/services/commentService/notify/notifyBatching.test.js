import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { empty, join, raw, sqltag } from '@prisma/client/runtime/client';

const url = path => new URL(path, import.meta.url).href;
const state = {};
mock.module(url('../../../../generated/prisma/client.ts'), { namedExports: { Prisma: { empty, join, raw, sql: sqltag } } });
mock.module(url('../../logger.js'), { defaultExport: { warn() {}, error() {}, debug() {}, info() {} } });
mock.module(url('../../moderation/restrictions.js'), { namedExports: {
    async assertCanWrite() {}, activeRestrictionWhere(type) { return { type, revoked_at: null }; },
} });
mock.module(url('../../prisma.js'), { namedExports: { prisma: {
    ow_comment_service: { async findUnique({ where }) { return state.records.find(row => row.id === where.id) || null; } },
    ow_user_restrictions: {
        async findMany(query) {
            state.profileQueries.push(query);
            return [...state.hidden].filter(id => query.where.user_id.in.includes(id)).map(user_id => ({ user_id }));
        },
        async findFirst(query) {
            state.singleQueries.push(query);
            return state.hideComments ? { id: 1 } : null;
        },
    },
} } });
mock.module(url('./notifyContext.js'), { namedExports: {
    async buildContext(comment, parent) { state.contexts.push(structuredClone({ comment, parent })); return {}; },
    async getAdminEmail() { return ''; },
} });
mock.module(url('./providers/index.js'), { namedExports: {
    getEnabledProviders() { return [{ name: 'test', async send() { state.sent++; return { success: true }; } }]; },
} });
const { default: notifyService } = await import('./notifyService.js');
const record = (id, accountId, pid = null) => ({ id, account_user_id: accountId, pid, nick: `Name ${id}`,
    mail: `user${id}@example.test`, link: 'https://example.test/profile', comment: 'current text' });
beforeEach(() => Object.assign(state, { records: [], hidden: new Set(), profileQueries: [], singleQueries: [], contexts: [], sent: 0, hideComments: false }));
const run = () => notifyService.run('admin_new_comment', { id: 1, nick: 'stale name' }, {}, 'space');

test('notification batches author masks after canonical comment checks and before provider context', async () => {
    state.records = [record(1, 7, '2'), record(2, 9)];
    state.hidden.add(9);
    await run();
    assert.equal(state.profileQueries.length, 1);
    assert.deepEqual(state.profileQueries[0].where.user_id.in, [7, 9]);
    assert.equal(state.singleQueries.length, 2);
    assert.ok(state.singleQueries.every(q => q.where.categories.hasSome.includes('comments')));
    assert.equal(state.contexts[0].comment.nick, 'Name 1');
    assert.equal(state.contexts[0].parent.nick, '用户');
    assert.equal(state.contexts[0].parent.mail, null);
    assert.equal(state.contexts[0].parent.link, null);
    assert.equal(state.sent, 1);
});

test('duplicate authors use one lookup and both comments are redacted', async () => {
    state.records = [record(1, 7, '2'), record(2, 7)];
    state.hidden.add(7);
    await run();
    assert.deepEqual(state.profileQueries[0].where.user_id.in, [7]);
    assert.equal(state.contexts[0].comment.nick, '用户');
    assert.equal(state.contexts[0].parent.nick, '用户');
});

test('anonymous comments need no profile query and newly hidden comments abort before context or delivery', async () => {
    state.records = [record(1, null)];
    await run();
    assert.equal(state.profileQueries.length, 0);
    assert.equal(state.contexts[0].comment.nick, 'Name 1');
    state.records = [record(1, 7)];
    state.hideComments = true;
    const result = await run();
    assert.equal(result.reason, 'comment_unavailable');
    assert.equal(state.profileQueries.length, 0);
    assert.equal(state.sent, 1);
});
