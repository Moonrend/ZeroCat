import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const state = {};
let version = 0;
mock.module('./config/zcconfig.js', { defaultExport: { async get(key) {
    state.configReads.push(key);
    if (state.configError) throw state.configError;
    return state.config[key];
} } });
mock.module('@aws-sdk/client-s3', { namedExports: {
    S3Client: class {
        constructor(options) {
            state.clients.push(options);
            if (state.constructorError) throw state.constructorError;
        }
        async send(command) { state.commands.push(command); return state.send(command); }
    },
    PutObjectCommand: class { constructor(input) { this.input = input; this.kind = 'put'; } },
    GetObjectCommand: class { constructor(input) { this.input = input; this.kind = 'get'; } },
    HeadObjectCommand: class { constructor(input) { this.input = input; this.kind = 'head'; } },
} });
const freshStorage = () => import(`./objectStorage.js?test=${++version}`);
beforeEach(() => Object.assign(state, { configReads: [], clients: [], commands: [], configError: null,
    constructorError: null, send: async () => ({ Body: Buffer.from('source'), ContentType: 'text/plain', ContentLength: 6 }),
    config: { 's3.endpoint': 'https://storage.example.test', 's3.region': 'test-region', 's3.forcePathStyle': true,
        's3.AWS_ACCESS_KEY_ID': 'test-id', 's3.AWS_SECRET_ACCESS_KEY': 'test-secret',
        'storage.projects.bucket': 'private-projects', 's3.bucket': 'public-assets' } }));

test('import is lazy and concurrent operations initialize one configured SDK client', async () => {
    const storage = await freshStorage();
    assert.deepEqual(state.configReads, []);
    assert.deepEqual(state.clients, []);
    await Promise.all(Array.from({ length: 20 }, (_, index) => storage.putObject({
        bucket: 'private-projects', key: String(index), body: Buffer.from('source'),
    })));
    assert.equal(state.clients.length, 1);
    assert.equal(state.configReads.length, 5);
    assert.equal(state.commands.length, 20);
    assert.deepEqual(state.clients[0], { endpoint: 'https://storage.example.test', region: 'test-region', forcePathStyle: true,
        credentials: { accessKeyId: 'test-id', secretAccessKey: 'test-secret' }, maxAttempts: 3 });
});

test('failed config initialization and failed SDK construction can both retry', async () => {
    const storage = await freshStorage();
    const input = { bucket: 'private-projects', key: 'source', body: Buffer.from('source') };
    const configError = new Error('config unavailable');
    state.configError = configError;
    await assert.rejects(storage.putObject(input), error => error === configError);
    assert.equal(state.clients.length, 0);
    state.configError = null;
    const constructorError = new Error('invalid client config');
    state.constructorError = constructorError;
    await assert.rejects(storage.putObject(input), error => error === constructorError);
    state.constructorError = null;
    await storage.putObject(input);
    assert.equal(state.clients.length, 2);
    assert.equal(state.commands.length, 1);
});

test('ACL is absent for private content and only added for explicitly public uploads', async () => {
    const storage = await freshStorage();
    const body = Buffer.from('source');
    await storage.putObject({ bucket: 'private-projects', key: 'source', body, contentType: 'text/plain',
        checksumSHA256: 'checksum', metadata: { sha256: 'hash' }, cacheControl: 'private, no-store' });
    assert.deepEqual(state.commands[0].input, { Bucket: 'private-projects', Key: 'source', Body: body,
        ContentType: 'text/plain', ChecksumSHA256: 'checksum', Metadata: { sha256: 'hash' }, CacheControl: 'private, no-store' });
    await storage.putObject({ bucket: 'public-assets', key: 'asset', body, acl: 'public-read' });
    assert.equal(state.commands[1].input.ACL, 'public-read');
});

test('private bucket is mandatory, distinct, trimmed, and read afresh without initializing SDK', async () => {
    const storage = await freshStorage();
    for (const invalid of ['', ' ', null, undefined, 'public-assets', ' public-assets ']) {
        state.config['storage.projects.bucket'] = invalid;
        await assert.rejects(storage.getProjectStorageLocation());
    }
    state.config['storage.projects.bucket'] = ' private-projects ';
    assert.deepEqual(await storage.getProjectStorageLocation(), { bucket: 'private-projects' });
    state.config['storage.projects.bucket'] = 'next-private-projects';
    assert.deepEqual(await storage.getProjectStorageLocation(), { bucket: 'next-private-projects' });
    assert.equal(state.clients.length, 0);
});

test('SDK errors retain their identity and access denied is never treated as a missing object', async () => {
    const storage = await freshStorage();
    const error = Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
    state.send = async () => { throw error; };
    await assert.rejects(storage.getObject({ bucket: 'private-projects', key: 'source' }), failure => failure === error);
    await assert.rejects(storage.putObject({ bucket: 'private-projects', key: 'source', body: Buffer.alloc(0) }), failure => failure === error);
    assert.equal(state.commands.length, 2);
});

test('HEAD shares the lazy client and returns metadata without requesting checksum mode', async () => {
    const storage = await freshStorage();
    state.send = async () => ({ ContentLength: 0, Metadata: { sha256: 'content-hash' }, ChecksumSHA256: 'checksum' });
    assert.deepEqual(await storage.headObject({ bucket: 'historical-private-bucket', key: 'empty' }),
        { contentLength: 0, metadata: { sha256: 'content-hash' }, checksumSHA256: 'checksum' });
    assert.equal(state.commands[0].kind, 'head');
    assert.deepEqual(state.commands[0].input, { Bucket: 'historical-private-bucket', Key: 'empty' });
    state.send = async () => ({});
    assert.deepEqual(await storage.headObject({ bucket: 'private-projects', key: 'source' }),
        { contentLength: null, metadata: {}, checksumSHA256: null });
    await storage.putObject({ bucket: 'private-projects', key: 'source', body: Buffer.alloc(0) });
    assert.equal(state.clients.length, 1);
});

test('HEAD preserves missing, forbidden and network errors for the storage service to classify', async () => {
    const storage = await freshStorage();
    for (const error of [Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } }),
        Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }),
        Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })]) {
        state.send = async () => { throw error; };
        await assert.rejects(storage.headObject({ bucket: 'private-projects', key: 'source' }), failure => failure === error);
    }
    assert.equal(state.commands.length, 3);
});

test('downloads support SDK, web and Node bodies, including legitimate zero bytes', async () => {
    const storage = await freshStorage();
    for (const body of [Buffer.from('source'), new Uint8Array(Buffer.from('source')),
        { transformToByteArray: async () => new Uint8Array(Buffer.from('source')) },
        { arrayBuffer: async () => new TextEncoder().encode('source').buffer },
        Readable.from([Buffer.from('sou'), Buffer.from('rce')])]) {
        state.send = async () => ({ Body: body });
        assert.deepEqual(await storage.getObject({ bucket: 'historical-private-bucket', key: 'source' }),
            { buffer: Buffer.from('source'), contentType: null, contentLength: 6 });
    }
    state.send = async () => ({ Body: Buffer.alloc(0), ContentLength: 0, ContentType: 'text/plain' });
    assert.deepEqual(await storage.getObject({ bucket: 'private-projects', key: 'empty' }),
        { buffer: Buffer.alloc(0), contentType: 'text/plain', contentLength: 0 });
    assert.equal(state.commands[0].input.Bucket, 'historical-private-bucket');
});

test('missing and unsupported object bodies fail instead of returning empty content', async () => {
    const storage = await freshStorage();
    for (const body of [undefined, null, {}]) {
        state.send = async () => ({ Body: body });
        await assert.rejects(storage.getObject({ bucket: 'private-projects', key: 'source' }), /body/);
    }
    assert.equal(state.commands.length, 3);
});

test('a connection failure while streaming restarts GET without retaining partial bytes', async () => {
    const storage = await freshStorage();
    let reads = 0;
    state.send = async () => {
        reads++;
        if (reads > 1) return { Body: Buffer.from('complete') };
        return { Body: Readable.from((async function* () {
            yield Buffer.from('partial');
            throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        })()) };
    };
    const result = await storage.getObject({ bucket: 'private-projects', key: 'source' });
    assert.equal(result.buffer.toString(), 'complete');
    assert.equal(reads, 2);
});

test('stream retry budget is bounded and preserves the final failure', async () => {
    const storage = await freshStorage();
    const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    state.send = async () => ({ Body: Readable.from((async function* () { throw error; })()) });
    await assert.rejects(storage.getObject({ bucket: 'private-projects', key: 'source' }), failure => failure === error);
    assert.equal(state.commands.length, 3);
});
