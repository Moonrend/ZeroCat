import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
mock.module(url('../prisma.js'), { namedExports: { prisma: {
    ow_projects: { async findFirst() { return state.project; } },
} } });
mock.module(url('../projectFileStorage.js'), { namedExports: {
    async readProjectFile(hash) {
        state.events.push('read-content');
        state.reads.push(hash);
        if (state.storageFail) throw new Error('S3 unavailable');
        return { sha256: hash, source: state.source };
    },
} });
mock.module(url('../projectCommitAccess.js'), { namedExports: { async findProjectCommit() {
    return { id: 'commit', commit_file: 'content-hash', commit_message: 'sync' };
} } });
mock.module(url('./authorization.js'), { namedExports: {
    async assertSyncAuthorized(payload, project) {
        state.events.push(project ? 'authorize-project' : 'authorize');
        if (project && state.denied) throw Object.assign(new Error('denied'), { status: 403 });
    },
    async loadSyncProject() { state.events.push('recheck'); return state.project; },
} });
mock.module(url('../moderation/visibility.js'), { namedExports: { async canViewContent() { return true; } } });
mock.module(url('../logger.js'), { defaultExport: { warn() {}, error() {}, debug() {}, info() {} } });
mock.module(url('../config/zcconfig.js'), { defaultExport: {} });
mock.module(url('../assets.js'), { namedExports: { async downloadFromS3() { throw new Error('Unexpected asset download'); } } });
mock.module(url('../../controllers/notifications.js'), { namedExports: { async createNotification() {} } });
mock.module(url('./githubApp.js'), { namedExports: { async createInstallationToken() { return { token: 'test' }; } } });
mock.module(url('./storage.js'), { namedExports: {
    async getProjectGitSyncSettings() { return { enabled: true, provider: 'github', linkKind: 'app', repoOwner: 'owner', repoName: 'repo' }; },
    async getProjectGitSyncState() { return {}; }, async setProjectGitSyncState(id, data) { state.savedState = data; },
    async findUserGitLink() { return { installationId: 1 }; }, async updateProjectGitSyncSettings() {},
} });
mock.module(url('./githubApi.js'), { namedExports: {
    async getRepo() { return { default_branch: 'main' }; }, async getRef() { return { object: { sha: 'parent' } }; },
    async getCommit() { return { tree: { sha: 'tree' } }; }, async getContent() { return null; }, async getTree() { return { tree: [] }; },
    async createBlob(token, owner, repo, content) { state.events.push('blob'); state.blobs.push(content); return { sha: 'blob' }; },
    async createTree() { return { sha: 'new-tree' }; }, async createCommit() { return { sha: 'new-commit' }; },
    async createRef() { state.events.push('ref'); }, async updateRef() { state.events.push('ref'); },
} });
const { default: gitSync } = await import('./syncService.js');
beforeEach(() => Object.assign(state, { project: { id: 7, authorid: 9, type: 'text', name: 'project', state: 'public' },
    events: [], reads: [], blobs: [], source: 'body from unified storage', denied: false, storageFail: false, savedState: null }));
const run = () => gitSync.syncProjectCommit({ data: { projectId: 7, commitId: 'commit', actorId: 9 } });

test('Git exports the unified-storage body only after authorization and retains publication rechecks', async () => {
    const result = await run();
    assert.equal(result.synced, true);
    assert.deepEqual(state.reads, ['content-hash']);
    assert.deepEqual(state.blobs, ['body from unified storage']);
    assert.deepEqual(state.events, ['authorize', 'authorize-project', 'read-content', 'recheck', 'blob', 'recheck', 'ref']);
});

test('unauthorized project content is never read or published', async () => {
    state.denied = true;
    await assert.rejects(run(), /denied/);
    assert.deepEqual(state.reads, []);
    assert.deepEqual(state.blobs, []);
});

test('object storage failure is reported without publishing a replacement empty file', async () => {
    state.storageFail = true;
    await assert.rejects(run(), /S3 unavailable/);
    assert.deepEqual(state.blobs, []);
    assert.equal(state.savedState.lastError, 'S3 unavailable');
});
