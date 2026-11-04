import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { createHash } from 'node:crypto';

const state = {};
const url = path => new URL(path, import.meta.url).href;
const logger = { error() {}, warn() {}, info() {}, debug() {} };
const prisma = {
    async $queryRawUnsafe(sql, ...values) {
        state.sql.push({ sql, values });
        return sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
    },
    async $transaction(work) { return Array.isArray(work) ? Promise.all(work) : work(prisma); },
    ow_users: { async findMany() { return []; } },
    ow_user_restrictions: { async findMany({ where }) {
        return state.hiddenProfile ? where.user_id.in.map(user_id => ({ user_id })) : [];
    } },
    ow_projects: {
        async findMany() { return []; },
        async findFirst(query) { state.projectReads.push(query); return state.featuredProject; },
    },
    ow_comment_spaces: { async findUnique() { return { owner_id: state.spaceOwner }; } },
    ow_comment_service_users: { async findMany(query) { state.userReads.push(query); return []; } },
    ow_comment_service: {
        async findUnique() { return state.comment; },
        async findFirst() { return state.comment; },
        async findMany(query) { state.reads.push(query); return state.exportComments; },
        async count(query) { state.counts.push(query); return 0; },
        async create({ data }) { state.created.push(data); return { id: 90, ...data }; },
        async update() { state.updated++; return state.comment; },
        async deleteMany() { state.deleted++; return { count: 0 }; },
    },
    ow_comment_service_counter: {
        async findMany() { return []; },
        async deleteMany() { return { count: 0 }; },
        async upsert() {},
    },
};
mock.module(url('../logger.js'), { defaultExport: logger });
mock.module(url('../prisma.js'), { namedExports: { prisma } });
mock.module(url('../redis.js'), { defaultExport: {
    async get(key) { return key.startsWith('cs:datatask:data:') ? state.exportCache : state.task; },
    async set() {}, async exists() { return false; },
} });
mock.module(url('../config/zcconfig.js'), { defaultExport: { async get() { return ''; } } });
mock.module(url('./visibility.js'), { namedExports: {
    async visibleWhere(kind) { return { moderation_kind: kind }; },
    async visibleSql(kind, alias) { return { text: `${alias}.moderation_guard = $1`, values: [777] }; },
    async canViewContent(kind, record) { return Boolean(record) && !state.hidden && !(kind === 'profile' && state.hiddenProfile); },
    async sanitizePublicUser(user) { return user; },
    async sanitizeProfiles(users) { return users.map(user => state.hiddenProfile ? null : user); },
    async assertCanWrite(userId, category, action) {
        state.guards.push({ userId, category, action });
        if (state.readonly) throw Object.assign(new Error('readonly'), { statusCode: 403, code: 'ACCOUNT_READ_ONLY' });
    },
} });
mock.module(url('../activitypub/index.js'), { namedExports: {
    async federatedUserSearch() { return { users: [] }; }, parseFediAddress() { return null; },
} });
mock.module(url('../commentService/walineFormatter.js'), { namedExports: {
    async formatComment(record) { return record; }, async formatCommentsWithChildren() { return []; },
} });
mock.module(url('../commentService/spaceManager.js'), { namedExports: { async getSpaceUser() { return null; } } });
mock.module(url('../commentService/sanitizer.js'), { namedExports: { sanitizeComment(value) { return value; } } });
mock.module(url('../commentService/akismetService.js'), { namedExports: { async checkAkismetSpam() { return false; } } });
mock.module(url('../commentService/levelService.js'), { namedExports: { async batchGetUserLevels() { return new Map(); } } });
mock.module(url('../commentService/markdown.js'), { namedExports: { renderMarkdown(value) { return value; } } });
mock.module(url('../commentService/notify/notifyContext.js'), { namedExports: {
    async buildContext(comment, parent) { state.contexts++; state.notifyComment = comment; state.notifyParent = parent; return {}; }, async getAdminEmail() { return ''; },
} });
mock.module(url('../commentService/notify/providers/index.js'), { namedExports: {
    getEnabledProviders() { return [{ name: 'test', async send() { state.sent++; return { success: true }; } }]; },
} });
mock.module(url('../projectFileStorage.js'), { namedExports: {
    async readProjectFile() { return null; },
    async hydrateProjectFile(row) { return row; },
    async saveProjectFile(source) { return { sha256: createHash('sha256').update(source).digest('hex') }; },
} });
mock.module(url('../gorse.js'), { defaultExport: {} });
mock.module(url('../global.js'), { namedExports: { validateUsername() { return { valid: true }; } } });
mock.module(url('../../utils/avatarUrl.js'), { namedExports: { async buildAvatarURL() { return '/avatar'; } } });
mock.module(url('../../controllers/notifications.js'), { namedExports: { async createNotification() {} } });
const { getActorEvents, getTargetEvents } = await import('../../controllers/events.js');
const { sanitizeFeaturedProjects } = await import('../../controllers/users.js');
const { default: searchRouter } = await import('../../routes/router_search.js');
const comments = await import('../commentService/commentManager.js');
const data = await import('../commentService/dataService.js');
const { default: notifier } = await import('../commentService/notify/notifyService.js');

beforeEach(() => Object.assign(state, {
    sql: [], reads: [], counts: [], created: [], guards: [], updated: 0, deleted: 0,
    readonly: false, hidden: false, hiddenProfile: false, comment: null, contexts: 0, sent: 0,
    task: { user_id: 7, space_id: 3, type: 'import' }, spaceOwner: 7,
    exportComments: [], userReads: [], exportCache: null, notifyComment: null, notifyParent: null,
    projectReads: [], featuredProject: null,
}));

for (const scope of ['projects', 'users', 'posts']) {
    test(`search ${scope} applies parameterized visibility to rows and count before pagination`, async () => {
        const handler = searchRouter.stack.find(layer => layer.route?.path === '/').route.stack[0].handle;
        let result;
        const res = { locals: { userid: 7 }, status() { return this; }, send(value) { result = value; } };
        await handler({ query: { scope, keyword: 'needle', page: 2, perPage: 5 } }, res, error => { throw error; });
        assert.ok(result);
        assert.equal(state.sql.length, 2);
        for (const query of state.sql) {
            assert.match(query.sql, /moderation_guard = \$\d+/);
            assert.ok(query.values.includes(777));
            assert.equal(query.sql.includes('777'), false);
        }
        const rows = state.sql.find(query => !query.sql.includes('COUNT(*)'));
        const count = state.sql.find(query => query.sql.includes('COUNT(*)'));
        assert.equal(rows.sql.match(/moderation_guard = \$(\d+)/)[1], count.sql.match(/moderation_guard = \$(\d+)/)[1]);
        assert.deepEqual(rows.values.slice(-2), [5, 5]);
    });
}

test('public comment pagination and counts keep moderation filtering even for a space administrator', async () => {
    await comments.getComments(3, { url: '/article', page: 2 }, { isAdmin: true, userId: 7 });
    assert.equal(state.reads[0].skip, 10);
    assert.equal(state.reads[0].where.AND[0].moderation_kind, 'comment_service');
    assert.equal(state.counts.length, 2);
    assert.ok(state.counts.every(query => query.where.AND[0].moderation_kind === 'comment_service'));
});

test('readonly authenticated comment creation fails before a database write', async () => {
    state.readonly = true;
    await assert.rejects(comments.createComment(3, { comment: 'text', url: '/' }, {}, { userId: 7 }), { code: 'ACCOUNT_READ_ONLY' });
    assert.equal(state.created.length, 0);
});

test('authenticated comment creation records trusted account ownership', async () => {
    const record = await comments.createComment(3, { comment: 'text', url: '/' }, {}, { userId: 7, nick: 'member' });
    assert.equal(record.account_user_id, 7);
    assert.equal(record.user_id, '7');
});

test('legacy display user_id does not authorize editing an unverified imported comment', async () => {
    state.comment = { id: 9, user_id: '7', account_user_id: null };
    assert.equal(await comments.updateComment(3, 9, { comment: 'changed' }, 7), null);
    assert.equal(state.updated, 0);
});

test('comment import never derives authenticated account ownership from email or file user IDs', async () => {
    const result = await data.importSpaceData(3, {
        Comment: [{ objectId: 1, user_id: '7', mail: 'member@example.test', comment: 'imported' }],
        Users: [{ objectId: 7, email: 'member@example.test' }],
    }, 'task');
    assert.equal(result.usersMapped, 0);
    assert.equal(state.created[0].account_user_id, null);
    assert.equal(state.created[0].user_id, null);
});

test('readonly import is rechecked when the queued task executes, before clearing existing data', async () => {
    state.readonly = true;
    await assert.rejects(data.importSpaceData(3, { Comment: [] }, 'task'), { code: 'ACCOUNT_READ_ONLY' });
    assert.equal(state.deleted, 0);
});

test('notification execution reloads the canonical comment and suppresses a newly hidden record', async () => {
    state.comment = { id: 9, account_user_id: 7, comment: 'current' };
    state.hidden = true;
    const result = await notifier.run('admin_new_comment', { id: 9, comment: 'old snapshot' }, {}, 'space');
    assert.equal(result.reason, 'comment_unavailable');
    assert.equal(state.contexts, 0);
    assert.equal(state.sent, 0);
});

test('queued import rechecks current space ownership before clearing comments', async () => {
    state.spaceOwner = 8;
    await assert.rejects(data.importSpaceData(3, { Comment: [] }, 'task'), { code: 'RESOURCE_NOT_FOUND' });
    assert.equal(state.deleted, 0);
});

test('export filters comments and profiles before creating the download', async () => {
    state.task.type = 'export';
    state.exportComments = [{ id: 11, comment: 'current', account_user_id: 9, nick: 'old name', mail: 'old@example.test', link: '/old-profile' }];
    state.hiddenProfile = true;
    const result = JSON.parse(await data.exportSpaceData(3, 'space', 'Space', 'task', null, { download: true }));
    assert.equal(state.reads[0].where.AND[0].moderation_kind, 'comment_service');
    assert.equal(state.userReads[0].where.user.is.moderation_kind, 'profile');
    assert.deepEqual(result.data.Comment.map(({ comment, nick, mail, link, user_id }) => ({ comment, nick, mail, link, user_id })), [
        { comment: 'current', nick: '用户', mail: null, link: null, user_id: null },
    ]);
});

test('completed export downloads rebuild current data rather than returning cached snapshots', async () => {
    state.task = { ...state.task, type: 'export', status: 'completed', spaceCuid: 'space', spaceName: 'Space' };
    state.exportCache = { data: { Comment: [{ comment: 'hidden cached text' }] } };
    const result = JSON.parse(await data.getExportData('task'));
    assert.deepEqual(result.data.Comment, []);
    assert.equal(state.reads[0].where.AND[0].moderation_kind, 'comment_service');
});

test('comment notifications redact hidden profile snapshots before external provider context', async () => {
    state.comment = { id: 9, account_user_id: 7, comment: 'current', nick: 'old name', mail: 'old@example.test', link: '/old-profile' };
    state.hiddenProfile = true;
    await notifier.run('admin_new_comment', state.comment, {}, 'space');
    assert.equal(state.sent, 1);
    assert.equal(state.notifyComment.nick, '用户');
    assert.equal(state.notifyComment.mail, null);
    assert.equal(state.notifyComment.link, null);
});

for (const [name, read] of [
    ['actor', () => getActorEvents(8, 5, 10, false, 7)],
    ['target', () => getTargetEvents('project', 19, 5, 10, false, 7)],
]) {
    test(`${name} activity filters canonical targets and profiles before pagination`, async () => {
        assert.deepEqual(await read(), []);
        assert.equal(state.sql.length, 1);
        const { sql, values } = state.sql[0];
        for (const table of ['ow_users', 'ow_projects', 'ow_posts', 'ow_comment', 'ow_projects_lists']) {
            assert.ok(sql.indexOf(`FROM ${table}`) < sql.indexOf('LIMIT'));
        }
        assert.match(sql, /a\.id = e\.actor_id AND a\.moderation_guard/);
        assert.match(sql, /t\.page_type = 'project' AND EXISTS/);
        assert.match(sql, /t\.page_type = 'post' AND EXISTS/);
        assert.equal(sql.includes('777'), false);
        assert.deepEqual(values.slice(-2), [5, 10]);
        assert.ok(values.includes(777));
    });
}

test('private activity requests retain the requested actor rather than replacing it with the viewer', async () => {
    await getActorEvents(8, 5, 0, true, 7);
    assert.match(state.sql[0].sql, /e\."actor_id" = \$1/);
    assert.match(state.sql[0].sql, /e\.actor_id = \$2/);
    assert.deepEqual(state.sql[0].values.slice(0, 2), [8, 7]);
});

test('public profiles clear featured project references that are no longer visible', async () => {
    const user = { id: 8, featured_projects: 19, display_name: 'member' };
    assert.deepEqual(await sanitizeFeaturedProjects(user, 7), { ...user, featured_projects: null });
    assert.deepEqual(state.projectReads[0].where, { id: 19, AND: [{ moderation_kind: 'project' }] });
    assert.equal(user.featured_projects, 19);
});

test('public profiles retain a currently visible featured project reference', async () => {
    state.featuredProject = { id: 19 };
    assert.equal((await sanitizeFeaturedProjects({ id: 8, featured_projects: 19 }, 7)).featured_projects, 19);
});
