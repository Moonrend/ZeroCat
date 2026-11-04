import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const prisma = {
    ow_users: {
        async findFirst(query) { state.users.push(query); return state.user; },
        async findMany(query) { state.proxyQueries.push(query); return state.proxies; },
    },
    ow_posts: {
        async count(query) { state.counts.push(query); return 8; },
        async findMany(query) { state.reads.push(query); return query.where.author_id ? state.posts : state.originals; },
        async findFirst(query) { state.referenceReads.push(query); return state.reference; },
        async findUnique() { throw new Error('Unexpected per-post ref lookup'); },
    },
    ow_posts_mention: { async findMany() { return []; } },
    ow_posts_media: { async findMany() { return []; } },
    ow_target_configs: { async findMany() { return state.mappings; } },
};
mock.module(url('../prisma.js'), { namedExports: { prisma } });
mock.module(url('../logger.js'), { defaultExport: { warn() {}, debug() {}, info() {}, error() {} } });
mock.module(url('../moderation/visibility.js'), { namedExports: {
    async visibleWhere(kind) { return { moderation_kind: kind }; }, async canViewContent() { return true; }, async assertCanWrite() {},
} });
mock.module(url('./config.js'), { namedExports: {
    AP_CONTEXT: 'https://www.w3.org/ns/activitystreams', AP_ACCEPT_TYPES: ['application/activity+json'], TARGET_TYPES: {},
    async getApEndpointBaseUrl() { return 'https://example.test'; }, async getInstanceBaseUrl() { return 'https://example.test'; },
    async getInstanceDomain() { return 'example.test'; }, async getStaticUrl() { return 'https://static.test'; }, async isFederationEnabled() { return true; },
} });
mock.module(url('./actor.js'), { namedExports: {
    async getActorUrl(username) { return `https://example.test/ap/users/${username}`; }, async getLocalUserById() { return state.user; },
} });
mock.module(url('./federation.js'), { namedExports: { async resolveWebFinger() {}, async fetchRemoteActor() {}, getSharedInboxUrl() {} } });
mock.module(url('./delivery.js'), { namedExports: { async deliverToFollowers() {}, async deliverActivity() {} } });
mock.module(url('./remoteMedia.js'), { namedExports: { async cacheActorMedia() {} } });
mock.module(url('./store.js'), { namedExports: {
    async setPostApRef() {}, async getPostApId() { throw new Error('Unexpected per-post AP ref lookup'); },
    async getTargetConfig() { return null; }, async queryTargetConfigs() { return []; },
    async upsertTargetConfig(...args) { state.indexWrites.push(args); },
} });
const { buildUserOutbox } = await import('./outbox.js');
const { postToNote } = await import('./objects.js');
const { findProxyUserByActorUrl } = await import('./remoteUser.js');

beforeEach(() => Object.assign(state, { user: { id: 7, username: 'test' }, users: [], counts: [], reads: [], posts: [], originals: [],
    referenceReads: [], reference: null, proxyQueries: [], mappings: [], proxies: [], indexWrites: [] }));

test('outbox overview counts visible posts without fetching a page', async () => {
    const result = await buildUserOutbox('test');
    assert.equal(result.totalItems, 8);
    assert.equal(state.counts.length, 1);
    assert.equal(state.reads.length, 0);
    assert.deepEqual(state.counts[0].where.AND, [{ moderation_kind: 'post' }]);
});

test('outbox page batches original checks and refs, preserving order, duplicates and pagination', async () => {
    state.posts = [11, 12, 13, 11].map((target, i) => ({ id: i + 1, post_type: 'retweet', retweet_post_id: target }));
    state.originals = [{ id: 11, platform_refs: { activitypub: { id: 'https://remote.test/note' } } }, { id: 12, platform_refs: null }];
    const result = await buildUserOutbox('test', 2, 4);
    assert.equal(state.counts.length, 0);
    assert.equal(state.reads.length, 2);
    assert.equal(state.reads[0].skip, 4);
    assert.deepEqual(state.reads[1].where.id.in, [11, 12, 13]);
    assert.deepEqual(state.reads[1].where.AND, [{ moderation_kind: 'post' }]);
    assert.deepEqual(result.orderedItems.map(item => item.object), ['https://remote.test/note', 'https://example.test/ap/notes/12', 'https://remote.test/note']);
    assert.equal(result.next, 'https://example.test/ap/users/test/outbox?page=3');
    assert.equal(result.prev, 'https://example.test/ap/users/test/outbox?page=1');
});

test('empty outbox pages do not count or query originals', async () => {
    const result = await buildUserOutbox('test', 1);
    assert.deepEqual(result.orderedItems, []);
    assert.equal(state.counts.length, 0);
    assert.equal(state.reads.length, 1);
});

test('related Note references load visibility and reference fields together', async () => {
    state.reference = { id: 9, platform_refs: { activitypub: { id: 'https://remote.test/original' } }, metadata: null };
    const note = await postToNote({ id: 1, author: { id: 7, username: 'test' }, in_reply_to_id: 9, content: '' });
    assert.equal(note.inReplyTo, 'https://remote.test/original');
    assert.equal(state.referenceReads.length, 1);
    assert.deepEqual(state.referenceReads[0].select, { id: true, platform_refs: true, metadata: true });
    assert.deepEqual(state.referenceReads[0].where.AND, [{ moderation_kind: 'post' }]);
});

test('supplied related-post metadata never bypasses the current visibility check', async () => {
    const note = await postToNote({ id: 1, author: { id: 7, username: 'test' }, in_reply_to_id: 9,
        in_reply_to: { platform_refs: { activitypub: { id: 'https://hidden.test/note' } }, metadata: null }, content: '' });
    assert.equal(note.inReplyTo, undefined);
    assert.equal(state.referenceReads.length, 1);
    assert.deepEqual(state.referenceReads[0].select, { id: true });
});

test('legacy actor mappings batch candidate users and retain first valid mapping precedence', async () => {
    const actor = 'https://remote.test/actor';
    state.mappings = ['bad', '0', '2', '3', '4', '3'].map(target_id => ({ target_id, value: actor }));
    state.proxies = [{ id: 4, type: 'remote_activitypub' }, { id: 3, type: 'remote_activitypub' }];
    assert.equal((await findProxyUserByActorUrl(actor)).id, 3);
    assert.equal(state.proxyQueries.length, 1);
    assert.deepEqual(state.proxyQueries[0].where, { id: { in: [2, 3, 4] }, type: 'remote_activitypub' });
    assert.deepEqual(state.indexWrites, [['ap_remote_user', '0', `actor_map:${actor}`, '3']]);
});
