import { createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import * as objectStorage from './objectStorage.js';

const CONTENT_TYPE = 'text/plain; charset=utf-8';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const READ_BATCH_SIZE = 500;
const OBJECT_CONCURRENCY = 4;

export const PROJECT_FILE_SELECT = {
    sha256: true, source: true, create_time: true, create_userid: true,
    storage_provider: true, storage_bucket: true, storage_key: true,
    content_size: true, content_sha256: true, content_type: true, search_preview: true,
};

const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const objectKey = hash => `project-files/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;

function contentBytes(source, expectedHash) {
    if (typeof source !== 'string') throw new TypeError('Project file source must be a string');
    const buffer = Buffer.from(source, 'utf8');
    const hash = digest(buffer);
    if (expectedHash !== undefined && expectedHash !== hash) {
        throw new Error('Project file SHA-256 does not match its content');
    }
    return { buffer, hash };
}

// PostgreSQL left() counts Unicode code points, not UTF-16 code units.
function prefix(source, limit) {
    let result = '';
    let count = 0;
    for (const character of source) {
        if (count++ === limit) break;
        result += character;
    }
    return result;
}

function legacyShape(row) {
    if (!row) return null;
    return { sha256: row.sha256, source: row.source, create_time: row.create_time, create_userid: row.create_userid };
}

async function mapConcurrent(rows, operation) {
    const result = new Array(rows.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(OBJECT_CONCURRENCY, rows.length) }, async () => {
        while (cursor < rows.length) {
            const index = cursor++;
            result[index] = await operation(rows[index]);
        }
    }));
    return result;
}

async function upload(buffer, hash, objects) {
    const { bucket } = await objects.getProjectStorageLocation();
    const key = objectKey(hash);
    await objects.putObject({ bucket, key, body: buffer, contentType: CONTENT_TYPE,
        checksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
        metadata: { sha256: hash }, cacheControl: 'private, no-store' });
    return { bucket, key };
}

/** Storage is deliberately authorization-agnostic: callers must authorize before reading content. */
export async function hydrateProjectFile(row, { objects = objectStorage } = {}) {
    if (!row) return null;
    if (!row.storage_provider) return { ...row };
    if (row.storage_provider !== 's3' || !row.storage_bucket || !row.storage_key
        || !HASH_PATTERN.test(row.sha256) || !HASH_PATTERN.test(row.content_sha256) || row.content_size == null) {
        throw new Error('Invalid project file storage metadata');
    }
    const { buffer } = await objects.getObject({ bucket: row.storage_bucket, key: row.storage_key });
    if (!Buffer.isBuffer(buffer) || BigInt(buffer.length) !== BigInt(row.content_size) || digest(buffer) !== row.content_sha256) {
        throw new Error('Project file object failed integrity verification');
    }
    return { ...row, source: buffer.toString('utf8') };
}

/** Reuses already-loaded rows; duplicate hashes share one object read within this call only. */
export async function hydrateProjectFiles(rows, options = {}) {
    const reads = new Map();
    return mapConcurrent(rows, async row => {
        if (!row) return null;
        if (!reads.has(row.sha256)) reads.set(row.sha256, hydrateProjectFile(row, options));
        const hydrated = await reads.get(row.sha256);
        return { ...row, source: hydrated.source };
    });
}

export async function readProjectFile(hash, { db = prisma, ...options } = {}) {
    if (!hash) return null;
    const row = await db.ow_projects_file.findUnique({ where: { sha256: hash }, select: PROJECT_FILE_SELECT });
    return legacyShape(await hydrateProjectFile(row, options));
}

export async function readProjectFiles(hashes, { db = prisma, ...options } = {}) {
    const unique = [...new Set(hashes.filter(Boolean))];
    const result = new Map();
    for (let offset = 0; offset < unique.length; offset += READ_BATCH_SIZE) {
        const rows = await db.ow_projects_file.findMany({
            where: { sha256: { in: unique.slice(offset, offset + READ_BATCH_SIZE) } }, select: PROJECT_FILE_SELECT,
        });
        for (const row of await hydrateProjectFiles(rows, options)) result.set(row.sha256, legacyShape(row));
    }
    return result;
}

/** Upload first, then atomically publish the pointer and search index. No DB-body write fallback. */
export async function saveProjectFile(source, { userId = null, sha256, db = prisma, objects = objectStorage } = {}) {
    const { buffer, hash } = contentBytes(source, sha256);
    const { source: _source, ...metadataSelect } = PROJECT_FILE_SELECT;
    const existing = await db.ow_projects_file.findUnique({ where: { sha256: hash }, select: metadataSelect });
    if (existing?.content_sha256 && existing.content_sha256 !== hash) throw new Error('Project file identity conflict');
    if (existing?.storage_provider === 's3' && existing.storage_bucket && existing.storage_key
        && existing.content_sha256 === hash && existing.content_size != null
        && BigInt(existing.content_size) === BigInt(buffer.length)) {
        try {
            const stored = await objects.headObject({ bucket: existing.storage_bucket, key: existing.storage_key });
            if (stored.contentLength === buffer.length && stored.metadata?.sha256 === hash) return existing;
        } catch (error) {
            // A missing object can be restored from this save; denied or unavailable storage cannot.
            if (error?.$metadata?.httpStatusCode !== 404 && !['NoSuchKey', 'NotFound'].includes(error?.name)) throw error;
        }
    }
    if (existing?.storage_provider && existing.storage_provider !== 's3') throw new Error('Unknown project file storage provider');
    const { bucket, key } = await upload(buffer, hash, objects);
    const searchText = prefix(source, 200000);
    const preview = prefix(source, 240);
    const [row] = await db.$queryRaw`
        INSERT INTO ow_projects_file
            (sha256, source, create_userid, storage_provider, storage_bucket, storage_key,
             content_size, content_sha256, content_type, search_preview, search_vector)
        VALUES (${hash}, NULL, ${userId}, 's3', ${bucket}, ${key}, ${BigInt(buffer.length)},
                ${hash}, ${CONTENT_TYPE}, ${preview}, to_tsvector('simple', ${searchText}))
        ON CONFLICT (sha256) DO UPDATE SET
            source = NULL, storage_provider = EXCLUDED.storage_provider,
            storage_bucket = EXCLUDED.storage_bucket, storage_key = EXCLUDED.storage_key,
            content_size = EXCLUDED.content_size, content_sha256 = EXCLUDED.content_sha256,
            content_type = EXCLUDED.content_type,
            search_preview = EXCLUDED.search_preview, search_vector = EXCLUDED.search_vector
        WHERE ow_projects_file.content_sha256 IS NULL OR ow_projects_file.content_sha256 = EXCLUDED.content_sha256
        RETURNING sha256, create_time, create_userid, storage_provider, storage_bucket,
                  storage_key, content_size, content_sha256, content_type, search_preview
    `;
    if (!row) throw new Error('Project file identity conflict');
    return row;
}

/** Verified, restartable migration. Compare-and-swap never clears a concurrently changed body. */
export async function migrateLegacyProjectFile(row, {
    db = prisma, objects = objectStorage, dryRun = false, expectedContentSha256,
} = {}) {
    if (!row || typeof row.source !== 'string') return { status: 'skipped', sha256: row?.sha256 };
    if (!HASH_PATTERN.test(row.sha256)) throw new Error('Invalid legacy project file SHA-256');
    if (row.storage_provider && row.storage_provider !== 's3') throw new Error('Unknown project file storage provider');
    const { buffer, hash } = contentBytes(row.source);
    // An audited manifest can pin existing bytes whose historical ID is not their hash.
    // It never permits a changed body, even if the new body happens to match its ID.
    if (expectedContentSha256 !== undefined && expectedContentSha256 !== hash) {
        throw new Error('Legacy project file content does not match its pinned SHA-256');
    }
    if (hash !== row.sha256 && expectedContentSha256 !== hash) {
        // Historical sitemap rows use the compressed binary hash but store base64 text.
        const decoded = Buffer.from(row.source, 'base64');
        if (decoded.toString('base64') !== row.source || digest(decoded) !== row.sha256) {
            throw new Error('Legacy project file SHA-256 does not match its content');
        }
    }
    if (dryRun) return { status: 'dry-run', sha256: row.sha256 };
    const { bucket, key } = await upload(buffer, hash, objects);
    const uploaded = await objects.getObject({ bucket, key });
    if (!Buffer.isBuffer(uploaded.buffer) || !uploaded.buffer.equals(buffer)) {
        throw new Error('Uploaded project file failed migration verification');
    }
    const searchText = prefix(row.source, 200000);
    const preview = prefix(row.source, 240);
    const updated = await db.$executeRaw`
        UPDATE ow_projects_file SET
            storage_provider = 's3', storage_bucket = ${bucket}, storage_key = ${key},
            content_size = ${BigInt(buffer.length)}, content_sha256 = ${hash}, content_type = ${CONTENT_TYPE},
            search_preview = ${preview}, search_vector = to_tsvector('simple', ${searchText}), source = NULL
        WHERE sha256 = ${row.sha256} AND source = ${row.source}
            AND storage_provider IS NOT DISTINCT FROM ${row.storage_provider ?? null}
            AND storage_key IS NOT DISTINCT FROM ${row.storage_key ?? null}
    `;
    return { status: updated === 1 ? 'migrated' : 'skipped', sha256: row.sha256 };
}
