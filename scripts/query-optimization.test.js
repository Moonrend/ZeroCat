import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';
import { calculateDepths, updateCommitDepths } from './commit_depth.js';
import { getExtensionURLs, hasMigratableExtensions, fetchExtensionReferences } from './extension-migration-data.js';

const depthDb = commits => {
    const calls = [];
    return {
        calls,
        ow_projects_commits: {
            async findMany(args) { calls.push({ method: 'findMany', args }); return commits; },
            async updateMany(args) { calls.push({ method: 'updateMany', args }); return { count: args.where.id.in.length }; },
        },
    };
};

test('commit depths preserve roots, branches, and the missing-parent convention', () => {
    const depths = calculateDepths([
        { id: 'leaf', parent_commit_id: 'child' },
        { id: 'sibling', parent_commit_id: 'root' },
        { id: 'child', parent_commit_id: 'root' },
        { id: 'root', parent_commit_id: null },
        { id: 'orphan', parent_commit_id: 'missing' },
    ]);
    assert.equal(depths.get('root'), 0);
    assert.equal(depths.get('child'), 1);
    assert.equal(depths.get('sibling'), 1);
    assert.equal(depths.get('leaf'), 2);
    assert.equal(depths.get('orphan'), 1);
});

test('deep commit histories use iterative traversal without overflowing the stack', () => {
    const commits = Array.from({ length: 20000 }, (_, index) => ({ id: String(index), parent_commit_id: index ? String(index - 1) : null })).reverse();
    const depths = calculateDepths(commits);
    assert.equal(depths.get('19999'), 19999);
    assert.equal(depths.get('0'), 0);
});

test('depth maintenance reads metadata once, skips correct depths and batches matching updates', async () => {
    const db = depthDb([
        { id: 'root', parent_commit_id: null, depth: 0 },
        { id: 'one', parent_commit_id: 'root', depth: null },
        { id: 'two', parent_commit_id: 'root', depth: 4 },
        { id: 'leaf', parent_commit_id: 'two', depth: 2 },
    ]);
    assert.deepEqual(await updateCommitDepths(db), { total: 4, updated: 2 });
    assert.deepEqual(db.calls, [
        { method: 'findMany', args: { select: { id: true, parent_commit_id: true, depth: true } } },
        { method: 'updateMany', args: { where: { id: { in: ['one', 'two'] } }, data: { depth: 1 } } },
    ]);
});

test('depth writes are chunked to 1000 IDs and empty runs do not write', async () => {
    const db = depthDb(Array.from({ length: 1001 }, (_, index) => ({ id: String(index), parent_commit_id: null, depth: null })));
    assert.deepEqual(await updateCommitDepths(db), { total: 1001, updated: 1001 });
    assert.deepEqual(db.calls.slice(1).map(call => call.args.where.id.in.length), [1000, 1]);
    const empty = depthDb([]);
    assert.deepEqual(await updateCommitDepths(empty), { total: 0, updated: 0 });
    assert.equal(empty.calls.length, 1);
});

test('cycles fail before writing and concurrent deletions are not silently ignored', async () => {
    const cyclic = depthDb([{ id: 'one', parent_commit_id: 'two' }, { id: 'two', parent_commit_id: 'one' }]);
    await assert.rejects(updateCommitDepths(cyclic), /循环/);
    assert.equal(cyclic.calls.length, 1);
    const missing = depthDb([{ id: 'root', parent_commit_id: null }]);
    missing.ow_projects_commits.updateMany = async () => ({ count: 0 });
    await assert.rejects(updateCommitDepths(missing), /已被删除/);
});

test('extension metadata is fetched once per table and mapped to the right source', async () => {
    const calls = [];
    const db = {
        ow_projects_commits: { async findMany(args) {
            calls.push(args);
            return [
                { id: 'a1', project_id: 1, commit_file: 'a' },
                { id: 'a2', project_id: 1, commit_file: 'a' },
                { id: 'a3', project_id: 2, commit_file: 'a' },
                { id: 'b1', project_id: 2, commit_file: 'b' },
                { id: 'b2', project_id: 9, commit_file: 'b' },
            ];
        } },
        ow_projects: { async findMany(args) {
            calls.push(args);
            return [{ id: 2, title: 'Two', name: 'two' }, { id: 1, title: 'One', name: 'one' }];
        } },
    };
    const refs = await fetchExtensionReferences(db, ['a', 'b', 'empty', 'a']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].where, { commit_file: { in: ['a', 'b', 'empty'] } });
    assert.deepEqual(calls[1].where, { id: { in: [1, 2, 9] } });
    assert.deepEqual(refs.get('a').commits, [{ id: 'a1', project_id: 1 }, { id: 'a2', project_id: 1 }, { id: 'a3', project_id: 2 }]);
    assert.deepEqual(refs.get('a').projects.map(project => project.id), [2, 1]);
    assert.deepEqual(refs.get('b').projects.map(project => project.id), [2]);
    assert.deepEqual(refs.get('empty'), { commits: [], projects: [] });
});

test('extension metadata caps project lookups at 1000 IDs', async () => {
    const batchSizes = [];
    const db = {
        ow_projects_commits: { async findMany() {
            return Array.from({ length: 1001 }, (_, index) => ({ id: `commit-${index}`, project_id: index + 1, commit_file: 'shared' }));
        } },
        ow_projects: { async findMany({ where }) {
            batchSizes.push(where.id.in.length);
            return where.id.in.map(id => ({ id, name: String(id), title: String(id) }));
        } },
    };
    const references = await fetchExtensionReferences(db, ['shared']);
    assert.deepEqual(batchSizes, [1000, 1]);
    assert.equal(references.get('shared').projects.length, 1001);
});

test('extension export avoids metadata queries without matching URLs or projects', async () => {
    const urls = getExtensionURLs({ sha256: 'a', source: JSON.stringify({ extensionURLs: { a: 'https://example.test/a.js', b: 1 } }) });
    assert.equal(hasMigratableExtensions(urls), false);
    assert.equal(hasMigratableExtensions({ a: ' data:text/javascript;base64,YQ== ' }), true);
    assert.equal(hasMigratableExtensions({ a: 'https://extensions.turbowarp.org/a.js' }), true);
    assert.equal(getExtensionURLs({ sha256: 'a', source: 'null' }), null);
    assert.equal((await fetchExtensionReferences({}, [])).size, 0);
    let reads = 0;
    const db = { ow_projects_commits: { async findMany() { reads++; return []; } } };
    assert.deepEqual((await fetchExtensionReferences(db, ['a'])).get('a'), { commits: [], projects: [] });
    assert.equal(reads, 1);
});

const url = path => new URL(path, import.meta.url).href;
const state = {};
const db = {
    ow_projects: {
        async findMany(args) {
            state.reads.push({ method: 'findMany', args });
            if (state.failBatch) throw new Error('batch failed');
            return state.projects;
        },
        async findUnique(args) { state.reads.push({ method: 'findUnique', args }); return state.projects.find(project => project.id === args.where.id) || null; },
        async update(args) { state.writes.push({ method: 'project.update', args }); return args.data; },
    },
    ow_projects_commits: {
        async findFirst(args) {
            state.reads.push({ method: 'findFirst', args });
            return state.latest ? Object.fromEntries(Object.keys(args.select).map(key => [key, state.latest[key]])) : null;
        },
        async create(args) { state.writes.push({ method: 'commit.create', args }); return args.data; },
    },
    ow_projects_file: {
        async create() { assert.fail('project source writes must use projectFileStorage'); },
        async findMany(args) { state.reads.push({ method: 'file.findMany', args }); return state.exportFiles; },
    },
    ow_projects_branch: { async upsert(args) { state.writes.push({ method: 'branch.upsert', args }); return args.create; } },
};
mock.module(url('../apps/api/src/services/prisma.js'), { namedExports: { prisma: db } });
mock.module(url('../apps/api/src/services/logger.js'), { defaultExport: { info() {}, warn() {}, error() {}, debug() {} } });
mock.module(url('../apps/api/src/services/config/zcconfig.js'), { defaultExport: {} });
mock.module(url('../apps/api/src/default_project.js'), { defaultExport: {} });
mock.module(url('../apps/api/src/services/projectFileStorage.js'), { namedExports: {
    PROJECT_FILE_SELECT: {
        sha256: true, source: true, create_time: true, create_userid: true,
        storage_provider: true, storage_bucket: true, storage_key: true,
        content_size: true, content_sha256: true, content_type: true, search_preview: true,
    },
    async saveProjectFile(source, options) {
        state.writes.push({ method: 'file.save', source, options });
        if (state.fileFailure) throw state.fileFailure;
        return { sha256: options.sha256, source: null, storage_provider: 's3' };
    },
    async hydrateProjectFiles(rows) {
        state.hydrateCalls.push(rows);
        if (state.hydrationFailure) throw state.hydrationFailure;
        return rows.map(row => ({ ...row, source: row.storage_provider === 's3' ? state.storedSources.get(row.sha256) : row.source }));
    },
} });
mock.module(url('../apps/api/src/services/assets.js'), { namedExports: {
    processImage: async () => ({ buffer: Buffer.from('webp'), size: 4, compressionRatio: 1, width: 1, height: 1 }),
    generateMD5: () => 'abcdef',
    uploadToS3: async (...args) => state.uploads.push(args),
} });
const { default: ScratchThumbnailMigrator } = await import('./migrate-scratch-thumbnails.js');
const { createMigrationCommit } = await import('./migrate-user-motto-to-article-projects.js');
const { loadExportBatch } = await import('./export-extension-migration.js');
beforeEach(() => Object.assign(state, {
    reads: [], writes: [], uploads: [], projects: [], latest: null, failBatch: false, fileFailure: null,
    exportFiles: [], hydrateCalls: [], storedSources: new Map(), hydrationFailure: null,
}));

for (const dryRun of [false, true]) {
    test(`thumbnail batch keeps existing/missing skips and completed-image writes (dryRun=${dryRun})`, async () => {
        state.projects = [
            { id: 1, title: 'Already migrated', thumbnail: 'old.webp' },
            { id: 3, title: 'Three', thumbnail: '' },
            { id: 4, title: 'Four', thumbnail: '' },
            { id: 5, title: 'Five', thumbnail: '' },
        ];
        const migrator = new ScratchThumbnailMigrator();
        migrator.listScratchThumbnails = async () => [1, 2, 3, 4, 5].map(projectId => ({ projectId, key: `scratch_slt/${projectId}` }));
        migrator.downloadImage = async () => Buffer.from('image');
        await migrator.migrate({ dryRun });
        assert.deepEqual(migrator.stats, { total: 5, processed: 3, skipped: 1, errors: 0, projectNotFound: 1 });
        assert.equal(state.reads.length, 1);
        assert.deepEqual(state.reads[0].args.where, { id: { in: [1, 2, 3, 4, 5] } });
        assert.equal(state.writes.length, dryRun ? 0 : 3);
        assert.equal(state.uploads.length, dryRun ? 0 : 3);
    });
}

test('thumbnail prefetch failure retains per-project lookup and skip handling', async () => {
    state.failBatch = true;
    state.projects = [{ id: 1, thumbnail: 'done.webp' }];
    const migrator = new ScratchThumbnailMigrator();
    migrator.listScratchThumbnails = async () => [{ projectId: 1 }, { projectId: 2 }];
    await migrator.migrate({ dryRun: true });
    assert.deepEqual(state.reads.map(call => call.method), ['findMany', 'findUnique', 'findUnique']);
    assert.equal(migrator.stats.skipped, 1);
    assert.equal(migrator.stats.projectNotFound, 1);
    assert.equal(state.writes.length, 0);
});

test('re-running an already migrated README does not recreate files, commits or branch writes', async () => {
    const sourceSha = createHash('sha256').update('hello\n').digest('hex');
    state.latest = { id: 'existing', commit_file: sourceSha, commit_message: '迁移README.md内容' };
    assert.deepEqual(await createMigrationCommit({ id: 7 }, { id: 3 }, ' hello ', false), { commitId: 'existing', sourceSha, created: false });
    assert.deepEqual(state.reads[0].args.select, { id: true, commit_file: true, commit_message: true });
    assert.equal(state.writes.length, 0);
});

test('README migration saves source through the shared service before commit and branch writes', async () => {
    state.latest = { id: 'parent', commit_file: 'older', commit_message: 'edit' };
    const result = await createMigrationCommit({ id: 7 }, { id: 3 }, 'new content', false);
    assert.equal(result.created, true);
    assert.deepEqual(state.writes.map(call => call.method), ['file.save', 'commit.create', 'branch.upsert']);
    assert.equal(state.writes[0].source, 'new content\n');
    assert.equal(state.writes[0].options.userId, 3);
    assert.equal(state.writes[0].options.sha256, result.sourceSha);
    assert.equal(state.writes[0].options.db, db);
    assert.equal(state.writes[1].args.data.parent_commit_id, 'parent');
    assert.equal(state.writes[2].args.update.latest_commit_hash, result.commitId);
    state.writes = [];
    assert.equal((await createMigrationCommit({ id: 7 }, { id: 3 }, 'different', true)).created, true);
    assert.equal(state.writes.length, 0);
});

test('README source failures still stop commit and branch writes', async () => {
    state.fileFailure = Object.assign(new Error('database error'), { code: 'P1000' });
    await assert.rejects(createMigrationCommit({ id: 7 }, { id: 3 }, 'content', false), /database error/);
    assert.deepEqual(state.writes.map(call => call.method), ['file.save']);
});

test('extension export hydrates legacy and S3 records without rereading metadata', async () => {
    const remoteSource = JSON.stringify({ extensionURLs: { remote: 'https://extensions.turbowarp.org/example.js' } });
    state.exportFiles = [
        { sha256: 'legacy', source: '{"extensionURLs":{}}', storage_provider: null },
        { sha256: 'remote', source: null, storage_provider: 's3', storage_bucket: 'private', storage_key: 'source-key',
            content_size: remoteSource.length, content_type: 'text/plain', search_preview: '' },
        { sha256: 'empty', source: '', storage_provider: null },
    ];
    state.storedSources.set('remote', remoteSource);
    const result = await loadExportBatch(db, 'previous');
    assert.deepEqual(result.map(row => row.sha256), ['legacy', 'remote', 'empty']);
    assert.equal(result[0].source, state.exportFiles[0].source);
    assert.equal(result[1].source, remoteSource);
    assert.equal(result[2].source, '');
    assert.equal(hasMigratableExtensions(getExtensionURLs(result[1])), true);
    assert.equal(state.hydrateCalls.length, 1);
    assert.equal(state.hydrateCalls[0], state.exportFiles);
    assert.equal(state.reads.length, 1);
    assert.deepEqual(state.reads[0].args.where, { sha256: { gt: 'previous' } });
    assert.equal(state.reads[0].args.take, 100);
    for (const field of ['source', 'storage_provider', 'storage_bucket', 'storage_key', 'content_size', 'content_sha256', 'content_type', 'search_preview']) {
        assert.equal(state.reads[0].args.select[field], true);
    }
});

test('extension export skips hydration for empty pages and surfaces S3 read failures', async () => {
    assert.deepEqual(await loadExportBatch(db), []);
    assert.equal(state.hydrateCalls.length, 0);
    state.exportFiles = [{ sha256: 'remote', source: null, storage_provider: 's3' }];
    state.hydrationFailure = new Error('S3 unavailable');
    await assert.rejects(loadExportBatch(db), /S3 unavailable/);
});
