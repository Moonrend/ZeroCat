import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const state = {};
const noop = () => {};
mock.module('./logger.js', { defaultExport: { info: noop, warn: noop, debug: noop,
    error: (...args) => state.loggedErrors.push(args) } });
mock.module('./config/zcconfig.js', { defaultExport: {
    get: async key => ({ 'urls.frontend': 'https://site.example.test', 's3.bucket': 'public-assets' })[key],
    set: async (key, value) => { state.configWrites.push({ key, value }); },
} });
mock.module('./prisma.js', { namedExports: { prisma: {
    ow_projects: { findMany: async () => [{ name: 'demo', author: { username: 'owner' } }] },
    ow_users: { findMany: async () => [] },
} } });
mock.module('./moderation/visibility.js', { namedExports: { visibleWhere: async () => ({}) } });
mock.module('./projectFileStorage.js', { namedExports: { async saveProjectFile(source, options) {
    state.fileWrites.push({ source, options });
    if (state.storageError) throw state.storageError;
    return { sha256: createHash('sha256').update(source).digest('hex') };
} } });
mock.module('./objectStorage.js', { namedExports: { async putObject(input) {
    state.objectWrites.push(input);
    if (state.storageError) throw state.storageError;
    return { ETag: 'uploaded' };
} } });
const { writeSourceFile } = await import('./commitService.js');
const { default: sitemap } = await import('./sitemap.js');
const { S3update } = await import('./global.js');

beforeEach(() => {
    Object.assign(state, { fileWrites: [], configWrites: [], objectWrites: [], loggedErrors: [], storageError: null });
    sitemap.isGenerating = false;
});

test('commit source writes preserve normalization and return the unified storage hash', async () => {
    for (const [input, expected] of [['正文', '正文'], [undefined, ''], [null, ''], [42, '42']]) {
        assert.equal(await writeSourceFile(input, 9), createHash('sha256').update(expected).digest('hex'));
        assert.deepEqual(state.fileWrites.at(-1), { source: expected, options: { userId: 9 } });
    }
});

test('source write failure propagates without returning a usable hash', async () => {
    state.storageError = new Error('S3 unavailable');
    await assert.rejects(writeSourceFile('source', 9), error => error === state.storageError);
    assert.equal(state.fileWrites.length, 1);
});

test('sitemap saves Base64 source, hashes the saved text and publishes its pointer after storage succeeds', async () => {
    const hash = await sitemap.generateFullSitemap();
    assert.equal(state.fileWrites.length, 1);
    const { source, options } = state.fileWrites[0];
    assert.deepEqual(options, { userId: 1 });
    assert.match(gunzipSync(Buffer.from(source, 'base64')).toString('utf8'), /https:\/\/site.example.test\/owner\/demo/);
    assert.equal(hash, createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(state.configWrites[0], { key: 'sitemap.current_file_hash', value: hash });
    assert.equal(state.configWrites[1].key, 'sitemap.last_full_update');
    assert.equal(sitemap.isGenerating, false);
});

test('sitemap storage failure retains the old pointer and releases the generation lock', async () => {
    state.storageError = new Error('S3 unavailable');
    await assert.rejects(sitemap.generateIncrementalSitemap(), error => error === state.storageError);
    assert.deepEqual(state.configWrites, []);
    assert.equal(sitemap.isGenerating, false);
    state.storageError = null;
    await sitemap.generateIncrementalSitemap();
    assert.equal(state.configWrites[1].key, 'sitemap.last_incremental_update');
});

test('legacy global upload wrapper keeps its bucket, absent ACL and logged-error behavior', async () => {
    const body = Buffer.from('asset');
    assert.equal(await S3update('key', body), undefined);
    assert.deepEqual(state.objectWrites, [{ bucket: 'public-assets', key: 'key', body }]);
    state.storageError = new Error('upload failed');
    assert.equal(await S3update('key', body), undefined);
    assert.equal(state.loggedErrors.length, 1);
    assert.equal(state.loggedErrors[0][1], state.storageError);
});
