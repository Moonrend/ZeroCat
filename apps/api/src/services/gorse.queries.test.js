import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const models = { post: 'ow_posts', project: 'ow_projects', profile: 'ow_users' };
const prisma = {
    ow_user_restrictions: { async findMany(query) {
        state.actorQueries.push(query);
        return state.hiddenActors.filter(id => query.where.user_id.in.includes(id)).map(user_id => ({ user_id }));
    } },
};
for (const [kind, model] of Object.entries(models)) {
    prisma[model] = { async findMany(query) {
        state.resourceQueries.push({ kind, query });
        assert.deepEqual(query.where.AND, [{ visibility: kind }]);
        return query.where.id.in.filter(id => state.allowed[kind].includes(id)).map(id => ({ id }));
    } };
}
mock.module(url('./prisma.js'), { namedExports: { prisma } });
mock.module(url('./logger.js'), { defaultExport: { info() {}, warn() {}, error() {}, debug() {} } });
mock.module(url('./config/zcconfig.js'), { defaultExport: { async get() { return 'test'; } } });
mock.module(url('./moderation/visibility.js'), { namedExports: {
    async visibleWhere(kind) { state.visibilityReads.push(kind); return { visibility: kind }; },
    async canViewContent() { throw new Error('Bulk paths must not perform per-item visibility checks'); },
} });
mock.module(url('./embedding.js'), { namedExports: {
    async getEmbeddings(_kind, ids) { return new Map(ids.map(id => [id, [0.5]])); },
} });
mock.module('gorsejs', { namedExports: { Gorse: class {
    async upsertFeedbacks(rows) { state.feedbacks.push(...rows); }
    async upsertItems(rows) { state.items.push(...rows); }
    async insertUsers() {}
} } });
const { insertFeedbacks, insertPosts, insertProjects } = await import('./gorse.js');
beforeEach(() => Object.assign(state, {
    allowed: { post: [], project: [], profile: [] }, hiddenActors: [], actorQueries: [],
    resourceQueries: [], visibilityReads: [], feedbacks: [], items: [],
}));

test('bulk feedback deduplicates targets and checks actor and resource visibility once per kind', async () => {
    state.allowed = { post: [1], project: [2], profile: [3] };
    state.hiddenActors = [9];
    const rows = Array.from({ length: 100 }, () => ({ userId: 7, itemId: 'post_1', feedbackType: 'like' }));
    rows.push({ userId: 9, itemId: 'post_1' }, { userId: 7, itemId: 'post_99' },
        { userId: 7, itemId: 'project_2' }, { userId: 7, itemId: 'user_3' }, { userId: 7, itemId: 'invalid' });
    await insertFeedbacks(rows);
    assert.equal(state.feedbacks.length, 102);
    assert.equal(state.actorQueries.length, 1);
    assert.equal(state.actorQueries[0].where.type, 'shadowban');
    assert.deepEqual(state.actorQueries[0].where.AND.at(-1), { categories: { hasSome: ['*', 'activity'] } });
    assert.equal(state.resourceQueries.length, 3);
    assert.deepEqual(state.resourceQueries[0].query.where.id.in, [1, 99]);
    assert.equal(state.feedbacks.some(row => row.UserId === '9' || row.ItemId === 'post_99'), false);
});

test('another bulk call observes a newly hidden target without a visibility cache', async () => {
    state.allowed.post = [1];
    const rows = [{ userId: 7, itemId: 'post_1' }];
    await insertFeedbacks(rows);
    state.allowed.post = [];
    await insertFeedbacks(rows);
    assert.equal(state.feedbacks.length, 1);
    assert.equal(state.resourceQueries.length, 2);
    assert.equal(state.actorQueries.length, 2);
});

test('bulk content checks canonical rows in bounded chunks and keeps caller ordering', async () => {
    state.allowed.post = Array.from({ length: 501 }, (_, index) => index + 1);
    await insertPosts(state.allowed.post.map(id => ({ id, post_type: 'normal', content: String(id) })));
    assert.equal(state.resourceQueries.length, 2);
    assert.equal(state.resourceQueries[0].query.where.id.in.length, 500);
    assert.equal(state.resourceQueries[1].query.where.id.in.length, 1);
    assert.deepEqual(state.visibilityReads, ['post']);
    assert.equal(state.items.length, 501);
    assert.equal(state.items[500].ItemId, 'post_501');
});

test('bulk projects still require public state and empty input performs no database reads', async () => {
    state.allowed.project = [1, 2];
    await insertProjects([{ id: 1, state: 'public' }, { id: 2, state: 'private' }, { id: 3, state: 'public' }]);
    assert.deepEqual(state.items.map(item => item.ItemId), ['project_1']);
    const reads = state.resourceQueries.length;
    await insertFeedbacks([]);
    await insertPosts([]);
    assert.equal(state.resourceQueries.length, reads);
    assert.equal(state.actorQueries.length, 0);
});
