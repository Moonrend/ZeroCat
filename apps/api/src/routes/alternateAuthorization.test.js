import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = {};
const noop = () => {};
mock.module('../services/logger.js', { defaultExport: { info: noop, warn: noop, error: noop, debug: noop } });
mock.module('../services/config/zcconfig.js', { defaultExport: { get: async () => '' } });
mock.module('../middleware/auth.js', { namedExports: { needLogin: noop } });
mock.module('../middleware/scope.js', { namedExports: { requireResource: () => noop, requireScope: () => noop } });
mock.module('../services/global.js', { namedExports: { S3update: noop } });
mock.module('../services/redis.js', { defaultExport: {} });
mock.module('../services/projectCollaborationService.js', { namedExports: { userCanActOnProject: async () => true } });
mock.module('../services/auth/permissionManager.js', { namedExports: { hasProjectPermission: async () => true } });
mock.module('../services/projectFileStorage.js', { namedExports: {
    readProjectFile: async () => { state.fileReads++; return { source: 'extension source' }; },
} });
mock.module('../services/extensionReview.js', { namedExports: { setReviewStatus: noop, isAutoApproveUser: async () => false } });
mock.module('../controllers/projects.js', { namedExports: {
    getProjectById: async () => state.project,
    getProjectFile: async () => { state.fileReads++; return { source: 'private source' }; },
} });
mock.module('../services/assets.js', { namedExports: Object.fromEntries([
    'validateFileTypeFromContent', 'uploadFile', 'handleAssetUpload', 'processImage', 'generateMD5', 'uploadToS3',
].map(name => [name, noop])) });
mock.module('jsonwebtoken', { defaultExport: { verify: () => state.signedToken, sign: () => 'signed' } });
const { scopeSatisfies } = await import('../services/auth/scopes.js');
mock.module('../services/auth/authorization.js', { namedExports: { authorize: async context => {
    state.authorizations.push(context);
    return { allowed: !state.denied && (context.tokenType === 'session' || scopeSatisfies(context.tokenScopes, context.requiredScope)),
        status: 403, code: 'TOKEN_CEILING', message: 'denied' };
} } });
mock.module('../services/moderation/visibility.js', { namedExports: {
    canViewContent: async (kind, record) => Boolean(record) && !state.hidden,
    sanitizeProfile: async user => state.hiddenProfile ? null : user,
    sanitizeProfiles: async users => { state.profileBatches++; return users.map(user => state.hiddenProfile ? null : user); },
    visibleWhere: async kind => ({ moderation_guard: true, ...(kind === 'profile' ? { hidden_profile: state.hiddenProfile } : {}) }),
} });
mock.module('../services/prisma.js', { namedExports: { prisma: {
    $queryRaw: async (_sql, ...values) => values.includes('tip') ? [{ id: 'tip', parent_commit_id: null, commit_file: 'file' }] : [],
    ow_projects: { findFirst: async () => state.project,
        findMany: async () => { state.sampleReads++; return state.visibleSamples; } },
    ow_users: { findMany: async ({ where }) => where.AND?.some(filter => filter.hidden_profile)
        ? [] : [{ id: 3, username: 'hidden-profile' }] },
    ow_target_configs: { findMany: async () => [] },
    ow_events: { findMany: async () => [{ id: 1, actor_id: 3, event_data: { user: 'old-hidden-profile', value: '5' } }] },
    project_clouddata_history: { findMany: async () => [{ id: 1, actor_id: 3, actor_name: 'old-hidden-profile', value: '5' }] },
    ow_scratch_extensions: {
        findMany: async () => { state.extensionReads++; return structuredClone(state.extensionRows); },
        findFirst: async () => { state.extensionReads++; return structuredClone(state.extension); },
        findUnique: async () => { state.extensionReads++; return structuredClone(state.extension); },
    },
    ow_projects_branch: { findMany: async () => [{ latest_commit_hash: 'tip' }], findFirst: async () => ({ latest_commit_hash: 'tip' }) },
    ow_projects_commits: { findUnique: async ({ where }) => ({ id: where.id, parent_commit_id: null, commit_file: 'file' }) },
    ow_projects_file: { findFirst: async () => { state.fileReads++; return { source: 'extension source' }; } },
} } });
const { default: scratch } = await import('./router_scratch.js');
const { default: extensions } = await import('./router_extensions.js');
function handler(router, path, name = null) {
    const stack = router.stack.find(layer => layer.route?.path === path).route.stack;
    return name ? stack.find(layer => layer.handle.name === name).handle : stack.at(-1).handle;
}
function response(locals = {}) {
    return { locals, statusCode: 200, body: null, status(value) { this.statusCode = value; return this; },
        send(value) { this.body = value; return this; }, json(value) { this.body = value; return this; }, contentType() { return this; } };
}
const next = error => { if (error) throw error; };
beforeEach(() => {
    const project = { id: 7, authorid: 9, state: 'public', type: 'scratch', default_branch: 'main', source: 'public-file', devsource: 'private-file' };
    Object.assign(state, { project, hidden: false, hiddenProfile: false, denied: false, fileReads: 0, extensionReads: 0, authorizations: [],
        sampleReads: 0, profileBatches: 0, visibleSamples: [], extensionRows: [],
        signedToken: { data: { projectid: 7, userid: 3, authorizationContext: { tokenType: 'session', tokenScopes: [] } } },
        extension: { id: 5, status: 'verified', projectid: 7, branch: 'main', commit: 'tip', project },
    });
});

test('Scratch project metadata also respects the authenticated caller token ceiling', async () => {
    const res = response({ userid: 3, tokenType: 'oauth', scopes: ['user:read'] });
    await handler(scratch, '/projectinfo')({ query: { id: '7' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.authorizations[0].requiredScope, 'project:7:read');
});

test('a signed Scratch project token cannot widen the current caller token ceiling', async () => {
    const res = response({ userid: 3, tokenType: 'oauth', scopes: ['user:read'] });
    await handler(scratch, '/project/:id')({ params: { id: '7' }, query: { token: 'signed' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.fileReads, 0);
    assert.equal(state.authorizations[0].tokenType, 'oauth');
});

test('signed Scratch project access without a current login still preserves its original token ceiling', async () => {
    state.signedToken.data.authorizationContext = { tokenType: 'oauth', tokenScopes: ['user:read'] };
    const res = response({});
    await handler(scratch, '/project/:id')({ params: { id: '7' }, query: { token: 'signed' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.fileReads, 0);
});

test('Scratch source download rechecks current moderation rather than trusting a signed snapshot', async () => {
    state.hidden = true;
    const res = response({});
    await handler(scratch, '/project/:id')({ params: { id: '7' }, query: { token: 'signed' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.fileReads, 0);
});

test('extension source requires the backing project token scope as well as extension read', async () => {
    const res = response({ userid: 3, tokenType: 'oauth', scopes: ['extension:5:read'] });
    await handler(extensions, '/{:id}.js')({ params: { id: '5' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.fileReads, 0);
    assert.deepEqual(state.authorizations.map(context => context.requiredScope), ['extension:5:read', 'project:7:read']);
});

test('extension source cannot expose an unrelated commit even from a visible project', async () => {
    state.extension.commit = 'unrelated';
    const res = response({});
    await handler(extensions, '/{:id}.js')({ params: { id: '5' } }, res, next);
    assert.equal(res.statusCode, 404);
    assert.equal(state.fileReads, 0);
});

for (const [path, key, actorName] of [
    ['/cloud/:projectid/updates', 'updates', 'user'], ['/cloud/:projectid/history', 'history', 'actor_name'],
]) {
    test(`cloud ${key} redacts historical profile names when the canonical profile becomes hidden`, async () => {
        state.hiddenProfile = true;
        const res = response({ userid: 9, tokenType: 'session', scopes: [] });
        await handler(scratch, path)({ params: { projectid: '7' }, query: {} }, res, next);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body[key][0].actor, null);
        assert.equal(res.body[key][0][actorName], null);
        assert.equal(res.body[key][0].value, '5');
    });
}

test('extension management reuses the authorized extension within the same request', async () => {
    state.extension.commit = 'latest';
    const res = response({ userid: 9, tokenType: 'session', scopes: [] });
    const req = { params: { id: '5' } };
    let continued = false;
    await handler(extensions, '/manager/update/:id', 'requireExtensionProject')(req, res, () => { continued = true; });
    assert.equal(continued, true);
    await handler(extensions, '/manager/update/:id')(req, res, next);
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.data.commit, 'latest');
    assert.equal(state.extensionReads, 1);
});

test('extension batches share sample visibility and redact author profiles without changing order', async () => {
    state.hiddenProfile = true;
    state.extensionRows = [5, 6].map(id => ({ ...state.extension, id,
        project: { ...state.project, author: { id: 9, username: 'hidden' } },
        sample_project: { id: 20, name: 'private sample' } }));
    const res = response({ userid: 3, tokenType: 'session', scopes: [] });
    await handler(extensions, '/detail/batch')({ body: { ids: [6, 5] } }, res, next);
    assert.deepEqual(res.body.data.map(item => item.id), [6, 5]);
    assert.ok(res.body.data.every(item => item.data.project.author === null && item.data.sample_project === null));
    assert.equal(state.sampleReads, 1);
    assert.equal(state.profileBatches, 1);
    assert.equal(state.authorizations.length, 4);
});

test('extension batch reads still enforce the backing project token scope', async () => {
    state.extensionRows = [state.extension];
    const res = response({ userid: 3, tokenType: 'oauth', scopes: ['extension:5:read'] });
    await handler(extensions, '/detail/batch')({ body: { ids: [5] } }, res, next);
    assert.equal(res.body.data[0].exists, false);
    assert.equal(state.sampleReads, 0);
    assert.deepEqual(state.authorizations.map(context => context.requiredScope), ['extension:5:read', 'project:7:read']);
});

test('extension management also rechecks its backing project current write policy', async () => {
    state.denied = true;
    const res = response({ userid: 3, tokenType: 'session', scopes: [] });
    let continued = false;
    await handler(extensions, '/manager/edit/:id', 'requireExtensionProject')({ params: { id: '5' } }, res, () => { continued = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(continued, false);
    assert.equal(state.authorizations[0].requiredScope, 'project:7:update');
});
