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
mock.module(url('../queues.js'), { namedExports: { QUEUE_NAMES: { SCHEDULED_TASKS: 'scheduled' } } });
mock.module(url('../../memoryCache.js'), { defaultExport: {} });
mock.module(url('../../logger.js'), { defaultExport: { info() {}, warn() {}, debug() {}, error() {} } });
mock.module(url('../../config/zcconfig.js'), { defaultExport: {} });
mock.module(url('../../extensionReview.js'), { namedExports: { async getAllApprovedProjectIds() { return state.approved; } } });
mock.module(url('../../prisma.js'), { namedExports: { prisma: {
    ow_projects: { async findMany(query) { state.reads.push(query); return state.projects.filter(p => query.where.id.in.includes(p.id)); } },
    ow_scratch_extensions: { async upsert(query) {
        if (query.where.projectid === state.failId) throw new Error('upsert failed');
        state.writes.push(query);
    } },
} } });
const { createScheduledTasksWorker } = await import('./scheduledTasksWorker.js');
await createScheduledTasksWorker();
const run = () => processJob({ name: 'extension-sync', data: {}, async log(text) { state.logs.push(text); } });
beforeEach(() => Object.assign(state, { approved: [], projects: [], reads: [], writes: [], logs: [], failId: null }));

test('extension sync batches project reads and preserves approved order and missing-project handling', async () => {
    state.approved = [3, 2, 1];
    state.projects = [{ id: 1, default_branch: 'main' }, { id: 3, default_branch: null }];
    await run();
    assert.equal(state.reads.length, 1);
    assert.deepEqual(state.reads[0].select, { id: true, default_branch: true });
    assert.deepEqual(state.writes.map(q => q.where.projectid), [3, 1]);
    assert.deepEqual(state.writes.map(q => q.create.branch), ['', 'main']);
    assert.deepEqual(state.writes[0].update, { status: 'verified', commit: 'latest' });
    assert.ok(state.logs.includes('Synced 2 extensions'));
});

test('upsert failures still leave only preceding entries synced and abort later writes', async () => {
    state.approved = [1, 2, 3];
    state.projects = state.approved.map(id => ({ id, default_branch: 'main' }));
    state.failId = 2;
    await assert.rejects(run(), /upsert failed/);
    assert.deepEqual(state.writes.map(q => q.where.projectid), [1]);
});

test('empty sync skips reads and large lists use bounded batches', async () => {
    await run();
    assert.equal(state.reads.length, 0);
    state.approved = Array.from({ length: 1001 }, (_, i) => i + 1);
    await run();
    assert.deepEqual(state.reads.map(q => q.where.id.in.length), [1000, 1]);
});
