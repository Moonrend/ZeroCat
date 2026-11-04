import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
mock.module('./prisma.js', { namedExports: { prisma: {} } });
mock.module('./objectStorage.js', { namedExports: {
    headObject: async () => assert.fail('inject a store'),
    putObject: async () => assert.fail('inject a store'),
    getObject: async () => assert.fail('inject a store'),
    getProjectStorageLocation: async () => assert.fail('inject a store'),
} });
const { saveProjectFile, readProjectFile, readProjectFiles, hydrateProjectFile,
    hydrateProjectFiles, migrateLegacyProjectFile } = await import('./projectFileStorage.js');
const hash = text => createHash('sha256').update(text).digest('hex');

function fixture(source = '正文 🐈\r\n') {
    const sha256 = hash(source);
    const record = { sha256, content_sha256: sha256, source: null, create_userid: 8, create_time: new Date('2026-01-01'),
        storage_provider: 's3', storage_bucket: 'private-files', storage_key: 'stored-key',
        content_size: BigInt(Buffer.byteLength(source)), content_type: 'text/plain; charset=utf-8' };
    const calls = [];
    const objects = {
        async getProjectStorageLocation() { calls.push(['location']); return { bucket: 'private-files' }; },
        async headObject(args) { calls.push(['head', args]); return { contentLength: Buffer.byteLength(source), metadata: { sha256 } }; },
        async putObject(args) { calls.push(['put', args]); },
        async getObject(args) { calls.push(['get', args]); return { buffer: Buffer.from(source) }; },
    };
    const db = {
        ow_projects_file: {
            async findUnique(args) { calls.push(['find', args]); return null; },
            async findMany(args) { calls.push(['findMany', args]); return [record]; },
        },
        async $queryRaw(strings, ...values) { calls.push(['publish', strings.join('?'), values]); return [record]; },
        async $executeRaw(strings, ...values) { calls.push(['migrate', strings.join('?'), values]); return 1; },
    };
    return { source, record, calls, db, objects };
}

test('new writes upload exact bytes privately before publishing a pointer and search index', async () => {
    const f = fixture();
    const result = await saveProjectFile(f.source, { userId: 9, ...f });
    assert.equal(result.sha256, hash(f.source));
    assert.deepEqual(f.calls.map(call => call[0]), ['find', 'location', 'put', 'publish']);
    const upload = f.calls[2][1];
    assert.equal(upload.bucket, 'private-files');
    assert.match(upload.key, /^project-files\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    assert.deepEqual(upload.body, Buffer.from(f.source));
    assert.equal(upload.acl, undefined);
    assert.equal(upload.checksumSHA256, Buffer.from(hash(f.source), 'hex').toString('base64'));
    assert.match(f.calls[3][1], /VALUES \(\?, NULL/);
    assert.match(f.calls[3][1], /to_tsvector/);
    assert.doesNotMatch(f.calls[3][1].split('DO UPDATE')[1], /create_userid\s*=/);
});

test('upload failure never publishes a pointer or falls back to a DB body', async () => {
    const f = fixture();
    f.objects.putObject = async () => { throw new Error('S3 unavailable'); };
    await assert.rejects(saveProjectFile(f.source, f), /S3 unavailable/);
    assert.ok(!f.calls.some(call => call[0] === 'publish'));
});

test('DB failure after upload propagates without deleting a potentially shared object', async () => {
    const f = fixture();
    f.db.$queryRaw = async () => { throw new Error('DB unavailable'); };
    await assert.rejects(saveProjectFile(f.source, f), /DB unavailable/);
    assert.equal(f.calls.filter(call => call[0] === 'put').length, 1);
});

test('a repeated stored hash preserves original metadata and avoids uploading again', async () => {
    const f = fixture();
    f.db.ow_projects_file.findUnique = async () => f.record;
    const result = await saveProjectFile(f.source, { ...f, userId: 99 });
    assert.equal(result.create_userid, 8);
    assert.deepEqual(f.calls, [['head', { bucket: 'private-files', key: 'stored-key' }]]);
});

test('re-saving a missing or mismatched object repairs it before returning success', async () => {
    for (const absent of [true, false]) {
        const f = fixture();
        f.db.ow_projects_file.findUnique = async () => f.record;
        f.objects.headObject = async () => {
            if (absent) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
            return { contentLength: 0, metadata: {} };
        };
        await saveProjectFile(f.source, f);
        assert.deepEqual(f.calls.map(call => call[0]), ['location', 'put', 'publish']);
    }
});

test('re-saving never treats access denial or a network failure as a missing object', async () => {
    for (const error of [Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }),
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) {
        const f = fixture();
        f.db.ow_projects_file.findUnique = async () => f.record;
        f.objects.headObject = async () => { throw error; };
        await assert.rejects(saveProjectFile(f.source, f), value => value === error);
        assert.deepEqual(f.calls, []);
    }
});

test('a supplied mismatched hash fails before DB or S3 access', async () => {
    const f = fixture();
    await assert.rejects(saveProjectFile(f.source, { ...f, sha256: hash('other') }), /SHA-256/);
    assert.deepEqual(f.calls, []);
});

test('legacy database content, including an empty file, needs no S3 configuration', async () => {
    const f = fixture('');
    const legacy = { sha256: hash(''), source: '', create_userid: 3, create_time: null };
    f.db.ow_projects_file.findUnique = async () => legacy;
    assert.deepEqual(await readProjectFile(legacy.sha256, f), legacy);
    assert.deepEqual(f.calls, []);
    assert.equal(await hydrateProjectFile(null, f), null);
});

test('S3 reads validate content and expose the legacy API shape without private pointers', async () => {
    const f = fixture();
    f.db.ow_projects_file.findUnique = async () => f.record;
    const result = await readProjectFile(f.record.sha256, f);
    assert.deepEqual(result, { sha256: f.record.sha256, source: f.source,
        create_userid: 8, create_time: f.record.create_time });
    assert.deepEqual(f.calls[0], ['get', { bucket: 'private-files', key: 'stored-key' }]);
});

test('object corruption, missing metadata and access errors fail closed without stale DB fallback', async () => {
    const f = fixture();
    f.objects.getObject = async () => ({ buffer: Buffer.from('corrupt') });
    await assert.rejects(hydrateProjectFile({ ...f.record, source: 'old fallback' }, f), /integrity/);
    await assert.rejects(hydrateProjectFile({ ...f.record, storage_key: null }, f), /metadata/);
    await assert.rejects(hydrateProjectFile({ ...f.record, storage_provider: 'other' }, f), /metadata/);
    f.objects.getObject = async () => { throw new Error('AccessDenied'); };
    await assert.rejects(hydrateProjectFile(f.record, f), /AccessDenied/);
});

test('hydration deduplicates object reads within a call, retains positions and reloads next call', async () => {
    const f = fixture();
    const result = await hydrateProjectFiles([f.record, null, { ...f.record, extra: 'kept' }], f);
    assert.equal(result[0].source, f.source);
    assert.equal(result[1], null);
    assert.equal(result[2].extra, 'kept');
    assert.equal(f.calls.length, 1);
    await hydrateProjectFiles([f.record], f);
    assert.equal(f.calls.length, 2);
});

test('batch reads deduplicate hashes, bound DB batches and cap object concurrency', async () => {
    const f = fixture();
    const sources = Array.from({ length: 503 }, (_, index) => `body-${index}`);
    const byHash = new Map(sources.map(source => [hash(source), source]));
    const sizes = [];
    f.db.ow_projects_file.findMany = async ({ where }) => {
        sizes.push(where.sha256.in.length);
        return where.sha256.in.map(sha256 => ({ ...f.record, sha256, content_sha256: sha256,
            storage_key: sha256, content_size: BigInt(Buffer.byteLength(byHash.get(sha256))) }));
    };
    let active = 0, maximum = 0;
    f.objects.getObject = async ({ key }) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { buffer: Buffer.from(byHash.get(key)) };
    };
    const result = await readProjectFiles([...byHash.keys(), ...byHash.keys()], f);
    assert.equal(result.size, 503);
    assert.deepEqual(sizes, [500, 3]);
    assert.ok(maximum <= 4);
    assert.equal(result.get(hash(sources[0])).source, sources[0]);
});

test('migration dry run verifies source identity but does no I/O', async () => {
    const f = fixture('');
    const result = await migrateLegacyProjectFile({ sha256: hash(''), source: '' }, { ...f, dryRun: true });
    assert.equal(result.status, 'dry-run');
    assert.deepEqual(f.calls, []);
    await assert.rejects(migrateLegacyProjectFile({ sha256: hash('other'), source: '' }, { ...f, dryRun: true }), /SHA-256/);
});

test('migration clears inline data only after a verified read and a conditional update', async () => {
    const f = fixture();
    const row = { sha256: hash(f.source), source: f.source };
    assert.equal((await migrateLegacyProjectFile(row, f)).status, 'migrated');
    assert.deepEqual(f.calls.map(call => call[0]), ['location', 'put', 'get', 'migrate']);
    assert.match(f.calls[3][1], /WHERE sha256 = \? AND source = \?/);
    assert.match(f.calls[3][1], /storage_key IS NOT DISTINCT FROM/);
    f.db.$executeRaw = async () => 0;
    assert.equal((await migrateLegacyProjectFile(row, f)).status, 'skipped');
});

test('historical binary-hash/base64 records retain their IDs and verify the stored text separately', async () => {
    const binary = Buffer.from([0x1f, 0x8b, 0, 255, 14, 0]);
    const source = binary.toString('base64');
    const legacyId = hash(binary);
    const f = fixture(source);
    assert.notEqual(legacyId, f.record.content_sha256);
    const result = await migrateLegacyProjectFile({ sha256: legacyId, source }, f);
    assert.equal(result.sha256, legacyId);
    assert.equal(result.status, 'migrated');
    const values = f.calls.find(call => call[0] === 'migrate')[2];
    assert.ok(values.includes(legacyId));
    assert.ok(values.includes(hash(source)));
    const hydrated = await hydrateProjectFile({ ...f.record, sha256: legacyId }, f);
    assert.deepEqual(Buffer.from(hydrated.source, 'base64'), binary);
});

test('failed migration verification leaves inline data untouched', async () => {
    const f = fixture();
    f.objects.getObject = async () => ({ buffer: Buffer.from('wrong') });
    await assert.rejects(migrateLegacyProjectFile({ sha256: hash(f.source), source: f.source }, f), /verification/);
    assert.ok(!f.calls.some(call => call[0] === 'migrate'));
});

test('missing legacy bodies are skipped and search indexing respects code-point limits', async () => {
    const f = fixture('🐈'.repeat(200005));
    assert.equal((await migrateLegacyProjectFile({ sha256: 'missing', source: null }, f)).status, 'skipped');
    await saveProjectFile(f.source, f);
    const values = f.calls.find(call => call[0] === 'publish')[2];
    assert.equal([...values.at(-1)].length, 200000);
    assert.equal([...values.at(-2)].length, 240);
});
