import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const prisma = {
    ow_user_restrictions: { async findMany(query) {
        state.restrictions.push(query);
        return [...state.hidden].filter(id => query.where.user_id.in.includes(id)).map(user_id => ({ user_id }));
    } },
    ow_comment_service: {
        async groupBy(query) { state.groups.push(query); return query.by[0] === 'url' ? state.urlGroups : state.statusGroups; },
        async count(query) { state.counts.push(query); return 11; },
        async findMany(query) { state.comments.push(query); return state.rows; },
    },
    ow_comment_service_users: {
        async findMany() { return state.users.map(user => ({ user_id: user.id, display_name: user.display_name, type: 'guest', label: 'label' })); },
        async count() { return 3; },
    },
    ow_users: { async findMany() { return state.users; } },
};
mock.module(url('../prisma.js'), { namedExports: { prisma } });
mock.module(url('../logger.js'), { defaultExport: { error() {}, warn() {}, info() {} } });
mock.module(url('../redis.js'), { defaultExport: {} });
mock.module(url('../config/zcconfig.js'), { defaultExport: { async get() { return 'https://example.test'; } } });
mock.module(url('../ip/ipLocation.js'), { defaultExport: {} });
mock.module(url('../moderation/visibility.js'), { namedExports: {
    async visibleWhere(kind, viewerId) { return { moderation_kind: kind, viewer: viewerId }; },
    async visibleSql() { return { text: 'TRUE', values: [] }; },
    async canViewContent(kind, record, viewerId) { state.singleChecks++; return !state.hidden.has(record.id) || Number(viewerId) === record.id; },
    async assertCanWrite() {},
} });
mock.module(url('../auth/resourceOperation.js'), { namedExports: { async authorizeResourceOperation() { return {}; } } });
mock.module(url('./markdown.js'), { namedExports: { renderMarkdown(value) { return value; } } });
mock.module(url('./sanitizer.js'), { namedExports: { sanitizeComment(value) { return value; } } });
mock.module(url('./akismetService.js'), { namedExports: { async checkAkismetSpam() { return false; } } });
mock.module(url('./levelService.js'), { namedExports: { async batchGetUserLevels() { return new Map(); } } });
const { getCommentCount, getRecentComments, getCommentList } = await import('./commentManager.js');
const { getSpaceStats } = await import('./spaceManager.js');
const { formatComment } = await import('./walineFormatter.js');
const { getCommentProfileVisibility } = await import('./profileVisibility.js');
const row = (id, accountId) => ({ id, account_user_id: accountId, comment: 'text', nick: 'visible name', mail: 'private@example.test',
    link: 'https://profile.test', insertedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), url: '/', status: 'approved' });

beforeEach(() => Object.assign(state, { hidden: new Set(), restrictions: [], groups: [], counts: [], comments: [], rows: [], users: [],
    singleChecks: 0, urlGroups: [], statusGroups: [] }));

test('URL counts use one grouped read while retaining requested order, duplicates, missing URLs and visibility', async () => {
    state.urlGroups = [{ url: '/b', _count: { _all: 2 } }, { url: '/a', _count: { _all: 4 } }];
    assert.deepEqual(await getCommentCount(8, ['/a', '/missing', '/b', '/a'], { userId: 7 }), [4, 0, 2, 4]);
    assert.equal(state.groups.length, 1);
    assert.equal(state.counts.length, 0);
    assert.deepEqual(state.groups[0].where.url.in, ['/a', '/missing', '/b']);
    assert.equal(state.groups[0].where.space_id, 8);
    assert.equal(state.groups[0].where.AND[0].viewer, 7);
    assert.deepEqual(state.groups[0].where.AND[1], { OR: [{ status: 'approved' }, { account_user_id: 7 }] });
});

test('count scalar, forceArray and space-wide count contracts remain intact', async () => {
    assert.equal(await getCommentCount(8, '/missing'), 0);
    assert.deepEqual(await getCommentCount(8, '/missing', { forceArray: true }), [0]);
    assert.equal(await getCommentCount(8, []), 11);
    assert.equal(state.groups.length, 2);
    assert.equal(state.counts.length, 1);
});

test('space stats include all statuses and default absent moderation counts to zero', async () => {
    state.statusGroups = [{ status: 'approved', _count: { _all: 4 } }, { status: 'waiting', _count: { _all: 2 } },
        { status: 'custom', _count: { _all: 3 } }];
    assert.deepEqual(await getSpaceStats(8), { commentCount: 9, userCount: 3, waitingCount: 2, spamCount: 0 });
    assert.equal(state.groups.length, 1);
    assert.equal(state.counts.length, 0);
});

test('recent comments share profile visibility across repeated authors and keep self visibility', async () => {
    state.hidden = new Set([7, 9]);
    state.rows = [row(1, 7), row(2, 9), row(3, 9), row(4, null), row(5, 12)];
    state.users = [{ id: 7, username: 'self', display_name: 'Self' }, { id: 9, username: 'hidden', display_name: 'Hidden' }];
    const result = await getRecentComments(8, 10, {}, { userId: 7 });
    assert.equal(result[0].nick, 'Self');
    for (const hidden of result.slice(1, 3)) {
        assert.equal(hidden.nick, '用户');
        assert.equal(hidden.user_id, null);
        assert.equal(hidden.link, '');
        assert.equal(hidden.avatar, '');
        assert.equal(hidden.type, undefined);
    }
    assert.equal(result[3].nick, 'visible name');
    assert.equal(result[4].nick, 'visible name'); // Missing profile rows retain the comment fallback.
    assert.equal(state.singleChecks, 0);
    assert.equal(state.restrictions.length, 1);
    assert.deepEqual(state.restrictions[0].where.user_id.in, [9, 12]);
    assert.equal(state.restrictions[0].where.type, 'shadowban');
    assert.equal(state.restrictions[0].where.revoked_at, null);
    assert.deepEqual(state.restrictions[0].where.AND[1], { categories: { hasSome: ['*', 'profile'] } });
});

test('management counts keep space scope while rows retain owner, status and pagination filters', async () => {
    state.rows = [row(1, 7)];
    state.hidden.add(7);
    state.statusGroups = [{ status: 'spam', _count: { _all: 4 } }];
    const result = await getCommentList(8, { page: 2, pageSize: 5, owner: 'mine', status: 'approved', userId: 7 });
    assert.equal(result.spamCount, 4);
    assert.equal(result.waitingCount, 0);
    assert.equal(result.count, 11);
    assert.equal(result.totalPages, 3);
    assert.equal(result.data[0].nick, '用户'); // The management formatter keeps its public profile mask.
    assert.equal(result.data[0].mail, 'private@example.test');
    assert.equal(state.comments[0].skip, 5);
    assert.equal(state.comments[0].where.account_user_id, 7);
    assert.equal(state.counts[0].where.status, 'approved');
    assert.equal(state.groups[0].where.account_user_id, undefined);
    assert.equal(state.groups[0].where.AND[0].viewer, 7);
    assert.equal(state.singleChecks, 0);
});

test('standalone formatting checks visibility and cannot reuse a result for another viewer or author', async () => {
    state.hidden.add(7);
    const selfVisibility = await getCommentProfileVisibility([7], 7);
    assert.equal(state.restrictions.length, 0);
    assert.equal((await formatComment(row(1, 7), { profileVisibility: selfVisibility })).nick, '用户');
    const otherVisibility = await getCommentProfileVisibility([9], null);
    assert.equal((await formatComment(row(2, 7), { profileVisibility: otherVisibility })).nick, '用户');
    assert.equal((await formatComment(row(3, 7))).nick, '用户');
    assert.equal(state.singleChecks, 3);
});

test('large profile sets use bounded queries and preserve hidden IDs across batches', async () => {
    state.hidden = new Set([1, 1001]);
    const visibility = await getCommentProfileVisibility(Array.from({ length: 1002 }, (_, i) => i + 1));
    assert.equal(state.restrictions.length, 2);
    assert.deepEqual([...visibility.hiddenUserIds], [1, 1001]);
    assert.equal(visibility.userIds.size, 1002);
    assert.equal(state.restrictions[0].where.user_id.in.length, 1000);
});
