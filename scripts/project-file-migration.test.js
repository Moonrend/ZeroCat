import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateProjectFiles, parseMigrationOptions, runMigrationCli } from './migrate-project-files-to-s3.js';

const sha = number => String(number).padStart(64, '0');
const records = count => Array.from({ length: count }, (_, index) => ({
    sha256: sha(index + 1), source: index === 0 ? '' : `source-${index + 1}`,
    create_userid: 3, create_time: new Date('2026-01-01T00:00:00Z'),
    storage_provider: null, storage_bucket: null, storage_key: null,
    content_size: null, content_type: null, search_preview: null,
}));
function fixture(rows) {
    const calls = [];
    let disconnected = 0;
    const db = {
        ow_projects_file: { async findMany(args) {
            calls.push(structuredClone(args));
            return rows.filter(row => row.source !== null && (!args.where.sha256 || row.sha256 > args.where.sha256.gt))
                .sort((left, right) => left.sha256.localeCompare(right.sha256))
                .slice(0, args.take).map(row => structuredClone(row));
        } },
        async $disconnect() { disconnected++; },
    };
    return { db, calls, get disconnected() { return disconnected; } };
}
const quiet = { log() {}, error() {} };

test('CLI defaults to dry-run and accepts bounded apply, limit, and resume options', () => {
    assert.deepEqual(parseMigrationOptions([]), { dryRun: true, batchSize: 50, concurrency: 4, limit: null, after: null });
    assert.equal(parseMigrationOptions(['--dry-run']).dryRun, true);
    assert.deepEqual(parseMigrationOptions(['--apply', '--batch-size', '3', '--concurrency', '2', '--limit', '7', '--after', sha(4)]),
        { dryRun: false, batchSize: 3, concurrency: 2, limit: 7, after: sha(4) });
});

for (const args of [
    ['--apply', '--dry-run'], ['--dry-run', '--apply'], ['--unknown'],
    ['--limit'], ['--limit', '--apply'], ['--limit', '0'], ['--limit', 'NaN'],
    ['--batch-size', '-1'], ['--batch-size', '1001'], ['--concurrency', '1.5'], ['--concurrency', '33'],
    ['--after', 'invalid'], ['--after', 'A'.repeat(64)],
]) {
    test(`invalid options fail before connecting: ${args.join(' ')}`, async () => {
        assert.throws(() => parseMigrationOptions(args));
        let loaded = false;
        assert.equal(await runMigrationCli(args, { load: async () => { loaded = true; }, log: quiet }), 1);
        assert.equal(loaded, false);
    });
}

test('help does not import database or storage dependencies', async () => {
    let loaded = false;
    const output = [];
    assert.equal(await runMigrationCli(['--help'], {
        load: async () => { loaded = true; }, log: { ...quiet, log: message => output.push(message) },
    }), 0);
    assert.equal(loaded, false);
    assert.match(output[0], /--apply/);
});

test('dry-run includes empty source, excludes null, and forwards the same database without writes', async () => {
    const rows = records(4);
    rows[2].source = null;
    const original = structuredClone(rows);
    const { db, calls } = fixture(rows);
    const seen = [];
    const select = { sha256: true, source: true, storage_provider: true, storage_key: true, content_sha256: true };
    const summary = await migrateProjectFiles({ db, select, options: { batchSize: 2 }, migrate: async (row, options) => {
        assert.equal(options.db, db);
        assert.equal(options.dryRun, true);
        seen.push(row);
        return { status: 'dry-run', sha256: row.sha256 };
    } });
    assert.deepEqual(rows, original);
    assert.deepEqual(seen.map(row => row.sha256), [sha(1), sha(2), sha(4)]);
    assert.equal(seen[0].source, '');
    assert.deepEqual(summary, { dryRun: true, scanned: 3, migrated: 0, skipped: 0, planned: 3, failed: 0, lastScanned: sha(4), resumeAfter: sha(4) });
    assert.deepEqual(calls[0].where, { source: { not: null } });
    assert.deepEqual(calls[1].where, { source: { not: null }, sha256: { gt: sha(2) } });
    assert.deepEqual(calls[0].select, select);
});

test('apply pagination remains complete as migrated rows disappear from the filter', async () => {
    const rows = records(7);
    const { db, calls } = fixture(rows);
    const seen = [];
    const summary = await migrateProjectFiles({ db, options: { dryRun: false, batchSize: 2, limit: 5 }, migrate: async (row, options) => {
        assert.equal(options.dryRun, false);
        seen.push(row.sha256);
        rows.find(item => item.sha256 === row.sha256).source = null;
        return { status: 'migrated', sha256: row.sha256 };
    } });
    assert.deepEqual(seen, [1, 2, 3, 4, 5].map(sha));
    assert.deepEqual(calls.map(call => call.take), [2, 2, 1]);
    assert.equal(calls.every(call => !('skip' in call) && !('cursor' in call)), true);
    assert.equal(summary.migrated, 5);
    assert.equal(summary.resumeAfter, sha(5));
    assert.equal(rows[5].source, 'source-6');
});

test('concurrency is bounded independently of page size', async () => {
    const { db } = fixture(records(9));
    let active = 0;
    let peak = 0;
    const summary = await migrateProjectFiles({ db, options: { batchSize: 9, concurrency: 3 }, migrate: async row => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return { status: 'dry-run', sha256: row.sha256 };
    } });
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(summary.scanned, 9);
});

test('failures retain a safe resume point and a rerun retries failed rows', async () => {
    const rows = records(7);
    const { db } = fixture(rows);
    const failures = [];
    const progress = [];
    let shouldFail = true;
    const migrate = async row => {
        if (shouldFail && [sha(3), sha(5)].includes(row.sha256)) throw new Error('storage unavailable');
        rows.find(item => item.sha256 === row.sha256).source = null;
        return { status: 'migrated', sha256: row.sha256 };
    };
    const first = await migrateProjectFiles({ db, migrate, options: { dryRun: false, batchSize: 4 },
        onError: failure => failures.push(failure.sha256), onProgress: value => progress.push(value) });
    assert.equal(first.scanned, 7);
    assert.equal(first.failed, 2);
    assert.equal(first.migrated, 5);
    assert.equal(first.lastScanned, sha(7));
    assert.equal(first.resumeAfter, sha(2));
    assert.deepEqual(failures.sort(), [sha(3), sha(5)]);
    assert.equal(progress.at(-1).resumeAfter, sha(2));
    assert.equal(rows[2].source, 'source-3');
    assert.equal(rows[4].source, 'source-5');
    shouldFail = false;
    const second = await migrateProjectFiles({ db, migrate, options: { dryRun: false, after: first.resumeAfter } });
    assert.equal(second.scanned, 2);
    assert.equal(second.failed, 0);
    assert.equal(second.migrated, 2);
    assert.ok(rows.every(row => row.source === null));
});

test('after and limit apply to scanned records including skipped rows', async () => {
    const { db, calls } = fixture(records(8));
    const summary = await migrateProjectFiles({ db, options: { after: sha(3), limit: 2, batchSize: 5 },
        migrate: async row => ({ status: 'skipped', sha256: row.sha256 }) });
    assert.deepEqual(calls[0].where, { source: { not: null }, sha256: { gt: sha(3) } });
    assert.equal(calls[0].take, 2);
    assert.equal(calls.length, 1);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.lastScanned, sha(5));
    assert.equal(summary.resumeAfter, sha(3));
});

test('invalid service results count as failures and do not advance the resume point', async () => {
    const { db } = fixture(records(1));
    const summary = await migrateProjectFiles({ db, migrate: async () => ({ status: 'unknown', sha256: sha(1) }) });
    assert.equal(summary.failed, 1);
    assert.equal(summary.resumeAfter, null);
});

test('an empty database never calls the storage service', async () => {
    const { db } = fixture([]);
    const summary = await migrateProjectFiles({ db, migrate: async () => assert.fail('empty migration') });
    assert.equal(summary.scanned, 0);
    assert.equal(summary.resumeAfter, null);
});

test('CLI returns nonzero for item failures and closes the shared database', async () => {
    const current = fixture(records(2));
    const errors = [];
    const result = await runMigrationCli(['--apply'], {
        load: async () => ({ db: current.db, migrate: async () => { throw new Error('checksum mismatch'); } }),
        log: { ...quiet, error: message => errors.push(message) },
    });
    assert.equal(result, 1);
    assert.equal(current.disconnected, 1);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /checksum mismatch/);
});

test('CLI returns nonzero on database errors and zero on a successful dry-run', async () => {
    const broken = fixture([]);
    broken.db.ow_projects_file.findMany = async () => { throw new Error('database unavailable'); };
    assert.equal(await runMigrationCli([], { load: async () => ({ db: broken.db, migrate: async () => {} }), log: quiet }), 1);
    assert.equal(broken.disconnected, 1);
    const working = fixture(records(1));
    assert.equal(await runMigrationCli([], { load: async () => ({ db: working.db,
        migrate: async (row, options) => {
            assert.equal(options.dryRun, true);
            return { status: 'dry-run', sha256: row.sha256 };
        },
    }), log: quiet }), 0);
    assert.equal(working.disconnected, 1);
});
