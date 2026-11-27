import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};

class RichText {
    constructor({ text }) {
        this.text = text;
        this.facets = [];
    }

    async detectFacets() {}
}

const agent = {
    async post(record) {
        state.records.push(record);
        return { uri: 'at://did:plc:test/app.bsky.feed.post/1', cid: 'post-cid' };
    },
    async uploadBlob(bytes, options) {
        state.uploads.push({ bytes, options });
        return { data: { blob: { ref: 'uploaded-blob' } } };
    },
};

const targetConfigs = {
    async findUnique({ where }) {
        const key = where.target_type_target_id_key.key;
        if (key === 'social.sync.settings') return { value: JSON.stringify({ bluesky: true }) };
        if (key === 'social.bluesky.sync.tokens') return { value: JSON.stringify({ did: 'did:plc:test' }) };
        return null;
    },
    async upsert(args) {
        state.configWrites.push(args);
        return args;
    },
};

const prisma = {
    ow_target_configs: targetConfigs,
    ow_posts: {
        async findFirst() {
            return state.post;
        },
        async findUnique() {
            return { platform_refs: state.post.platform_refs };
        },
        async update({ data }) {
            state.postUpdates.push(data);
            return state.post;
        },
    },
    ow_projects: {
        async findFirst() {
            return state.project;
        },
    },
};

mock.module('@atproto/api', { namedExports: { RichText } });
mock.module('twitter-api-sdk', { namedExports: { Client: class {}, auth: {} } });
mock.module(url('../prisma.js'), { namedExports: { prisma } });
mock.module(url('../config/zcconfig.js'), { defaultExport: {
    async get(key) {
        if (key === 'urls.frontend') return 'https://zerocat.example';
        if (key === 's3.staticurl') return 'https://static.zerocat.example';
        return null;
    },
} });
mock.module(url('../logger.js'), { defaultExport: { debug() {}, info() {}, warn() {}, error() {} } });
mock.module(url('../moderation/visibility.js'), { namedExports: {
    async visibleWhere(kind) { return { visibility: kind }; },
    async assertCanWrite() {},
} });
mock.module(url('./atprotoSyncOAuth.js'), { namedExports: {
    async getUserAtprotoSyncDid() { return 'did:plc:test'; },
    async restoreAtprotoSyncAgent() { return agent; },
} });
mock.module(url('../activitypub/outbox.js'), { namedExports: { async syncPostToActivityPub() {} } });
mock.method(globalThis, 'fetch', async target => {
    state.fetchTargets.push(String(target));
    return {
        ok: true,
        headers: { get: () => 'image/webp' },
        async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; },
    };
});

const { syncSocialEvent } = await import('./socialSync.js');

beforeEach(() => {
    Object.assign(state, {
        post: {
            id: 7,
            author_id: 2,
            post_type: 'normal',
            content: 'A linked post',
            embed: null,
            in_reply_to_id: null,
            thread_root_id: null,
            quoted_post_id: null,
            retweet_post_id: null,
            is_deleted: false,
            platform_refs: {},
            post_media: [],
        },
        project: null,
        records: [],
        uploads: [],
        fetchTargets: [],
        configWrites: [],
        postUpdates: [],
    });
});

test('Bluesky URL cards ignore persisted thumbnail targets and preserve text metadata', async () => {
    state.post.embed = {
        type: 'url',
        url: 'https://example.test/article',
        title: 'Example article',
        description: 'A safe preview',
        thumbnail: 'https://untrusted.example/thumbnail.png',
    };

    await syncSocialEvent({ actorUserId: 2, postId: 7, eventType: 'create' });

    assert.deepEqual(state.fetchTargets, []);
    assert.deepEqual(state.uploads, []);
    assert.deepEqual(state.records[0].embed, {
        $type: 'app.bsky.embed.external',
        external: {
            uri: 'https://example.test/article',
            title: 'Example article',
            description: 'A safe preview',
        },
    });
});

test('Bluesky project cards still upload ZeroCat static thumbnails', async () => {
    state.post.embed = { type: 'project', id: 19 };
    state.project = {
        id: 19,
        name: 'demo',
        title: 'Demo project',
        description: 'Project preview',
        thumbnail: 'abcdef.webp',
        author: { username: 'alice', display_name: 'Alice', bio: null, avatar: null },
    };

    await syncSocialEvent({ actorUserId: 2, postId: 7, eventType: 'create' });

    assert.deepEqual(state.fetchTargets, ['https://static.zerocat.example/assets/ab/cd/abcdef.webp']);
    assert.equal(state.uploads.length, 1);
    assert.deepEqual(state.records[0].embed.external.thumb, { ref: 'uploaded-blob' });
});
