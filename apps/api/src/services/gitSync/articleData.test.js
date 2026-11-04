import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const state = {};
mock.module(new URL('../prisma.js', import.meta.url).href, { namedExports: { prisma: {
    async $queryRaw(strings, ids) {
        state.commits.push({ sql: strings.join('?'), ids });
        if (state.fail) throw new Error('database unavailable');
        return state.commitRows.filter(commit => ids.includes(commit.project_id));
    },
    ow_projects_tags: { async findMany(query) { state.tags.push(query); return state.tagRows; } },
} } });
mock.module(new URL('../projectFileStorage.js', import.meta.url).href, { namedExports: {
    async readProjectFiles(hashes) {
        state.files.push(hashes);
        if (state.fileFail) throw new Error('object storage unavailable');
        return new Map(state.fileRows.map(file => [file.sha256, file]));
    },
} });
const { loadArticleData } = await import('./articleData.js');
beforeEach(() => Object.assign(state, { commits: [], files: [], tags: [], commitRows: [], fileRows: [], tagRows: [], fail: false, fileFail: false }));

test('article metadata batches commits and unified file reads, mapping shared files and project tags', async () => {
    state.commitRows = [{ id: 'latest-1', project_id: 1, commit_file: 'shared', commit_date: new Date() },
        { id: 'latest-2', project_id: 2, commit_file: 'shared', commit_date: new Date() },
        { id: 'latest-3', project_id: 3, commit_file: 'missing', commit_date: new Date() }];
    state.fileRows = [{ sha256: 'shared', source: 'article body' }];
    state.tagRows = [{ projectid: 2, name: 'two' }, { projectid: 1, name: 'one' }, { projectid: 1, name: 'another' }];
    const result = await loadArticleData([3, 2, 1, 4, 2]);
    assert.equal(state.commits.length, 1);
    assert.deepEqual(state.commits[0].ids, [3, 2, 1, 4]);
    assert.match(state.commits[0].sql, /CROSS JOIN LATERAL/);
    assert.match(state.commits[0].sql, /ORDER BY commit_date DESC\s+LIMIT 1/);
    assert.equal(state.files.length, 1);
    assert.equal(state.tags.length, 1);
    assert.deepEqual(state.files[0], ['shared', 'missing']);
    assert.deepEqual(state.tags[0].where.projectid.in, [1, 2, 3]);
    assert.equal(result.get(1).source, 'article body');
    assert.equal(result.get(2).source, 'article body');
    assert.equal(result.get(3).source, '');
    assert.deepEqual(result.get(1).tags, [{ name: 'one' }, { name: 'another' }]);
    assert.deepEqual(result.get(2).tags, [{ name: 'two' }]);
    assert.deepEqual(result.get(3).tags, []);
    assert.equal(result.has(4), false);
});

test('empty collections skip all reads and missing commits skip dependent reads', async () => {
    assert.equal((await loadArticleData([])).size, 0);
    assert.equal(state.commits.length, 0);
    assert.equal((await loadArticleData([1])).size, 0);
    assert.equal(state.commits.length, 1);
    assert.equal(state.files.length, 0);
    assert.equal(state.tags.length, 0);
});

test('large article collections bound SQL parameters and propagate read failures', async () => {
    await loadArticleData(Array.from({ length: 501 }, (_, i) => i + 1));
    assert.deepEqual(state.commits.map(call => call.ids.length), [500, 1]);
    state.fail = true;
    await assert.rejects(loadArticleData([1]), /database unavailable/);
    assert.equal(state.files.length, 0);
});

test('article object-storage read failures propagate instead of publishing empty bodies', async () => {
    state.commitRows = [{ id: 'latest', project_id: 1, commit_file: 'stored-hash', commit_date: new Date() }];
    state.fileFail = true;
    await assert.rejects(loadArticleData([1]), /object storage unavailable/);
    assert.deepEqual(state.files, [['stored-hash']]);
});
