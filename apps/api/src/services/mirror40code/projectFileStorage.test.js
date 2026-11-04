import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const tx = {
    ow_projects_commits: { async create(query) { state.events.push('commit'); state.commit = query.data; } },
    ow_projects_branch: { async upsert(query) { state.events.push('branch'); state.branch = query; } },
    ow_projects: { async update(query) { state.events.push('project'); state.project = query; } },
};
mock.module(url('../prisma.js'), { namedExports: { prisma: {
    ow_projects_commits: { async findFirst() { state.events.push('latest'); return state.latest; } },
    async $transaction(work) { state.transactions++; return work(tx); },
} } });
mock.module(url('../projectFileStorage.js'), { namedExports: {
    async saveProjectFile(source, options) {
        state.events.push('save');
        state.saved.push({ source, options });
        if (state.fail) throw new Error('upload failed');
        return { sha256: options.sha256, create_userid: options.userId };
    },
} });
mock.module(url('../assets.js'), { namedExports: { async uploadFile() {}, async uploadToS3() {} } });
mock.module(url('../logger.js'), { defaultExport: { warn() {}, error() {}, debug() {}, info() {} } });
mock.module(url('../config/zcconfig.js'), { defaultExport: {} });
const { default: mirror } = await import('./syncService.js');
const sourceHash = source => createHash('sha256').update(source).digest('hex');
beforeEach(() => Object.assign(state, { events: [], saved: [], transactions: 0, latest: null, fail: false, commit: null, branch: null, project: null }));
const save = source => mirror.saveProjectSourceAndCommit({ id: 7 }, 9, { id: 23, version: 'v1' }, source);

test('mirror saves canonical serialized content before committing its content hash', async () => {
    const source = { targets: [{ name: 'Sprite' }] };
    const serialized = JSON.stringify(source);
    const result = await save(source);
    assert.deepEqual(state.saved, [{ source: serialized, options: { userId: 9, sha256: sourceHash(serialized) } }]);
    assert.deepEqual(state.events, ['save', 'latest', 'commit', 'branch', 'project']);
    assert.equal(state.transactions, 1);
    assert.equal(result.sourceSha, sourceHash(serialized));
    assert.equal(state.commit.commit_file, result.sourceSha);
    assert.equal(state.branch.update.latest_commit_hash, result.commitId);
    assert.equal(state.commit.author_id, 9);
});

test('existing identical content retains commit idempotency after storage save', async () => {
    state.latest = { id: 'existing', commit_file: sourceHash('same source') };
    const result = await save('same source');
    assert.equal(result.updated, false);
    assert.equal(result.commitId, 'existing');
    assert.deepEqual(state.events, ['save', 'latest']);
    assert.equal(state.transactions, 0);
});

test('storage failure prevents commit reads and writes, and empty source never enters storage', async () => {
    state.fail = true;
    await assert.rejects(save('source'), /upload failed/);
    assert.deepEqual(state.events, ['save']);
    assert.equal(state.transactions, 0);
    await assert.rejects(save(null), /源码为空/);
    assert.equal(state.saved.length, 1);
});
