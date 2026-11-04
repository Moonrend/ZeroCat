import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const defaultCalls = [];
mock.module('./prisma.js', { namedExports: { prisma: {
    async $queryRaw(strings, ...values) { defaultCalls.push({ strings, values }); return []; },
} } });
const { findProjectCommit, findReachableProjectCommit, listReachableCommitIds } = await import('./projectCommitAccess.js');

const commits = [
    { id: 'fork-tip', project_id: 99, branch: 'source-main', parent_commit_id: 'source-ancestor', commit_file: 'tip-file',
        author_id: 4, commit_message: 'tip', commit_date: new Date('2026-01-02'), commit_description: null, depth: 1 },
    { id: 'source-ancestor', project_id: 99, branch: 'source-main', parent_commit_id: null, commit_file: 'ancestor-file',
        author_id: 4, commit_message: 'root', commit_date: new Date('2026-01-01'), commit_description: 'original', depth: 0 },
    { id: 'unrelated', project_id: 99, parent_commit_id: null, commit_file: 'private-file' },
    { id: 'feature-tip', project_id: 7, parent_commit_id: 'source-ancestor', commit_file: 'feature-file' },
];
const branches = [
    { projectid: 7, name: 'main', latest_commit_hash: 'fork-tip' },
    { projectid: 7, name: 'feature', latest_commit_hash: 'feature-tip' },
    { projectid: 99, name: 'private', latest_commit_hash: 'unrelated' },
];

// Models result rows for the supplied graph; SQL shape and bound values are checked separately.
// These tests do not execute a PostgreSQL query planner.
function graphDb(rows = commits, branchRows = branches) {
    const calls = [];
    const byId = new Map(rows.map(row => [row.id, row]));
    function reachable(heads, limit = Infinity) {
        const queue = [...heads];
        const seen = new Set();
        const found = [];
        while (queue.length && found.length < limit) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id);
            const row = byId.get(id);
            if (!row) continue;
            found.push(row);
            if (row.parent_commit_id) queue.push(row.parent_commit_id);
        }
        return found;
    }
    return {
        calls,
        async $queryRaw(strings, ...values) {
            const sql = strings.join('?');
            calls.push({ sql, values });
            assert.match(sql, /WITH RECURSIVE reachable AS/);
            assert.match(sql, /SELECT c\.id, c\.parent_commit_id/);
            assert.match(sql, /SELECT parent\.id, parent\.parent_commit_id/);
            assert.match(sql, /JOIN reachable child ON parent\.id = child\.parent_commit_id/);
            assert.match(sql, /WHERE child\.parent_commit_id <> ''/);
            assert.equal((sql.match(/\bUNION\b/g) || []).length, 1);
            assert.doesNotMatch(sql, /\bUNION\s+ALL\b/);
            assert.doesNotMatch(sql, /(?:c|parent)\.project_id\s*=/);
            if (sql.includes('bounded AS MATERIALIZED')) {
                const [projectId, branch, branchAgain, limit, commitId, sha256] = values;
                assert.equal(branch, branchAgain);
                assert.equal(limit, 10000);
                assert.match(sql, /b\.latest_commit_hash <> ''/);
                assert.match(sql, /bounded AS MATERIALIZED\s*\(\s*SELECT id FROM reachable LIMIT \?\s*\)/);
                assert.match(sql, /FROM bounded\s+JOIN ow_projects_commits c ON c\.id = bounded\.id/);
                assert.match(sql, /WHERE c\.id = \?::text OR c\.commit_file = \?::text\s+LIMIT 1/);
                const heads = branchRows.filter(row => row.projectid === projectId && (branch === null || row.name === branch))
                    .map(row => row.latest_commit_hash).filter(Boolean);
                return reachable(heads, limit).filter(row => row.id === commitId || row.commit_file === sha256).slice(0, 1);
            }
            assert.match(sql, /WHERE c\.id = ANY\(\?::text\[\]\)/);
            assert.doesNotMatch(sql, /\bLIMIT\b/);
            return reachable(values[0]).map(row => ({ id: row.id }));
        },
    };
}
beforeEach(() => { defaultCalls.length = 0; });

test('legacy findProjectCommit delegates with the branch and returns the complete retained source row', async () => {
    const db = graphDb();
    assert.deepEqual(await findProjectCommit('7', 'source-ancestor', 'main', { db }), commits[1]);
    assert.equal(db.calls.length, 1);
    assert.deepEqual(db.calls[0].values, [7, 'main', 'main', 10000, 'source-ancestor', null]);
});

test('find by file hash only returns content reachable from the authorized project branches', async () => {
    const db = graphDb();
    assert.equal((await findReachableProjectCommit(7, { sha256: 'ancestor-file' }, { db })).id, 'source-ancestor');
    assert.equal(await findReachableProjectCommit(7, { sha256: 'private-file' }, { db }), null);
    assert.equal(await findProjectCommit(7, 'unrelated', null, { db }), null);
    assert.equal(db.calls.length, 3);
});

test('branch restriction applies to fork branch heads without excluding source-project ancestors', async () => {
    const db = graphDb();
    assert.equal(await findReachableProjectCommit(7, { commitId: 'feature-tip', branch: 'main' }, { db }), null);
    assert.equal((await findReachableProjectCommit(7, { commitId: 'feature-tip' }, { db })).id, 'feature-tip');
    assert.equal(await findReachableProjectCommit(7, { commitId: 'fork-tip', branch: 'missing' }, { db }), null);
    assert.equal(await findReachableProjectCommit(8, { commitId: 'fork-tip' }, { db }), null);
});

test('find retains the existing OR match when both commit ID and file hash are supplied', async () => {
    const db = graphDb();
    const result = await findReachableProjectCommit(7, { commitId: 'unrelated', sha256: 'tip-file' }, { db });
    assert.equal(result.id, 'fork-tip');
    assert.deepEqual(db.calls[0].values.slice(-2), ['unrelated', 'tip-file']);
});

test('empty find criteria and empty heads avoid unnecessary database queries', async () => {
    const db = graphDb();
    assert.equal(await findReachableProjectCommit(7, {}, { db }), null);
    assert.equal(await findReachableProjectCommit(7, { commitId: '', sha256: '' }, { db }), null);
    assert.deepEqual(await listReachableCommitIds([], { db }), []);
    assert.deepEqual(await listReachableCommitIds([null, undefined, ''], { db }), []);
    assert.equal(db.calls.length, 0);
});

test('branch, commit and file selectors remain bound values instead of SQL text', async () => {
    const db = graphDb();
    const branch = "main' OR TRUE; --";
    const commitId = "id'); SELECT pg_sleep(1); --";
    const sha256 = "hash' OR 1=1 --";
    assert.equal(await findReachableProjectCommit(7, { branch, commitId, sha256 }, { db }), null);
    const call = db.calls[0];
    assert.deepEqual(call.values, [7, branch, branch, 10000, commitId, sha256]);
    for (const value of [branch, commitId, sha256]) assert.equal(call.sql.includes(value), false);
});

test('list passes unique heads as one typed array parameter and returns shared ancestors once', async () => {
    const db = graphDb();
    const result = await listReachableCommitIds(['fork-tip', 'feature-tip', 'fork-tip', '', null], { db });
    assert.deepEqual(new Set(result), new Set(['fork-tip', 'feature-tip', 'source-ancestor']));
    assert.equal(result.length, 3);
    assert.equal(db.calls.length, 1);
    assert.deepEqual(db.calls[0].values, [['fork-tip', 'feature-tip']]);
    const maliciousHead = "id') OR TRUE --";
    assert.deepEqual(await listReachableCommitIds([maliciousHead], { db }), []);
    assert.equal(db.calls[1].sql.includes(maliciousHead), false);
    assert.deepEqual(db.calls[1].values, [[maliciousHead]]);
});

test('cycles terminate and unreachable targets remain denied', async () => {
    const cycle = [
        { id: 'a', project_id: 99, parent_commit_id: 'b', commit_file: 'a-file' },
        { id: 'b', project_id: 99, parent_commit_id: 'a', commit_file: 'b-file' },
    ];
    const db = graphDb(cycle, [{ projectid: 7, name: 'main', latest_commit_hash: 'a' }]);
    assert.equal(await findProjectCommit(7, 'absent', null, { db }), null);
    assert.equal((await findProjectCommit(7, 'b', null, { db })).id, 'b');
    assert.deepEqual(new Set(await listReachableCommitIds(['a', 'b'], { db })), new Set(['a', 'b']));
});

test('missing heads and parents stop traversal without fabricating commit IDs', async () => {
    const db = graphDb([{ id: 'tip', parent_commit_id: 'missing-parent', commit_file: 'file' }], [
        { projectid: 7, name: 'main', latest_commit_hash: 'tip' },
        { projectid: 7, name: 'broken', latest_commit_hash: 'missing-head' },
    ]);
    assert.equal(await findProjectCommit(7, 'missing-parent', null, { db }), null);
    assert.equal(await findProjectCommit(7, 'missing-head', null, { db }), null);
    assert.deepEqual(await listReachableCommitIds(['missing-head', 'tip'], { db }), ['tip']);
});

test('blank branch heads and parent IDs retain the original absent-link behavior', async () => {
    const db = graphDb([
        { id: 'tip', parent_commit_id: '', commit_file: 'visible' },
        { id: '', parent_commit_id: null, commit_file: 'invalid-blank-id' },
    ], [
        { projectid: 7, name: 'main', latest_commit_hash: 'tip' },
        { projectid: 7, name: 'empty', latest_commit_hash: '' },
    ]);
    assert.equal(await findReachableProjectCommit(7, { sha256: 'invalid-blank-id' }, { db }), null);
    assert.deepEqual(await listReachableCommitIds(['tip'], { db }), ['tip']);
});

test('find bounds the reachable set before matching while list returns histories beyond 10000 nodes', async () => {
    const history = Array.from({ length: 10002 }, (_, index) => ({
        id: `commit-${index}`, parent_commit_id: index < 10001 ? `commit-${index + 1}` : null,
        commit_file: `file-${index}`, project_id: 99,
    }));
    const db = graphDb(history, [{ projectid: 7, name: 'main', latest_commit_hash: 'commit-0' }]);
    assert.equal((await findProjectCommit(7, 'commit-9999', null, { db })).id, 'commit-9999');
    assert.equal(await findProjectCommit(7, 'commit-10000', null, { db }), null);
    assert.equal(await findReachableProjectCommit(7, { sha256: 'file-10000' }, { db }), null);
    const all = await listReachableCommitIds(['commit-0'], { db });
    assert.equal(all.length, 10002);
    assert.ok(all.includes('commit-10001'));
    assert.equal(db.calls.length, 4);
});

test('database failures propagate instead of being reported as inaccessible content', async () => {
    const failure = new Error('database unavailable');
    const db = { async $queryRaw() { throw failure; } };
    await assert.rejects(findReachableProjectCommit(7, { commitId: 'fork-tip' }, { db }), error => error === failure);
    await assert.rejects(listReachableCommitIds(['fork-tip'], { db }), error => error === failure);
});

test('all entry points use the shared Prisma instance when no database is supplied', async () => {
    assert.equal(await findProjectCommit(7, 'missing'), null);
    assert.equal(await findReachableProjectCommit(7, { sha256: 'missing' }), null);
    assert.deepEqual(await listReachableCommitIds(['missing']), []);
    assert.equal(defaultCalls.length, 3);
});
