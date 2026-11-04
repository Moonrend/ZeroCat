import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = {};
const noop = () => {};
mock.module('./logger.js', { defaultExport: { info: noop, warn: noop, error: noop, debug: noop } });
mock.module('./config/zcconfig.js', { defaultExport: { get: async key => ({
    's3.bucket': 'public-assets', 's3.staticurl': 'https://assets.example.test',
})[key] || '' } });
mock.module('./objectStorage.js', { namedExports: {
    async putObject(input) {
        state.s3Writes++;
        state.objectWrites.push(input);
        if (state.storageError) throw state.storageError;
    },
    async getObject(input) {
        state.objectReads.push(input);
        if (state.storageError) throw state.storageError;
        return state.objectResult;
    },
} });
mock.module('sharp', { defaultExport: () => { state.imageReads++; throw new Error('Unexpected image processing'); } });
mock.module('fluent-ffmpeg', { defaultExport: () => { throw new Error('Unexpected audio processing'); } });
mock.module('file-type', { namedExports: { fileTypeFromBuffer: async () => { state.fileReads++; return { mime: 'audio/wav', ext: 'wav' }; } } });
const { scopeSatisfies } = await import('./auth/scopes.js');
mock.module('./auth/authorization.js', { namedExports: { authorize: async context => {
    state.authorizations.push(context);
    return { allowed: context.tokenType === 'session' || scopeSatisfies(context.tokenScopes, context.requiredScope),
        status: 403, code: 'TOKEN_CEILING', message: 'denied' };
} } });
mock.module('./moderation/visibility.js', { namedExports: {
    assertCanWrite: async (actorId, category, action) => {
        state.guards.push({ actorId, category, action });
        if (state.readonly) throw Object.assign(new Error('readonly'), { status: 403, code: 'ACCOUNT_READ_ONLY' });
    },
    canViewContent: async () => state.visible,
    sanitizeProfile: async () => state.profileVisible ? { id: 3 } : null,
    sanitizeProfiles: async users => users.map(user => state.profileVisible ? user : null),
    visibleWhere: async () => ({ uploader_id: { notIn: [8] } }),
} });
mock.module('./prisma.js', { namedExports: { prisma: { ow_assets: {
    findUnique: async () => { state.assetReads++; return state.asset; },
    create: async ({ data }) => { state.created.push(data); return data; },
    findMany: async query => { state.listQueries.push(query); return [{ id: 7, uploader: { id: 3 } }]; },
    count: async query => { state.countQueries.push(query); return 1; },
    groupBy: async query => { state.groupQueries.push(query); return state.groups; },
} } } });
const { uploadFile, processSimpleImageUpload, createAssetRecord, getAssetsList, getAssetStats,
    uploadToS3, downloadFromS3 } = await import('./assets.js');
const file = { buffer: Buffer.from('sample'), originalname: 'sample.wav', detectedMimeType: 'audio/wav', detectedExtension: 'wav' };
const res = (scopes = ['asset:create']) => ({ locals: { userid: 3, tokenType: 'oauth', scopes } });
beforeEach(() => Object.assign(state, { readonly: false, visible: true, profileVisible: true,
    imageReads: 0, fileReads: 0, s3Writes: 0, assetReads: 0, created: [], guards: [], authorizations: [],
    listQueries: [], countQueries: [], groupQueries: [], groups: [], asset: { id: 7, uploader_id: 3, md5: 'test' },
    objectWrites: [], objectReads: [], storageError: null,
    objectResult: { buffer: Buffer.from('asset'), contentType: 'image/png', contentLength: 5 } }));

test('shared storage keeps public asset ACL, static URL and download metadata', async () => {
    const buffer = Buffer.from('asset');
    assert.equal(await uploadToS3(buffer, 'assets/file.png', 'image/png'), 'https://assets.example.test/assets/file.png');
    assert.deepEqual(state.objectWrites, [{ bucket: 'public-assets', key: 'assets/file.png', body: buffer,
        contentType: 'image/png', acl: 'public-read' }]);
    assert.equal(await downloadFromS3('assets/file.png'), state.objectResult);
    assert.deepEqual(state.objectReads, [{ bucket: 'public-assets', key: 'assets/file.png' }]);
});

test('asset storage failures remain visible to callers', async () => {
    state.storageError = Object.assign(new Error('AccessDenied'), { status: 403 });
    await assert.rejects(uploadToS3(Buffer.from('asset'), 'key', 'image/png'), error => error === state.storageError);
    await assert.rejects(downloadFromS3('key'), error => error === state.storageError);
});

test('readonly uploads fail before deduplication, file processing, or external writes', async () => {
    state.readonly = true;
    await assert.rejects(uploadFile(file, { purpose: 'scratch' }, res()), { code: 'ACCOUNT_READ_ONLY' });
    await assert.rejects(processSimpleImageUpload(file, {}, res()), { code: 'ACCOUNT_READ_ONLY' });
    assert.equal(state.assetReads + state.imageReads + state.fileReads + state.s3Writes + state.created.length, 0);
    assert.deepEqual(state.guards[0], { actorId: 3, category: 'assets', action: 'create' });
});

test('upload token ceilings apply even when an identical asset already exists', async () => {
    await assert.rejects(uploadFile(file, { purpose: 'scratch' }, res(['asset:read'])), { code: 'TOKEN_CEILING' });
    assert.equal(state.assetReads + state.s3Writes + state.created.length, 0);
});

test('a hidden duplicate cannot be reused or disclose its asset record', async () => {
    state.visible = false;
    await assert.rejects(uploadFile(file, { purpose: 'scratch' }, res()), { code: 'RESOURCE_NOT_FOUND' });
    assert.equal(state.assetReads, 1);
    assert.equal(state.s3Writes + state.created.length, 0);
});

test('valid upload deduplication remains available after caller policy checks', async () => {
    const result = await uploadFile(file, { purpose: 'scratch' }, res());
    assert.equal(result.isExisting, true);
    assert.equal(result.asset.id, 7);
    assert.equal(state.s3Writes + state.created.length, 0);
});

test('direct asset records recheck readonly before database creation', async () => {
    state.readonly = true;
    await assert.rejects(createAssetRecord({ uploaderId: 3 }), { code: 'ACCOUNT_READ_ONLY' });
    assert.deepEqual(state.created, []);
});

test('asset totals reuse visible category aggregates including null category and empty sums', async () => {
    state.groups = [
        { category: 'image', _count: { id: 3 }, _sum: { file_size: 40 } },
        { category: null, _count: { id: 2 }, _sum: { file_size: null } },
    ];
    const result = await getAssetStats(9);
    assert.equal(result.totalAssets, 5);
    assert.equal(result.totalSize, 40);
    assert.deepEqual(state.groupQueries[0].where, { uploader_id: { notIn: [8] } });
    assert.equal(state.countQueries.length, 0);
    state.groups = [];
    assert.deepEqual(await getAssetStats(9), { totalAssets: 0, totalSize: 0, byCategory: [] });
});

test('asset pagination filters before count and redacts a hidden uploader profile', async () => {
    state.profileVisible = false;
    const result = await getAssetsList({ viewerId: 9, page: 2, limit: 5 });
    assert.deepEqual(state.listQueries[0].where, state.countQueries[0].where);
    assert.deepEqual(state.listQueries[0].where.AND, [{ uploader_id: { notIn: [8] } }]);
    assert.equal(state.listQueries[0].skip, 5);
    assert.equal(result.assets[0].uploader, null);
});
