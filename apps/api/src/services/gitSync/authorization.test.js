import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const state = { calls: [], storageReads: 0, visible: true, denied: null, project: null, githubWrites: 0,
    allowGithub: false, trees: [], blogSettings: null, blogState: {}, queue: null, queued: [], featureEnabled: false };
const noop = () => {};
mock.module('../logger.js', { defaultExport: { info: noop, error: noop, warn: noop, debug: noop } });
const { scopeSatisfies } = await import('../auth/scopes.js');
mock.module('../auth/authorization.js', { namedExports: { authorize: async (context) => {
    state.calls.push(context);
    if (!context.actorId) return { allowed: false, status: 401, code: 'LOGIN_REQUIRED' };
    if (context.tokenType !== 'session' && !scopeSatisfies(context.tokenScopes, context.requiredScope)) {
        return { allowed: false, status: 403, code: 'TOKEN_CEILING' };
    }
    if (state.denied?.(context)) return { allowed: false, status: 403, code: 'LIVE_DENY' };
    return { allowed: true };
} } });
mock.module('../moderation/visibility.js', { namedExports: {
    canViewContent: async () => state.visible, visibleWhere: async () => ({}),
} });
mock.module('../prisma.js', { namedExports: { prisma: {
    ow_projects: { findFirst: async () => state.project },
    ow_projects_branch: { findMany: async () => [] },
} } });
mock.module('../config/zcconfig.js', { defaultExport: { get: async (key, fallback) => key === 'bullmq.enabled' ? true : key === 'git.sync.enabled' ? state.featureEnabled : fallback ?? false } });
mock.module('../assets.js', { namedExports: { downloadFromS3: async () => { throw new Error('Unexpected asset read'); } } });
mock.module('../projectFileStorage.js', { namedExports: {
    readProjectFile: async () => { throw new Error('Unexpected project content read'); },
    readProjectFiles: async () => { throw new Error('Unexpected project content read'); },
} });
mock.module('../../controllers/notifications.js', { namedExports: { createNotification: async () => {} } });
mock.module('./githubApp.js', { namedExports: { createInstallationToken: async () => {
    state.githubWrites++;
    if (!state.allowGithub) throw new Error('Unexpected GitHub access');
    return { token: 'test' };
} } });
const githubApi = Object.fromEntries(['createBlob', 'createCommit', 'createRef', 'createTree', 'getCommit', 'getContent', 'getRef', 'getRepo', 'getTree', 'updateRef']
    .map((name) => [name, async (...args) => {
        state.githubWrites++;
        if (!state.allowGithub) throw new Error('Unexpected GitHub access');
        if (name === 'getRepo') return { default_branch: 'main' };
        if (name === 'getRef') return { object: { sha: 'parent' } };
        if (name === 'getCommit') return { tree: { sha: 'tree' } };
        if (name === 'getTree') { state.onGetTree?.(); return { tree: [{ type: 'blob', path: 'posts/seven.md' }, { type: 'blob', path: 'posts/eight.md' }] }; }
        if (name === 'createTree') state.trees.push(args[3]);
        return { sha: 'created' };
    }]));
mock.module('./githubApi.js', { namedExports: githubApi });
mock.module('./storage.js', { namedExports: {
    findUserGitLink: async () => state.allowGithub ? { installationId: 1 } : null,
    getProjectGitSyncSettings: async () => { state.storageReads++; return { enabled: true, provider: 'github', linkKind: 'app' }; },
    getProjectGitSyncState: async () => ({}), setProjectGitSyncState: async () => {},
    updateProjectGitSyncSettings: async () => {}, readUserConfig: async (userId, key) => {
        state.storageReads++; return key === 'blog.sync.state' ? structuredClone(state.blogState) : state.blogSettings || { enabled: false };
    },
    writeUserConfig: async (userId, key, value) => { if (key === 'blog.sync.state') state.blogState = structuredClone(value); },
} });
mock.module('bullmq', { namedExports: { Worker: class {} } });
mock.module('../queue/redisConnectionFactory.js', { namedExports: { createConnection: async () => ({}), closeAll: async () => {} } });
mock.module('../queue/queues.js', { namedExports: {
    QUEUE_NAMES: { GIT_SYNC: 'git-sync' }, createQueues: async () => {},
    getGitSyncQueue: () => state.queue,
    ...Object.fromEntries(['Email', 'ScheduledTasks', 'CommentNotification', 'DataTask', 'SocialSync', 'ApFederation', 'Embedding', 'Mirror40Code']
        .map(name => [`get${name}Queue`, () => null])),
} });
for (const [file, name] of [['email', 'Email'], ['scheduledTasks', 'ScheduledTasks'], ['commentNotification', 'CommentNotification'],
    ['dataTask', 'DataTask'], ['socialSync', 'SocialSync'], ['apFederation', 'ApFederation'], ['embedding', 'Embedding'], ['mirror40code', 'Mirror40Code']]) {
    mock.module(`../queue/workers/${file}Worker.js`, { namedExports: {
        [`create${name}Worker`]: async () => {}, [`get${name}Worker`]: () => null,
    } });
}

const { assertSyncAuthorized } = await import('./authorization.js');
const { default: gitSync } = await import('./syncService.js');
const { default: blogSync } = await import('./blogSyncService.js');
const { processGitSync } = await import('../queue/workers/gitSyncWorker.js');
const { default: queueManager } = await import('../queue/queueManager.js');
await queueManager.initialize();
const payload = () => ({ actorId: 3, projectId: 7, commitId: 'commit', userId: 3,
    authorizationContext: { tokenType: 'session', tokenScopes: [] } });

beforeEach(() => Object.assign(state, { calls: [], storageReads: 0, visible: true, denied: null,
    project: { id: 7, authorid: 9, type: 'scratch', state: 'public', deleted_at: null, is_shadowbanned: false }, githubWrites: 0,
    allowGithub: false, trees: [], blogSettings: null, blogState: {}, onGetTree: null, featureEnabled: true,
    queue: { add: async (name, data) => { state.queued.push(data); return { id: 'queued' }; } }, queued: [] }));

test('direct and worker execution recheck a live deny before loading settings or writing externally', async () => {
    state.denied = () => true;
    await assert.rejects(gitSync.syncProjectCommit({ data: payload() }), { code: 'LIVE_DENY' });
    await assert.rejects(processGitSync({ data: { ...payload(), type: 'sync-project' } }), { code: 'LIVE_DENY' });
    assert.equal(state.storageReads, 0);
    assert.equal(state.githubWrites, 0);
});

test('an OAuth queue payload retains its token ceiling and does not inherit the project owner', async () => {
    const data = { ...payload(), authorizationContext: { tokenType: 'oauth', tokenScopes: ['project:7:update'] } };
    await assert.rejects(processGitSync({ data: { ...data, type: 'sync-project' } }), { code: 'TOKEN_CEILING' });
    assert.equal(state.calls[0].actorId, 3);
    assert.equal(state.storageReads, 0);
    assert.equal(state.githubWrites, 0);
});

test('article exports require both project and blog policy with the canonical sync action', async () => {
    state.denied = (context) => context.category === 'blog';
    await assert.rejects(assertSyncAuthorized(payload(), { id: 7, authorid: 9, type: 'article' }), { code: 'LIVE_DENY' });
    assert.deepEqual(state.calls.map((call) => [call.actorId, call.requiredScope, call.category, call.action]), [
        [3, 'git_sync:manage', 'projects', 'sync'], [3, 'project:7:update', 'projects', 'sync'], [3, 'blog:7:update', 'blog', 'sync'],
    ]);
});

test('moderation-hidden projects cannot be exported even to their owner', async () => {
    state.visible = false;
    await assert.rejects(gitSync.syncProjectCommit({ data: payload() }), { status: 404 });
    assert.equal(state.githubWrites, 0);
});

test('blog direct fallback and worker removal require a real actor rather than inferring userId', async () => {
    await assert.rejects(blogSync.syncArticleProject({ projectId: 7, userId: 3 }), { code: 'LOGIN_REQUIRED' });
    await assert.rejects(processGitSync({ data: { type: 'blog-sync-remove', projectId: 7, userId: 3 } }), { code: 'LOGIN_REQUIRED' });
    assert.equal(state.storageReads, 0);
});

test('blog sync cannot export another account entire article collection', async () => {
    await assert.rejects(blogSync.syncArticleProject({ ...payload(), userId: 9 }), { code: 'BLOG_SYNC_OWNER_REQUIRED' });
    assert.equal(state.storageReads, 0);
});

test('legacy actor-only queue context fails closed', async () => {
    await assert.rejects(processGitSync({ data: { ...payload(), authorizationContext: null, type: 'sync-project' } }), { code: 'TOKEN_CONTEXT_REQUIRED' });
    assert.equal(state.storageReads, 0);
});

test('enqueue checks current actor policy and token ceilings before adding a job', async () => {
    state.denied = () => true;
    await assert.rejects(queueManager.enqueueGitSyncCommit(7, 'commit', payload()), { code: 'LIVE_DENY' });
    await assert.rejects(queueManager.enqueueBlogSyncArticle(7, 3, payload()), { code: 'LIVE_DENY' });
    assert.equal(state.queued.length, 0);
    state.denied = null;
    await assert.rejects(queueManager.enqueueGitSyncCommit(7, 'commit', { actorId: 3,
        authorizationContext: { tokenType: 'oauth', tokenScopes: ['project:7:update'] } }), { code: 'TOKEN_CEILING' });
    assert.equal(state.queued.length, 0);
});

test('enqueue and worker both reject a newly hidden project', async () => {
    await queueManager.enqueueGitSyncCommit(7, 'commit', payload());
    assert.equal(state.queued[0].actorId, 3);
    state.visible = false;
    await assert.rejects(queueManager.enqueueGitSyncCommit(7, 'another', payload()), { status: 404 });
    await assert.rejects(processGitSync({ data: state.queued[0] }), { status: 404 });
    assert.equal(state.queued.length, 1);
});

function moderatedArticle() {
    state.project = { ...state.project, type: 'article', deleted_at: new Date() };
    state.visible = false;
    state.allowGithub = true;
    state.denied = () => true;
    state.blogSettings = { enabled: false, linkId: 'link', repoOwner: 'owner', repoName: 'repo' };
    state.blogState = { 7: { filePath: 'posts/seven.md' }, 8: { filePath: 'posts/eight.md' } };
    return { projectId: 7, userId: 9, systemModeration: true };
}

test('internal moderation removal retains its flag and deletes only the current hidden article despite readonly', async () => {
    const data = moderatedArticle();
    await queueManager.enqueueBlogSyncRemove(7, 9, { systemModeration: true });
    assert.equal(state.queued[0].systemModeration, true);
    const result = await processGitSync({ data: state.queued[0] });
    assert.equal(result.removed, 1);
    assert.deepEqual(state.trees, [[{ path: 'posts/seven.md', mode: '100644', type: 'blob', sha: null }]]);
    assert.deepEqual(state.blogState, { 8: { filePath: 'posts/eight.md' } });
    assert.equal(state.calls.length, 0);
    assert.equal(data.systemModeration, true);
});

test('restored or mismatched canonical articles cannot be removed by stale moderation jobs', async () => {
    const data = moderatedArticle();
    state.visible = true;
    assert.equal((await processGitSync({ data: { ...data, type: 'blog-sync-remove' } })).reason, 'content_visible');
    assert.equal((await queueManager.enqueueBlogSyncRemove(7, 9, { systemModeration: true })).queued, false);
    state.visible = false;
    assert.equal((await blogSync.removeArticleFromBlog({ ...data, userId: 3 })).reason, 'content_visible');
    assert.equal(state.githubWrites, 0);
});

test('restoring an article while removal loads the remote tree prevents a delete commit', async () => {
    const data = moderatedArticle();
    state.onGetTree = () => { state.visible = true; };
    assert.equal((await blogSync.removeArticleFromBlog(data)).reason, 'content_visible');
    assert.deepEqual(state.trees, []);
    assert.ok(state.blogState[7]);
});
