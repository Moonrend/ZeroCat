import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { createHash } from 'node:crypto';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const logger = { error() {}, warn() {}, info() {}, debug() {} };
const prisma = {
    async $queryRaw(parts, ...values) {
        state.contentQueries.push({ sql: parts.join('?'), values });
        return state.contentRows;
    },
    ow_projects_lists: {
        async findUnique() { return state.list; },
        async findFirst(query) {
            state.listQueries.push(query);
            return query.where.authorid !== undefined && query.where.authorid !== state.list?.authorid ? null : state.list;
        },
        async update(query) { state.writes.push(query); return { ...state.list, ...query.data }; },
        async delete(query) { state.writes.push(query); return state.list; },
    },
    ow_projects_list_items: {
        async findMany() { return []; }, async deleteMany(query) { state.writes.push(query); return { count: 1 }; },
    },
    ow_projects: {
        async findFirst(query) {
            state.projectQueries.push(query);
            return query.where.authorid !== undefined && query.where.authorid !== state.project?.authorid ? null : state.project;
        },
        async findMany(query) { state.projectQueries.push(query); return []; },
        async update(query) { state.writes.push(query); return state.project; },
    },
    ow_projects_tags: { async findMany() { return []; } },
    ow_projects_branch: { async findFirst() { return null; } },
    ow_target_configs: { async findUnique() { return null; } },
    ow_comment_spaces: { async findUnique() { return state.space; } },
    ow_comment_service: {
        async findUnique() { return state.comment; }, async findFirst() { return state.comment; },
        async findMany(query) { state.commentQueries.push(query); return []; }, async count() { return 0; },
        async groupBy() { return []; },
        async update(query) { state.writes.push(query); return { ...state.comment, ...query.data }; },
        async deleteMany(query) { state.writes.push(query); return { count: 1 }; },
    },
};
mock.module(url('../prisma.js'), { namedExports: { prisma } });
mock.module(url('../logger.js'), { defaultExport: logger });
mock.module(url('../redis.js'), { defaultExport: {} });
mock.module(url('../config/zcconfig.js'), { defaultExport: { async get() { return ''; } } });
mock.module(url('./authorization.js'), { namedExports: {
    async authorize(context) {
        state.authorizations.push(context);
        if (state.denied) return { allowed: false, status: 403, code: 'ZC_ERROR_DELEGATION_INACTIVE', message: 'revoked' };
        return { allowed: true, actorId: context.actorId, principalId: context.delegationId === undefined ? context.actorId : 9,
            delegationId: context.delegationId ?? null, resourceGrant: state.resourceGrant };
    },
} });
mock.module(url('../moderation/visibility.js'), { namedExports: {
    async visibleWhere(kind, actorId, options) { state.visibility.push({ kind, actorId, options }); return { actor_visible: actorId }; },
    async visibleSql() { return { text: 'TRUE', values: [] }; },
    async canViewContent(kind, row, actorId, options) { state.visibility.push({ kind, actorId, options }); return !state.hidden; },
    async sanitizePublicUser(user) { return user; },
    async sanitizeProfiles(users) { return users; },
    async assertCanWrite(userId, category, action) {
        state.guards.push({ userId, category, action });
        if (state.readonly === `${userId}:${category}`) throw Object.assign(new Error('readonly'), { statusCode: 403, code: 'ACCOUNT_READ_ONLY' });
    },
} });
mock.module(url('../cachekv.js'), { namedExports: {
    async get(userId, key) { state.storage.push({ op: 'get', userId, key }); return { value: { content: 'draft', baseCommitId: 'base' } }; },
    async set(userId, key, value) { state.storage.push({ op: 'set', userId, key }); return { value, updated_at: 'now' }; },
    async remove(userId, key) { state.storage.push({ op: 'remove', userId, key }); return true; },
} });
mock.module(url('../projectFileStorage.js'), { namedExports: {
    async hydrateProjectFile(row) {
        state.hydratedFiles.push(row);
        return { ...row, source: row.storage_provider ? 'hydrated source' : row.source };
    },
    async saveProjectFile(source) { return { sha256: createHash('sha256').update(source).digest('hex') }; },
} });
mock.module(url('../commitService.js'), { namedExports: {
    async getLatestCommit() { return null; },
    async writeSourceFile(content, actorId) { state.commitActors.push(actorId); return 'sha'; },
    async createCommit(input) { state.commitActors.push(input.userid); return { id: 'commit' }; },
} });
mock.module(url('../../controllers/events.js'), { namedExports: { async createEvent(...args) { state.events.push(args); } } });
mock.module(url('../queue/queueManager.js'), { defaultExport: {
    async enqueueGitSyncCommit(...args) { state.jobs.push(args); }, async enqueueBlogSyncArticle(...args) { state.jobs.push(args); },
} });
mock.module(url('../../controllers/projects.js'), { namedExports: {
    projectSelectionFields() { return {}; }, async sanitizeProjectAuthors(posts) { return posts; },
} });
mock.module(url('../commentService/walineFormatter.js'), { namedExports: {
    async formatComment(row) { return row; }, async formatCommentsWithChildren() { return []; },
} });
mock.module(url('../commentService/spaceManager.js'), { namedExports: { async getSpaceUser() { return null; } } });
mock.module(url('../commentService/sanitizer.js'), { namedExports: { sanitizeComment(value) { return value; } } });
mock.module(url('../commentService/akismetService.js'), { namedExports: { async checkAkismetSpam() { return false; } } });
mock.module(url('../commentService/levelService.js'), { namedExports: { async batchGetUserLevels() { return new Map(); } } });
mock.module(url('../commentService/markdown.js'), { namedExports: { renderMarkdown(value) { return value; } } });

const lists = await import('../../controllers/lists.js');
const drafts = await import('../blog/draftService.js');
const comments = await import('../commentService/commentManager.js');
const blog = await import('../../controllers/blog/postsController.js');
const { authorizeResourceOperation, resourceAuthorizationContext } = await import('./resourceOperation.js');
const context = { tokenType: 'personal', tokenScopes: ['blog:7:update'], delegationId: '23' };

beforeEach(() => Object.assign(state, {
    list: { id: 4, authorid: 9, state: 'private', title: 'old', description: '' },
    project: { id: 7, authorid: 9, type: 'article', state: 'private', name: 'article', title: 'title', default_branch: 'main' },
    space: { id: 3, cuid: 'space-cuid', owner_id: 9, status: 'active' },
    comment: { id: 11, space_id: 3, account_user_id: 9, status: 'waiting', comment: 'text' },
    authorizations: [], listQueries: [], projectQueries: [], commentQueries: [], writes: [], guards: [], visibility: [],
    storage: [], commitActors: [], events: [], jobs: [], contentQueries: [], contentRows: [], hydratedFiles: [],
    hidden: false, denied: false, readonly: null, resourceGrant: false,
}));

function expectAuthorization(scope) {
    assert.ok(state.authorizations.length);
    for (const auth of state.authorizations) {
        assert.equal(auth.actorId, 5);
        assert.equal(auth.requiredScope, scope);
        assert.equal(auth.delegationId, '23');
        assert.equal(auth.allowDelegation, true);
        assert.equal(auth.tokenType, 'personal');
        assert.deepEqual(auth.tokenScopes, context.tokenScopes);
    }
}

test('request context keeps the supplied delegation and token ceiling, never a cached principal', () => {
    assert.deepEqual(resourceAuthorizationContext({ headers: { 'x-zerocat-delegation': '23' } },
        { locals: { userid: 5, tokenType: 'personal', scopes: ['blog:7:update'], authorization: { principalId: 999 } } }), context);
});

test('resource operation refreshes authority and exposes revocation before doing work', async () => {
    await authorizeResourceOperation(5, 'blog', 7, 'update', context);
    state.denied = true;
    await assert.rejects(authorizeResourceOperation(5, 'blog', 7, 'update', context), { statusCode: 403, code: 'ZC_ERROR_DELEGATION_INACTIVE' });
    expectAuthorization('blog:7:update');
});

test('delegated private list read uses grantor ownership, not grantor project visibility', async () => {
    const result = await lists.getProjectList(4, 5, context);
    assert.equal(result.id, 4);
    expectAuthorization('list:4:read');
    assert.ok(state.visibility.every(query => query.actorId === 5));
    assert.equal(state.projectQueries[0].where.OR.some(clause => clause.authorid === 9), false);
});

test('list mutations refresh exact action and enforce grantor ownership with actual actor moderation', async () => {
    await lists.updateList(5, 4, { title: 'new' }, context);
    expectAuthorization('list:4:update');
    assert.equal(state.listQueries[0].where.authorid, 9);
    assert.ok(state.visibility.every(query => query.actorId === 5));
    state.authorizations = [];
    await lists.deleteList(5, 4, context);
    expectAuthorization('list:4:delete');
});

test('revoked or hidden list cannot be read or changed through delegation', async () => {
    state.denied = true;
    await assert.rejects(lists.updateList(5, 4, {}, context), { code: 'ZC_ERROR_DELEGATION_INACTIVE' });
    assert.equal(state.writes.length, 0);
    state.denied = false; state.hidden = true;
    assert.equal(await lists.getProjectList(4, 5, context), null);
});

for (const action of ['read', 'update', 'delete']) {
    test(`draft ${action} accesses only the authorized article grantor storage`, async () => {
        if (action === 'read') await drafts.getDraft(5, 7, { authorizationContext: context });
        if (action === 'update') await drafts.saveDraft(5, 7, { content: 'changed' }, { authorizationContext: context });
        if (action === 'delete') await drafts.discardDraft(5, 7, { authorizationContext: context });
        expectAuthorization(`blog:7:${action}`);
        assert.ok(state.storage.length);
        assert.ok(state.storage.every(entry => entry.userId === 9 && entry.key === 'blog.draft.7'));
        assert.ok(state.visibility.every(query => query.actorId === 5 && query.options.ignorePrivacy));
    });
}

test('draft save rejects changed grantor ownership before cache access', async () => {
    state.project.authorid = 8;
    await assert.rejects(drafts.saveDraft(5, 7, {}, { authorizationContext: context }), { statusCode: 403 });
    assert.equal(state.storage.length, 0);
});

for (const readonly of ['5:blog', '5:projects', '9:blog', '9:projects']) {
    test(`draft update retains live readonly guard ${readonly}`, async () => {
        state.readonly = readonly;
        await assert.rejects(drafts.saveDraft(5, 7, {}, { authorizationContext: context }), { code: 'ACCOUNT_READ_ONLY' });
        assert.equal(state.storage.length, 0);
    });
}

test('draft publish commits and emits events as actual actor while using owner draft', async () => {
    await drafts.publishDraft(5, 7, { authorizationContext: context });
    expectAuthorization('blog:7:update');
    assert.deepEqual(state.commitActors, [5, 5]);
    assert.equal(state.events[0][1], 5);
    assert.equal(state.events[0][4].actor_id, 5);
    assert.ok(state.storage.every(entry => entry.userId === 9));
    assert.ok(state.jobs.every(args => args.at(-1).actorId === 5));
});

test('delegated blog detail validates read and keeps actual-viewer hidden filtering', async () => {
    state.contentRows = [{ commit_file: 'file', sha256: 'file', source: null, create_time: 'created', create_userid: 9,
        storage_provider: 's3', storage_bucket: 'private', storage_key: 'object', content_size: 15n, content_sha256: 'checksum' }];
    const req = { params: { id: '7' }, headers: { 'x-zerocat-delegation': '23' } };
    let status = 200, result;
    const res = { locals: { userid: 5, tokenType: 'personal', scopes: context.tokenScopes },
        status(value) { status = value; return this; }, json(value) { result = value; } };
    await blog.getPostDetail(req, res);
    expectAuthorization('blog:7:read');
    assert.equal(status, 200);
    assert.equal(result.data.id, 7);
    assert.ok(state.visibility.every(query => query.actorId === 5));
    assert.equal(state.contentQueries.length, 1);
    assert.match(state.contentQueries[0].sql, /JOIN ow_projects_commits/);
    assert.deepEqual(state.contentQueries[0].values, [7, 'main']);
    assert.equal(state.hydratedFiles.length, 1);
    assert.deepEqual(result.data.file, { sha256: 'file', source: 'hydrated source', create_time: 'created', create_userid: 9 });
    state.hidden = true;
    await blog.getPostDetail(req, res);
    assert.equal(status, 404);
    assert.equal(state.contentQueries.length, 1);
    assert.equal(state.hydratedFiles.length, 1);
});

test('blog metadata and unpublish refresh original credentials, keep article type and actor visibility', async () => {
    const req = { params: { id: '7' }, headers: { 'x-zerocat-delegation': '23' }, body: { title: 'updated' } };
    const res = { locals: { userid: 5, tokenType: 'personal', scopes: context.tokenScopes }, json() {}, status() { return this; } };
    await blog.updatePostMeta(req, res);
    await blog.unpublishPost(req, res);
    expectAuthorization('blog:7:update');
    assert.ok(state.projectQueries.every(query => query.where.authorid === 9 && query.where.type === 'article'));
    assert.ok(state.visibility.every(query => query.actorId === 5));
});

test('numeric comment delegation can edit content but cannot set moderation status or sticky', async () => {
    await comments.updateComment(3, 11, { comment: 'changed', status: 'approved', sticky: true }, 5, true, { authorizationContext: context });
    expectAuthorization('comment:11:update');
    assert.deepEqual(state.writes[0].data, { comment: 'changed' });
    assert.ok(state.visibility.every(query => query.actorId === 5));
});

test('like-only comment operation uses interact scope and live readonly action', async () => {
    await comments.updateComment(3, 11, { like: true }, 5, false, { authorizationContext: context });
    expectAuthorization('comment:11:interact');
    assert.equal(state.guards[0].action, 'interact');
    assert.deepEqual(state.writes[0].data, { like: { increment: 1 } });
});

test('numeric comment delegation cannot authorize an imported display user ID', async () => {
    state.comment.account_user_id = null; state.comment.user_id = '9';
    assert.equal(await comments.updateComment(3, 11, { comment: 'changed' }, 5, false, { authorizationContext: context }), null);
    assert.equal(state.writes.length, 0);
});

test('numeric comment deletion is limited to that resource, not unrelated reply owners', async () => {
    assert.equal(await comments.deleteComment(3, 11, 5, false, { authorizationContext: context }), true);
    expectAuthorization('comment:11:delete');
    assert.deepEqual(state.writes[0].where.OR, [{ id: 11 }]);
    assert.deepEqual(state.writes[0].where.AND, [{ actor_visible: 5 }]);
});

test('space delegation moderates only the actual selected space and still filters actor visibility', async () => {
    await comments.updateComment(3, 11, { status: 'approved' }, 5, true, { spaceCuid: 'space-cuid', authorizationContext: context });
    expectAuthorization('comment:space-cuid:update');
    assert.deepEqual(state.writes[0].data, { status: 'approved' });
    state.space.id = 99;
    await assert.rejects(comments.deleteComment(3, 11, 5, true, { spaceCuid: 'space-cuid', authorizationContext: context }), { statusCode: 404 });
    assert.equal(state.writes.length, 1);
});

test('comment operations reject a space disabled after the request authorization', async () => {
    state.space.status = 'banned';
    await assert.rejects(comments.updateComment(3, 11, { comment: 'changed' }, 5, false, { authorizationContext: context }), { statusCode: 404 });
    assert.equal(await comments.getComment(11, 5, { authorizationContext: context }), null);
    assert.equal(state.writes.length, 0);
});

const directContext = { tokenType: 'personal', tokenScopes: ['list:4:manage', 'blog:7:manage', 'comment:11:manage'] };

test('direct concrete list authorization supports nonowner read update delete without inventing a principal', async () => {
    const list = await lists.getProjectList(4, 5, directContext);
    assert.equal(list.id, 4);
    await lists.updateList(5, 4, { title: 'direct edit' }, directContext);
    await lists.deleteList(5, 4, directContext);
    assert.ok(state.listQueries.every(query => query.where.authorid === undefined));
    assert.ok(state.authorizations.every(auth => auth.actorId === 5 && auth.delegationId === undefined));
    assert.ok(state.visibility.every(query => query.actorId === 5));
});

test('internal list calls without original authorization context remain owner only', async () => {
    assert.equal(await lists.getProjectList(4, 5), null);
    await assert.rejects(lists.updateList(5, 4, { title: 'no context' }), { statusCode: 404 });
    await assert.rejects(lists.deleteList(5, 4), { statusCode: 404 });
    assert.equal(state.writes.length, 0);
    assert.equal(state.authorizations.length, 0);
});

test('delegation still requires canonical list owner to match the grantor', async () => {
    state.list.authorid = 8;
    assert.equal(await lists.getProjectList(4, 5, context), null);
    await assert.rejects(lists.updateList(5, 4, {}, context), { statusCode: 404 });
    assert.equal(state.writes.length, 0);
});

for (const action of ['read', 'update', 'delete']) {
    test(`direct article ${action} uses concrete grant with actual actor and canonical owner storage`, async () => {
        if (action === 'read') await drafts.getDraft(5, 7, { authorizationContext: directContext });
        if (action === 'update') await drafts.saveDraft(5, 7, { content: 'direct' }, { authorizationContext: directContext });
        if (action === 'delete') await drafts.discardDraft(5, 7, { authorizationContext: directContext });
        assert.ok(state.storage.length);
        assert.ok(state.storage.every(entry => entry.userId === 9));
        assert.ok(state.visibility.every(query => query.actorId === 5));
        assert.ok(state.authorizations.every(auth => auth.requiredScope === `blog:7:${action}` && auth.delegationId === undefined));
    });
}

test('internal draft calls without token context cannot access another article owner storage', async () => {
    await assert.rejects(drafts.getDraft(5, 7), { statusCode: 403 });
    await assert.rejects(drafts.saveDraft(5, 7, {}), { statusCode: 403 });
    await assert.rejects(drafts.discardDraft(5, 7), { statusCode: 403 });
    assert.equal(state.storage.length, 0);
});

test('direct article metadata unpublish and private detail honor resource authorization for nonowner', async () => {
    const req = { params: { id: '7' }, headers: {}, body: { title: 'direct' } };
    let status = 200;
    const res = { locals: { userid: 5, tokenType: 'personal', scopes: directContext.tokenScopes },
        json() {}, status(value) { status = value; return this; } };
    await blog.updatePostMeta(req, res);
    await blog.unpublishPost(req, res);
    await blog.getPostDetail(req, res);
    assert.equal(status, 200);
    assert.ok(state.projectQueries.every(query => query.where.authorid === undefined));
    assert.equal(state.writes.length, 2);
    assert.ok(state.visibility.every(query => query.actorId === 5));
});

test('direct numeric comment grant can read waiting content edit and delete without taking grantor identity', async () => {
    state.resourceGrant = true;
    assert.equal((await comments.getComment(11, 5, { authorizationContext: directContext })).id, 11);
    await comments.updateComment(3, 11, { comment: 'direct', status: 'approved' }, 5, false, { authorizationContext: directContext });
    assert.deepEqual(state.writes[0].data, { comment: 'direct' });
    assert.equal(await comments.deleteComment(3, 11, 5, false, { authorizationContext: directContext }), true);
    assert.deepEqual(state.writes[1].where.OR, [{ id: 11 }]);
    assert.ok(state.authorizations.every(auth => auth.actorId === 5 && auth.delegationId === undefined));
});

test('ordinary comment read capability does not expose a waiting comment without concrete grant', async () => {
    assert.equal(await comments.getComment(11, 5, { authorizationContext: directContext }), null);
    state.resourceGrant = true;
    assert.equal((await comments.getComment(11, 5, { authorizationContext: directContext })).id, 11);
});

test('direct space concrete grant permits scoped management without owner impersonation', async () => {
    state.resourceGrant = true;
    const options = { spaceCuid: 'space-cuid', authorizationContext: directContext };
    await comments.getCommentList(3, { userId: 5 }, {}, options);
    await comments.updateComment(3, 11, { status: 'approved' }, 5, true, options);
    assert.deepEqual(state.writes[0].data, { status: 'approved' });
    assert.equal(await comments.deleteComment(3, 11, 5, true, options), true);
    assert.ok(state.visibility.every(query => query.actorId === 5));
    state.resourceGrant = false;
    await assert.rejects(comments.getCommentList(3, { userId: 5 }, {}, options), { statusCode: 404 });
});

test('internal comment calls without token context still require authenticated author ownership', async () => {
    assert.equal(await comments.getComment(11, 5), null);
    assert.equal(await comments.updateComment(3, 11, { comment: 'no context' }, 5), null);
    assert.equal(await comments.deleteComment(3, 11, 5), false);
    assert.equal(state.writes.length, 0);
});

test('comment listing and read retain actual-viewer moderation and reject fresh delegation revocation', async () => {
    await comments.getCommentList(3, { userId: 5 }, {}, { spaceCuid: 'space-cuid', authorizationContext: context });
    expectAuthorization('comment:space-cuid:read');
    assert.ok(state.visibility.every(query => query.actorId === 5));
    state.denied = true;
    await assert.rejects(comments.getComment(11, 5, { authorizationContext: context }), { code: 'ZC_ERROR_DELEGATION_INACTIVE' });
    state.denied = false; state.hidden = true;
    assert.equal(await comments.getComment(11, 5, { authorizationContext: context }), null);
});
