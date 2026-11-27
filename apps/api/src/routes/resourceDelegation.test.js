import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const next = (req, res, done) => done();
const names = values => Object.fromEntries(values.map(name => [name, async (...args) => {
    state.calls.push({ name, args });
    if (name === 'getSpaceByGuid') return { id: 3, owner_id: 9, status: 'active', cuid: 'space-cuid' };
    if (name === 'getComment') return { id: 11, comment: 'text', status: 'waiting', insertedAt: 'now' };
    if (name === 'updateComment') return { id: 11 };
    if (name === 'createComment') return { id: 11, status: 'approved' };
    if (name === 'verifyCaptcha') return { pass: true };
    if (name === 'checkIpRate') return true;
    if (name === 'checkDuplicate' || name === 'isSensitiveBanned') return false;
    if (name === 'checkSensitiveWords') return { hit: false };
    return { id: name === 'getProjectList' ? 4 : 7 };
}]));
mock.module(url('../middleware/auth.js'), { namedExports: { parseToken: next, needLogin: next, needAdmin: next } });
mock.module(url('../middleware/sudo.js'), { namedExports: { requireSudo: next } });
mock.module(url('../services/logger.js'), { defaultExport: { error() {}, warn() {} } });
mock.module(url('../services/auth/authorization.js'), { namedExports: { async authorize(context) {
    state.auth.push(context);
    const delegated = context.delegationId !== undefined;
    if (state.denied || (delegated && !context.allowDelegation)) return { allowed: false, status: 403, code: 'ZC_ERROR_DELEGATION_NOT_SUPPORTED', message: 'denied' };
    return { allowed: true, actorId: Number(context.actorId ?? context.userId), principalId: delegated ? 9 : 5 };
} } });
mock.module(url('../services/prisma.js'), { namedExports: { prisma: {
    ow_comment_service: { async findUnique() { return { id: 11, space_id: 3 }; } },
} } });
mock.module(url('../controllers/lists.js'), { namedExports: names(['addProjectToList', 'createList', 'deleteList', 'getProjectList',
    'getUserListInfo', 'getUserListInfoAndCheak', 'getUserListInfoPublic', 'removeProjectFromList', 'updateList']) });
mock.module(url('../services/blog/draftService.js'), { namedExports: names(['listDrafts', 'getDraft', 'saveDraft', 'discardDraft', 'publishDraft']) });
mock.module(url('../controllers/blog/postsController.js'), { namedExports: names(['getPosts', 'getPostsByAuthor', 'getPostDetail', 'createPost', 'updatePostMeta', 'unpublishPost', 'getRelatedPosts']) });
mock.module(url('../controllers/blog/tagsController.js'), { namedExports: names(['getTags']) });
mock.module(url('../services/config/zcconfig.js'), { defaultExport: {} });
mock.module(url('../services/queue/queueManager.js'), { defaultExport: { enqueueCommentNotification() {} } });
mock.module(url('../services/commentService/walineAuth.js'), { namedExports: {
    createWalineToken() {},
    isWalineScopeGranted(scopes, required) {
        return Array.isArray(scopes) && (scopes.includes(required) || scopes.includes('comment:manage'));
    },
    async revokeWalineToken() {},
} });
mock.module(url('../services/commentService/spaceManager.js'), { namedExports: names(['createSpace', 'getSpaceByGuid', 'listSpaces',
    'updateSpace', 'deleteSpace', 'getSpaceConfig', 'updateSpaceConfig', 'getOrCreateSpaceUser', 'listSpaceUsers', 'updateSpaceUser',
    'getSpaceStats', 'adminListSpaces', 'adminGetSpace', 'adminUpdateSpaceStatus', 'getSpaceUser']) });
mock.module(url('../services/commentService/commentManager.js'), { namedExports: names(['getCommentList', 'getComment', 'searchMyComments', 'updateComment', 'deleteComment',
    'checkIpRate', 'checkDuplicate', 'createComment', 'getComments', 'getCommentCount', 'getRecentComments']) });
mock.module(url('../services/commentService/walineFormatter.js'), { namedExports: { toWalineType() {}, formatComment() {} } });
mock.module(url('../services/commentService/markdown.js'), { namedExports: { renderMarkdown(value) { return value; } } });
mock.module(url('../services/moderation/visibility.js'), { namedExports: { async visibleWhere() { return {}; }, async assertCanWrite() {} } });
mock.module(url('../services/commentService/dataService.js'), { namedExports: names(['createTask', 'getTask', 'listTasks', 'getExportData']) });
mock.module(url('../middleware/walineSpaceResolver.js'), { namedExports: { walineSpaceResolver: next, isSpaceAdmin() { return false; } } });
mock.module(url('../services/commentService/counterManager.js'), { namedExports: names(['getArticleCounter', 'updateArticleCounter']) });
mock.module(url('../services/commentService/captchaService.js'), { namedExports: names(['verifyCaptcha']) });
mock.module(url('../services/commentService/sensitiveWordService.js'), { namedExports: names(['checkSensitiveWords', 'isSensitiveBanned', 'banIpForSensitiveWord', 'logSensitiveViolation']) });
const { default: lists } = await import('./router_lists.js');
const { default: blog } = await import('./router_blog.js');
const { default: comments } = await import('./router_commentservice.js');
const { default: waline } = await import('./router_comment.js');
let server, origin;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, done) => {
        res.locals.userid = 5; res.locals.tokenType = 'personal'; res.locals.scopes = ['list:4:update']; done();
    });
    app.use('/lists', lists); app.use('/blog', blog); app.use('/commentservice', comments); app.use('/comment', waline);
    app.use((err, req, res, done) => res.status(err.statusCode || err.status || 500).json({ code: err.code }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => Object.assign(state, { auth: [], calls: [], denied: false }));
async function request(path, method = 'GET', body) {
    return fetch(`${origin}${path}`, { method, headers: { 'x-zerocat-delegation': '23', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('cover authoring session requires the blog creation scope', async () => {
    const response = await fetch(`${origin}/blog/authoring-session`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success', data: { id: 5 } });
    assert.equal(state.auth.length, 1);
    assert.equal(state.auth[0].requiredScope, 'blog:create');
    assert.equal(state.auth[0].allowDelegation, undefined);
});

for (const [path, method, body, scope, operation] of [
    ['/lists/listid/4', 'GET', null, 'list:4:read', 'getProjectList'],
    ['/lists/update/4', 'POST', { title: 'x' }, 'list:4:update', 'updateList'],
    ['/lists/delete', 'POST', { id: 4 }, 'list:4:delete', 'deleteList'],
    ['/lists/add', 'POST', { listid: 4, projectid: 7 }, 'list:4:update', 'addProjectToList'],
    ['/lists/remove', 'POST', { listid: 4, projectid: 7 }, 'list:4:update', 'removeProjectFromList'],
    ['/blog/drafts/7', 'GET', null, 'blog:7:read', 'getDraft'],
    ['/blog/drafts/7', 'PUT', { content: 'x' }, 'blog:7:update', 'saveDraft'],
    ['/blog/drafts/7', 'DELETE', null, 'blog:7:delete', 'discardDraft'],
    ['/blog/drafts/7/publish', 'POST', { message: 'x' }, 'blog:7:update', 'publishDraft'],
    ['/commentservice/spaces/space-cuid/comments', 'GET', null, 'comment:space-cuid:read', 'getCommentList'],
    ['/commentservice/spaces/space-cuid/comments/11', 'PUT', { status: 'approved' }, 'comment:space-cuid:update', 'updateComment'],
    ['/commentservice/spaces/space-cuid/comments/11', 'PUT', { like: true }, 'comment:space-cuid:interact', 'updateComment'],
    ['/commentservice/spaces/space-cuid/comments/11', 'DELETE', null, 'comment:space-cuid:delete', 'deleteComment'],
    ['/commentservice/comments/11', 'GET', null, 'comment:11:read', 'getComment'],
    ['/commentservice/comments/11', 'PUT', { comment: 'x' }, 'comment:11:update', 'updateComment'],
    ['/commentservice/comments/11', 'PUT', { like: true }, 'comment:11:interact', 'updateComment'],
    ['/commentservice/comments/11', 'DELETE', null, 'comment:11:delete', 'deleteComment'],
]) {
    test(`${method} ${path} opts in exact scope and forwards original token plus actual actor`, async () => {
        const response = await request(path, method, body);
        assert.equal(response.status, 200);
        await response.body.cancel();
        assert.ok(state.auth.length);
        for (const auth of state.auth) {
            assert.equal(auth.requiredScope, scope); assert.equal(auth.allowDelegation, true);
            assert.equal(auth.delegationId, '23'); assert.equal(auth.tokenType, 'personal');
            assert.deepEqual(auth.tokenScopes, ['list:4:update']);
            assert.equal(auth.actorId ?? auth.userId, 5);
        }
        const call = state.calls.find(entry => entry.name === operation);
        assert.ok(call);
        assert.match(JSON.stringify(call.args), /"delegationId":"23"/);
        assert.equal(JSON.stringify(call.args).includes('"principalId":9'), false);
    });
}

for (const [path, method, body] of [
    ['/lists/create', 'POST', { title: 'x' }], ['/lists/my', 'GET'], ['/lists/userid/9/public', 'GET'],
    ['/blog/drafts', 'GET'], ['/blog/posts', 'GET'], ['/blog/posts/', 'GET'], ['/blog/posts/@user', 'GET'], ['/blog/posts/7/related', 'GET'],
    ['/commentservice/spaces', 'POST', { name: 'x' }], ['/commentservice/spaces/space-cuid', 'GET'],
    ['/commentservice/spaces/space-cuid/config', 'PUT', {}], ['/commentservice/spaces/space-cuid/users/5', 'PUT', { type: 'moderator' }],
    ['/comment/space-cuid/api/comment/11', 'PUT', { comment: 'x' }],
]) {
    test(`${method} ${path} rejects delegation rather than authorizing create/manage or silently ignoring it`, async () => {
        const response = await request(path, method, body);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, 'ZC_ERROR_DELEGATION_NOT_SUPPORTED');
        assert.equal(state.calls.length, 0);
    });
}

for (const id of ['space-cuid', '11junk', '011', '9007199254740992']) {
    test(`numeric comment route rejects ambiguous ID ${id}`, async () => {
        const response = await request(`/commentservice/comments/${id}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'ZC_ERROR_INVALID_ID');
        assert.equal(state.auth.length, 0);
        assert.equal(state.calls.length, 0);
    });
}

test('revoked delegation fails route before a service receives a write', async () => {
    state.denied = true;
    const response = await request('/lists/update/4', 'POST', { title: 'x' });
    assert.equal(response.status, 403);
    assert.equal(state.calls.length, 0);
});

function walineHandler(method, path) {
    const layer = waline.stack.find(item => item.route?.path === path && item.route.methods[method]);
    return layer.route.stack.at(-1).handle;
}

function directResponse() {
    return {
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

for (const method of ['put', 'delete']) {
    test(`comment:create-only Waline identity cannot ${method} a comment`, async () => {
        const req = {
            body: { comment: 'changed' },
            params: { id: '11' },
            commentSpace: { id: 3 },
            walineUser: { userId: 5, scopes: ['comment:create'] },
        };
        const res = directResponse();

        await walineHandler(method, '/:spaceCuid/api/comment/:id')(req, res, error => { if (error) throw error; });

        assert.equal(res.statusCode, 403);
        assert.equal(res.body.errmsg, '令牌权限不足');
        assert.equal(state.calls.some(call => call.name === `${method === 'put' ? 'update' : 'delete'}Comment`), false);
    });
}

for (const [method, required, operation] of [
    ['put', 'comment:update', 'updateComment'],
    ['delete', 'comment:delete', 'deleteComment'],
]) {
    test(`${required} preserves the matching owner mutation`, async () => {
        const req = {
            body: { comment: 'changed' },
            params: { id: '11' },
            commentSpace: { id: 3 },
            walineUser: { userId: 5, scopes: [required] },
        };
        const res = directResponse();

        await walineHandler(method, '/:spaceCuid/api/comment/:id')(req, res, error => { if (error) throw error; });

        assert.equal(res.statusCode, 200);
        assert.equal(state.calls.some(call => call.name === operation), true);
    });
}

test('comment:create preserves authenticated comment posting', async () => {
    const req = {
        body: { comment: 'new comment', url: '/article' },
        headers: {},
        ip: '127.0.0.1',
        commentSpace: { id: 3, cuid: 'space-cuid' },
        spaceConfig: {},
        walineUser: { userId: 5, scopes: ['comment:create'] },
    };
    const res = directResponse();

    await walineHandler('post', '/:spaceCuid/api/comment')(req, res, error => { if (error) throw error; });

    assert.equal(res.statusCode, 200);
    assert.equal(state.calls.some(call => call.name === 'createComment'), true);
});
