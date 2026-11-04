import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import zcconfig from './config/zcconfig.js';

let clientPromise = null;

function getClient() {
    if (!clientPromise) {
        const initialization = (async () => {
            const [endpoint, region, forcePathStyle, accessKeyId, secretAccessKey] = await Promise.all([
                zcconfig.get('s3.endpoint'), zcconfig.get('s3.region'), zcconfig.get('s3.forcePathStyle'),
                zcconfig.get('s3.AWS_ACCESS_KEY_ID'), zcconfig.get('s3.AWS_SECRET_ACCESS_KEY'),
            ]);
            return new S3Client({ endpoint, region, forcePathStyle,
                credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3 });
        })();
        clientPromise = initialization;
        initialization.catch(() => {
            if (clientPromise === initialization) clientPromise = null;
        });
    }
    return clientPromise;
}

/** The private project bucket must never fall back to the public asset bucket. */
export async function getProjectStorageLocation() {
    const [configuredBucket, publicBucket] = await Promise.all([
        zcconfig.get('storage.projects.bucket'), zcconfig.get('s3.bucket'),
    ]);
    const bucket = typeof configuredBucket === 'string' ? configuredBucket.trim() : '';
    if (!bucket) throw new Error('Private project storage bucket is not configured');
    if (bucket === String(publicBucket ?? '').trim()) {
        throw new Error('Project storage must use a separate private bucket');
    }
    return { bucket };
}

export async function putObject({ bucket, key, body, contentType, checksumSHA256, acl, cacheControl, metadata }) {
    const client = await getClient();
    const input = { Bucket: bucket, Key: key, Body: body };
    if (contentType !== undefined) input.ContentType = contentType;
    if (checksumSHA256 !== undefined) input.ChecksumSHA256 = checksumSHA256;
    if (acl !== undefined) input.ACL = acl;
    if (cacheControl !== undefined) input.CacheControl = cacheControl;
    if (metadata !== undefined) input.Metadata = metadata;
    return client.send(new PutObjectCommand(input));
}

export async function headObject({ bucket, key }) {
    const client = await getClient();
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentLength: response.ContentLength ?? null, metadata: response.Metadata ?? {},
        checksumSHA256: response.ChecksumSHA256 ?? null };
}

async function bodyToBuffer(body) {
    if (body == null) throw new Error('S3 returned an object without a body');
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
    if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
    if (typeof body[Symbol.asyncIterator] !== 'function' && typeof body[Symbol.iterator] !== 'function') {
        throw new TypeError('Unsupported S3 object body');
    }
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function retryableStreamError(error) {
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
        'EPIPE', 'ERR_TLS_SOCKET_DISCONNECTED', 'ETLS', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code)
        || /socket hang up|Client network socket disconnected before secure TLS connection was established/.test(error?.message || '');
}

export async function getObject({ bucket, key }) {
    const client = await getClient();
    for (let attempt = 0; attempt < 3; attempt++) {
        // SDK retries request failures. A failed response stream needs a fresh GET.
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        try {
            const buffer = await bodyToBuffer(response.Body);
            return { buffer, contentType: response.ContentType ?? null,
                contentLength: response.ContentLength ?? buffer.length };
        } catch (error) {
            response.Body?.destroy?.();
            if (attempt === 2 || !retryableStreamError(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt)));
        }
    }
}
