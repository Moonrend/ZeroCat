import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
let processJob;
mock.module('bullmq', { namedExports: { Worker: class {
    constructor(name, handler) { processJob = handler; }
    on() {}
} } });
mock.module(url('../redisConnectionFactory.js'), { namedExports: { async createConnection() { return {}; } } });
mock.module(url('../queues.js'), { namedExports: { QUEUE_NAMES: { EMBEDDING: 'embedding' } } });
mock.module(url('../../logger.js'), { defaultExport: { warn() {}, error() {}, debug() {}, info() {} } });
mock.module(url('../../config/zcconfig.js'), { defaultExport: { async get() { return null; } } });
mock.module(url('../../prisma.js'), { namedExports: { prisma: {
    ow_projects: {
        async findUnique() { return state.project; },
        async findMany(query) { state.authoredQueries.push(query); return [state.project]; },
    },
    ow_users: { async findUnique() { return { id: 9, username: 'readme' }; } },
    async $queryRawUnsafe(sql, id) { state.events.push('metadata'); state.queries.push({ sql, id }); return state.rows; },
} } });
mock.module(url('../../projectFileStorage.js'), { namedExports: {
    async hydrateProjectFile(row) {
        state.events.push('hydrate');
        state.hydrated.push(row);
        if (state.storageFail) throw new Error('S3 unavailable');
        return { ...row, source: row.source ?? state.objectSource };
    },
} });
mock.module(url('../../moderation/visibility.js'), { namedExports: {
    async canViewContent(kind) { state.events.push(`authorize-${kind}`); return state.visible; },
    async visibleWhere(kind) { return { moderation_kind: kind }; },
} });
mock.module(url('../../embedding.js'), { defaultExport: {
    async getEmbedding() { return null; }, hashText() { return 'hash'; },
    async generateProjectEmbedding(payload) { state.generated.push(payload); return [1, 2]; },
    async saveEmbedding() {},
    buildUserSeedText(payload) { state.seed = payload; throw new Error('seed captured'); },
} });
mock.module(url('../../gorse.js'), { defaultExport: { async upsertProject() {} } });
const { createEmbeddingWorker } = await import('./embeddingWorker.js');
await createEmbeddingWorker();
const run = (type = 'project_embedding') => processJob({ data: { type, projectId: 7, userId: 9 }, async log() {} });
beforeEach(() => Object.assign(state, { project: { id: 7, authorid: 9, name: 'readme', title: 'Project', type: 'scratch', state: 'public' },
    events: [], queries: [], rows: [{ sha256: 'hash', source: null, storage_key: 'object-key' }], hydrated: [],
    objectSource: JSON.stringify({ targets: [{ name: 'Stored sprite' }] }), generated: [], authoredQueries: [], seed: null,
    visible: true, storageFail: false }));

test('project worker hydrates selected metadata and uses object-storage content without a second database read', async () => {
    const result = await run();
    assert.equal(result.projectId, 7);
    assert.equal(state.queries.length, 1);
    assert.match(state.queries[0].sql, /SELECT pf\.sha256, pf\.source/);
    assert.match(state.queries[0].sql, /pf\.storage_provider, pf\.storage_bucket, pf\.storage_key/);
    assert.doesNotMatch(state.queries[0].sql, /search_vector|pf\.\*/);
    assert.match(state.queries[0].sql, /JOIN ow_projects_file pf ON pf\.sha256 = pc\.commit_file/);
    assert.match(state.queries[0].sql, /ORDER BY pc\.commit_date DESC\s+LIMIT 1/);
    assert.equal(state.queries[0].id, 7);
    assert.equal(state.hydrated[0], state.rows[0]);
    assert.match(state.generated[0].text, /Stored sprite/);
    assert.deepEqual(state.events.slice(0, 3), ['authorize-project', 'metadata', 'hydrate']);
});

test('legacy inline rows use the same hydration contract and keep their source text', async () => {
    state.rows = [{ sha256: 'legacy-hash', source: JSON.stringify({ name: 'Legacy sprite' }) }];
    await run();
    assert.match(state.generated[0].text, /Legacy sprite/);
    assert.equal(state.hydrated[0], state.rows[0]);
});

test('hidden or private projects never load metadata or object content', async () => {
    state.visible = false;
    assert.equal((await run()).reason, 'deleted');
    state.visible = true;
    state.project.state = 'private';
    assert.equal((await run()).reason, 'deleted');
    assert.deepEqual(state.queries, []);
    assert.deepEqual(state.hydrated, []);
});

test('hydration failure propagates before vector generation', async () => {
    state.storageFail = true;
    await assert.rejects(run(), /S3 unavailable/);
    assert.deepEqual(state.generated, []);
});

test('user README selection shares the unified hydration path after profile and project filtering', async () => {
    await assert.rejects(run('user_embedding'), /seed captured/);
    assert.equal(state.queries.length, 1);
    assert.equal(state.seed.readmeProjectSource, state.objectSource);
    assert.equal(state.authoredQueries[0].where.state, 'public');
    assert.deepEqual(state.authoredQueries[0].where.AND, [{ moderation_kind: 'project' }]);
    assert.deepEqual(state.events, ['authorize-profile', 'metadata', 'hydrate']);
});
