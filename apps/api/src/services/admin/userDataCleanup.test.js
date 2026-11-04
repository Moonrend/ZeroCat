import test from "node:test";
import assert from "node:assert/strict";
import {
    CLEANUP_LIMITS,
    USER_DATA_CATEGORY_KEYS,
    cleanupUserData,
    getUserDataSummary,
} from "./userDataCleanup.js";

// A deliberately database-free DI fixture. It implements just the Prisma
// operations used by the engine and enforces the post Restrict graph on delete.
function matches(row, where = {}) {
    return Object.entries(where).every(([field, value]) => {
        if (field === "OR") return value.some((item) => matches(row, item));
        if (field === "AND") return value.every((item) => matches(row, item));
        if (field === "NOT") return !matches(row, value);
        if (value && typeof value === "object" && !Array.isArray(value)) {
            if ("in" in value) return value.in.includes(row[field]);
            if ("not" in value) return row[field] !== value.not;
            throw new Error(`Unsupported fixture filter ${JSON.stringify(value)}`);
        }
        return row[field] === value;
    });
}

function fixture(seed = {}) {
    const data = structuredClone(seed);
    const calls = [];
    const db = new Proxy({}, {
        get(_target, model) {
            data[model] ||= [];
            return {
                async findMany(args = {}) {
                    calls.push({ model, method: "findMany", ...args });
                    let rows = data[model].filter((row) => matches(row, args.where));
                    if (args.take !== undefined) rows = rows.slice(0, args.take);
                    return rows.map((row) => args.select
                        ? Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key]]))
                        : structuredClone(row));
                },
                async count(args = {}) {
                    calls.push({ model, method: "count", ...args });
                    return data[model].filter((row) => matches(row, args.where)).length;
                },
                async groupBy(args) {
                    calls.push({ model, method: "groupBy", ...args });
                    const groups = new Map();
                    for (const row of data[model].filter(row => matches(row, args.where))) {
                        const values = Object.fromEntries(args.by.map(field => [field, row[field]]));
                        const key = JSON.stringify(values);
                        if (!groups.has(key)) groups.set(key, { ...values, _count: { _all: 0 } });
                        groups.get(key)._count._all++;
                    }
                    return [...groups.values()];
                },
                async updateMany(args) {
                    calls.push({ model, method: "updateMany", ...structuredClone(args) });
                    const rows = data[model].filter((row) => matches(row, args.where));
                    rows.forEach((row) => Object.assign(row, args.data));
                    return { count: rows.length };
                },
                async deleteMany(args) {
                    calls.push({ model, method: "deleteMany", ...structuredClone(args) });
                    const rows = data[model].filter((row) => matches(row, args.where));
                    if (["ow_assets", "ow_projects_file", "ow_projects_commits", "ow_users"].includes(model)) {
                        throw new Error(`Protected shared/identity model deleted: ${model}`);
                    }
                    if (model === "ow_posts") {
                        const ids = new Set(rows.map((row) => row.id));
                        for (const row of data.ow_posts) {
                            for (const field of ["in_reply_to_id", "thread_root_id", "quoted_post_id", "retweet_post_id"]) {
                                assert.ok(!ids.has(row[field]), `Restrict reference ${row.id}.${field} must be detached, including selected rows`);
                            }
                        }
                    }
                    data[model] = data[model].filter((row) => !rows.includes(row));
                    return { count: rows.length };
                },
            };
        },
    });
    return { db, data, calls };
}

const post = (id, author_id, extra = {}) => ({
    id, author_id, post_type: "normal", is_deleted: false,
    in_reply_to_id: null, thread_root_id: null, quoted_post_id: null, retweet_post_id: null,
    reply_count: 99, retweet_count: 99, like_count: 99, bookmark_count: 99,
    ...extra,
});
const writes = (calls) => calls.filter(({ method }) => ["updateMany", "deleteMany"].includes(method));

test("rejects unknown/empty categories and invalid user IDs before writes", async () => {
    const { db, calls } = fixture();
    for (const categories of [[], ["all"], ["posts", "invalid"], "posts", null]) {
        await assert.rejects(cleanupUserData(db, 1, categories), { code: "INVALID_CLEANUP_CATEGORIES" });
    }
    await assert.rejects(cleanupUserData(db, 1, ["invalid"], { permanent: true }), { code: "INVALID_CLEANUP_CATEGORIES" });
    for (const id of [0, -1, "1", NaN, 1.2]) {
        await assert.rejects(cleanupUserData(db, id, ["posts"]), { code: "INVALID_USER_ID" });
    }
    assert.equal(calls.length, 0);
});

test("detaches each Restrict edge including internal/soft-deleted posts and reconciles surviving counters", async () => {
    const { db, data, calls } = fixture({
        ow_posts: [
            post(1, 1, { in_reply_to_id: 2, thread_root_id: 2 }),
            post(2, 1, { is_deleted: true, quoted_post_id: 1, retweet_post_id: 1, in_reply_to_id: 10 }),
            post(3, 2, { in_reply_to_id: 1, thread_root_id: 2, quoted_post_id: 10, retweet_post_id: 10 }),
            post(4, 2, { quoted_post_id: 2 }), post(5, 2, { retweet_post_id: 1 }),
            post(10, 2), post(11, 2, { in_reply_to_id: 10 }),
            post(12, 2, { post_type: "quote", quoted_post_id: 10 }),
            post(13, 2, { post_type: "retweet", retweet_post_id: 10 }),
            post(14, 2, { is_deleted: true, post_type: "retweet", retweet_post_id: 10 }),
        ],
        ow_posts_media: [{ id: 1, post_id: 1, asset_id: 7 }, { id: 2, post_id: 3, asset_id: 7 }],
        ow_posts_like: [{ id: 1, post_id: 1, user_id: 2 }, { id: 2, post_id: 10, user_id: 2 }],
        ow_posts_bookmark: [{ id: 1, post_id: 10, user_id: 3 }],
        ow_assets: [{ id: 7, usage_count: 99 }],
        ow_projects_assets: [{ id: 1, project_id: 50, asset_id: 7 }],
    });
    const result = await cleanupUserData(db, 1, ["posts"]);
    assert.deepEqual(result.postIds, [1, 2]);
    assert.equal(result.counts.posts, 2);
    assert.equal(data.ow_posts.length, 8);
    const survivor = data.ow_posts.find(({ id }) => id === 3);
    assert.equal(survivor.in_reply_to_id, null);
    assert.equal(survivor.thread_root_id, null);
    assert.equal(survivor.quoted_post_id, 10, "unrelated quote field must not be cleared");
    assert.equal(survivor.retweet_post_id, 10);
    const parent = data.ow_posts.find(({ id }) => id === 10);
    assert.deepEqual([parent.reply_count, parent.retweet_count, parent.like_count, parent.bookmark_count], [1, 2, 1, 1]);
    assert.equal(data.ow_posts_media[0].post_id, 3);
    assert.equal(data.ow_assets[0].usage_count, 99, "shared global usage includes references beyond project/post joins");
    assert.ok(!writes(calls).some(({ model }) => model === "ow_assets"));
    const detach = calls.filter(({ model, method, data: patch }) => model === "ow_posts" && method === "updateMany" && Object.values(patch).includes(null));
    assert.equal(detach.length, 4);
    assert.ok(detach.every(({ data: patch }) => Object.keys(patch).length === 1));
    assert.ok(!writes(calls).some(({ model }) => ["ow_users_contacts", "ow_users_totp", "ow_tokens"].includes(model)));
});

test("projects include articles/drafts and scoped dependencies but preserve forks, shared commits/files/assets", async () => {
    const { db, data } = fixture({
        ow_projects: [{ id: 11, authorid: 1, type: "article" }, { id: 22, authorid: 2, fork: 11 }],
        ow_projects_commits: [{ id: "shared-hash", author_id: 1, project_id: 11 }],
        ow_projects_file: [{ sha256: "shared-file", create_userid: 1 }],
        ow_projects_branch: [{ id: 1, projectid: 11, latest_commit_hash: "shared-hash" }, { id: 2, projectid: 22, latest_commit_hash: "shared-hash", creator: 1 }],
        ow_projects_assets: [{ id: 1, project_id: 11, asset_id: 7 }, { id: 2, project_id: 22, asset_id: 7 }],
        ow_assets: [{ id: 7, uploader_id: 1, usage_count: 2 }],
        ow_projects_history: [{ id: 1, projectid: 11, authorid: 1 }, { id: 2, projectid: 22, authorid: 1 }],
        project_clouddata_history: [{ id: 1, project_id: 11 }, { id: 2, project_id: 22, actor_id: 1 }],
        ow_projects_tags: [{ id: 1, projectid: 11 }, { id: 2, projectid: 22 }],
        ow_user_roles: [{ id: 1, user_id: 2, target_type: "project", target_id: "11" }, { id: 2, user_id: 1, target_type: "project", target_id: "22" }],
        ow_project_collaboration_invitations: [{ id: 1, project_id: 11 }, { id: 2, project_id: 22, invitee_id: 1 }],
        ow_projects_list_items: [{ id: 1, projectid: 11, listid: 50 }, { id: 2, projectid: 22, listid: 50 }],
        ow_projects_lists: [{ id: 50, authorid: 2 }],
        ow_cache_kv: [
            { user_id: 1, key: "blog.draft.11" }, { user_id: 1, key: "scratch:cloud:11:vars" },
            { user_id: 1, key: "unrelated" }, { user_id: 1, key: "blog.draft.22" },
        ],
        ow_target_configs: [{ id: 1, target_type: "blog_post", target_id: "11" }, { id: 2, target_type: "project", target_id: "22" }],
        ow_scratch_extensions: [{ id: 1, projectid: 11 }, { id: 2, projectid: 22, samples: 11 }],
        ow_embeddings: [{ id: 1, entity_type: "project", entity_id: 11 }, { id: 2, entity_type: "project", entity_id: 22 }],
        ow_users: [{ id: 2, featured_projects: 11 }],
    });
    const result = await cleanupUserData(db, 1, ["projects"]);
    assert.equal(result.counts.projects, 1);
    assert.deepEqual(data.ow_projects, [{ id: 22, authorid: 2, fork: null }]);
    assert.equal(data.ow_projects_branch[0].latest_commit_hash, "shared-hash");
    assert.equal(data.ow_projects_commits[0].author_id, 1);
    assert.equal(data.ow_projects_file.length, 1);
    assert.equal(data.ow_assets[0].usage_count, 2, "project cleanup must preserve shared global asset counters");
    assert.equal(data.ow_assets[0].uploader_id, 1);
    assert.equal(data.ow_projects_history[0].projectid, 22);
    assert.equal(data.ow_user_roles[0].target_id, "22");
    assert.equal(data.ow_project_collaboration_invitations[0].project_id, 22);
    assert.equal(data.ow_projects_lists.length, 1);
    assert.equal(data.ow_projects_list_items[0].projectid, 22);
    assert.deepEqual(data.ow_cache_kv.map(({ key }) => key), ["unrelated", "blog.draft.22"]);
    assert.equal(data.ow_scratch_extensions[0].samples, null);
    assert.equal(data.ow_target_configs[0].target_id, "22");
    assert.equal(data.ow_embeddings[0].entity_id, 22);
    assert.equal(data.ow_users[0].featured_projects, null);
    assert.ok(result.affectedUserIds.includes(2));
});

test("lists delete only their joins, not contained projects or other lists", async () => {
    const { db, data } = fixture({
        ow_projects_lists: [{ id: 10, authorid: 1 }, { id: 20, authorid: 2 }],
        ow_projects_list_items: [{ id: 1, listid: 10, projectid: 30 }, { id: 2, listid: 20, projectid: 30 }],
        ow_projects: [{ id: 30, authorid: 2 }],
    });
    const result = await cleanupUserData(db, 1, ["lists"]);
    assert.equal(result.counts.lists, 1);
    assert.deepEqual(data.ow_projects_lists, [{ id: 20, authorid: 2 }]);
    assert.equal(data.ow_projects_list_items[0].listid, 20);
    assert.equal(data.ow_projects.length, 1);
});

test("comments use verified account authors and preserve unverified imported identities and others' replies", async () => {
    const { db, data } = fixture({
        ow_comment: [{ id: 10, user_id: 1 }, { id: 11, user_id: 2, pid: 10, rid: 99, text: "keep reply" }, { id: 12, user_id: 2, pid: 99, rid: 10 }],
        ow_comment_service: [
            { id: 20, space_id: 5, user_id: "1", account_user_id: 1 },
            { id: 21, space_id: 5, user_id: "2", pid: "20", rid: "99", comment: "keep" },
            { id: 22, space_id: 5, user_id: "01", pid: "99", rid: "20" },
            { id: 23, space_id: 5, user_id: null, mail: "same@example.com" },
        ],
        ow_comment_spaces: [{ id: 5, owner_id: 1 }],
        ow_comment_service_counter: [{ id: 1, space_id: 5, time: 7, reaction0: 8 }],
        ow_comment_service_users: [{ id: 1, user_id: 1, space_id: 5 }],
    });
    const result = await cleanupUserData(db, 1, ["comments"]);
    assert.equal(result.counts.comments, 2);
    assert.deepEqual(data.ow_comment[0], { id: 11, user_id: 2, pid: null, rid: 99, text: "keep reply" });
    assert.equal(data.ow_comment[1].pid, 99);
    assert.equal(data.ow_comment[1].rid, null);
    assert.equal(data.ow_comment_service[0].pid, null);
    assert.equal(data.ow_comment_service[0].rid, "99");
    assert.equal(data.ow_comment_service[1].user_id, "01");
    assert.equal(data.ow_comment_service[1].pid, "99");
    assert.equal(data.ow_comment_service[1].rid, null);
    assert.equal(data.ow_comment_service[2].mail, "same@example.com");
    assert.equal(data.ow_comment_spaces.length, 1);
    assert.equal(data.ow_comment_service_counter[0].reaction0, 8);
    assert.equal(data.ow_comment_service_users.length, 1);
});

test("comment spaces require explicit confirmation, including permanent deletion, and delete only selected spaces' visitor content", async () => {
    const seed = {
        ow_comment_spaces: [{ id: 5, cuid: "owned", owner_id: 1 }, { id: 6, cuid: "other", owner_id: 2 }],
        ow_comment_service: [{ id: 1, space_id: 5, user_id: "2" }, { id: 2, space_id: 6, user_id: "2", pid: "1", rid: "99" }],
        ow_comment_service_users: [{ id: 1, space_id: 5, user_id: 2 }, { id: 2, space_id: 6, user_id: 2 }],
        ow_comment_service_counter: [{ id: 1, space_id: 5 }, { id: 2, space_id: 6 }],
        ow_target_configs: [{ id: 1, target_type: "comment_space", target_id: "owned" }, { id: 2, target_type: "comment_space", target_id: "other" }],
    };
    for (const options of [{}, { permanent: true }]) {
        const { db, calls } = fixture(seed);
        await assert.rejects(cleanupUserData(db, 1, ["commentSpaces"], options), { code: "COMMENT_SPACES_CONFIRMATION_REQUIRED" });
        assert.equal(writes(calls).length, 0);
    }
    const { db, data } = fixture(seed);
    const result = await cleanupUserData(db, 1, ["commentSpaces"], { confirmCommentSpaces: true });
    assert.equal(result.counts.commentSpaces, 1);
    assert.equal(data.ow_comment_service[0].space_id, 6);
    assert.equal(data.ow_comment_service[0].pid, null);
    assert.equal(data.ow_comment_service[0].rid, "99");
    assert.equal(data.ow_comment_service_users[0].space_id, 6);
    assert.equal(data.ow_comment_service_counter[0].space_id, 6);
    assert.equal(data.ow_target_configs[0].target_id, "other");
});

test("interactions remove outgoing records only and recompute surviving post/project counts", async () => {
    const { db, data } = fixture({
        ow_posts: [post(10, 2)],
        ow_posts_like: [{ id: 1, user_id: 1, post_id: 10 }, { id: 2, user_id: 2, post_id: 10 }],
        ow_posts_bookmark: [{ id: 1, user_id: 1, post_id: 10 }],
        ow_projects: [{ id: 20, authorid: 2, star_count: 99 }],
        ow_projects_stars: [{ id: 1, userid: 1, projectid: 20 }, { id: 2, userid: 2, projectid: 20 }],
        ow_user_relationships: [{ id: 1, source_user_id: 1, target_user_id: 2 }, { id: 2, source_user_id: 2, target_user_id: 1 }],
        ow_tokens: [{ id: 1, user_id: 1 }],
    });
    const result = await cleanupUserData(db, 1, ["interactions"]);
    assert.equal(result.counts.interactions, 4);
    assert.equal(data.ow_posts[0].like_count, 1);
    assert.equal(data.ow_posts[0].bookmark_count, 0);
    assert.equal(data.ow_projects[0].star_count, 1);
    assert.equal(data.ow_user_relationships[0].source_user_id, 2);
    assert.equal(data.ow_tokens.length, 1);
});

test("post reconciliation batches counts and preserves quote/retweet distinctions", async () => {
    const { db, data, calls } = fixture({
        ow_posts: [post(10, 2), post(20, 2),
            post(30, 3, { post_type: "retweet", retweet_post_id: 10, quoted_post_id: 20 }),
            post(31, 3, { post_type: "quote", quoted_post_id: 10 }),
            post(32, 3, { post_type: "reply", in_reply_to_id: 20 }),
            post(33, 3, { post_type: "quote", quoted_post_id: 20, is_deleted: true })],
        ow_posts_like: [{ id: 1, user_id: 1, post_id: 10 }, { id: 2, user_id: 1, post_id: 20 }],
    });
    await cleanupUserData(db, 1, ["interactions"]);
    assert.equal(data.ow_posts[0].retweet_count, 2);
    assert.equal(data.ow_posts[1].retweet_count, 0);
    assert.equal(data.ow_posts[1].reply_count, 1);
    assert.equal(calls.filter(call => call.method === "groupBy").length, 4);
    assert.equal(calls.some(call => call.method === "count" && call.where?.in_reply_to_id !== undefined), false);
});

test("post plus interaction cleanup reconciles the final combined graph", async () => {
    const { db, data } = fixture({
        ow_posts: [post(1, 1, { in_reply_to_id: 2 }), post(2, 2)],
        ow_posts_like: [{ id: 1, user_id: 1, post_id: 2 }, { id: 2, user_id: 3, post_id: 2 }],
        ow_posts_bookmark: [{ id: 1, user_id: 1, post_id: 2 }],
    });
    await cleanupUserData(db, 1, ["posts", "interactions"]);
    assert.deepEqual([data.ow_posts[0].reply_count, data.ow_posts[0].like_count, data.ow_posts[0].bookmark_count], [0, 1, 0]);
});

test("permanent cleanup deletes legacy/app third-party credentials, anonymizes shared history, and leaves user final deletion to caller", async () => {
    const { db, data, calls } = fixture({
        ow_users: [{ id: 1 }, { id: 2 }],
        ow_oauth_applications: [{ id: 10, owner_id: 1 }, { id: 20, owner_id: 2 }],
        ow_oauth_authorizations: [{ id: 100, application_id: 10, user_id: 2 }, { id: 200, application_id: 20, user_id: 1 }, { id: 300, application_id: 20, user_id: 2 }],
        ow_tokens: [
            { id: 1, user_id: 1, application_id: 20, authorization_id: 200, token_hash: "own", refresh_token_hash: "refresh-own" },
            { id: 2, user_id: 2, application_id: 10, authorization_id: 100, token_hash: "third-party", refresh_token_hash: "refresh-other" },
            { id: 3, user_id: 2, application_id: null, authorization_id: 100, token_hash: "grant-only", refresh_token_hash: null },
            { id: 4, user_id: 2, application_id: 20, authorization_id: 300, token_hash: "keep", refresh_token_hash: "keep-r" },
        ],
        ow_oauth_access_tokens: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2, application_id: 10 }, { id: 3, user_id: 2, authorization_id: 100 }, { id: 4, user_id: 2, application_id: 20, authorization_id: 300 }],
        ow_users_contacts: [{ contact_id: 1, user_id: 1, contact_type: "passkey", contact_value: "secret" }, { contact_id: 2, user_id: 2 }],
        ow_users_totp: [{ id: 1, user_id: 1 }],
        ow_users_magiclink: [{ id: 1, userId: 1 }],
        ow_push_subscriptions: [{ id: 1, user_id: 1 }],
        ow_projects_commits: [{ id: "shared", author_id: 1, project_id: 20 }],
        ow_projects_file: [{ sha256: "shared", create_userid: 1 }],
        ow_projects_branch: [{ id: 1, projectid: 20, creator: 1 }],
        ow_projects_history: [{ id: 1, projectid: 20, authorid: 1 }],
        project_clouddata_history: [{ id: 1, project_id: 20, actor_id: 1, actor_name: "name", ip: "127.0.0.1" }],
        ow_assets: [{ id: 1, uploader_id: 1, uploader_ip: "ip", uploader_ua: "ua", banned_by: 1 }],
        ow_analytics_device: [{ id: 1, user_id: 1 }],
        ow_analytics_event: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2, device_id: 1 }],
        ow_notifications: [{ id: 1, user_id: 1 }, { id: 2, user_id: 2, actor_id: 1 }, { id: 3, user_id: 2 }],
        ow_events: [{ id: 1, actor_id: 1 }, { id: 2, actor_id: 2 }],
        ow_user_relationships: [{ id: 1, source_user_id: 2, target_user_id: 1 }],
        ow_user_roles: [{ id: 1, user_id: 2, assigned_by: 1, target_type: "project", target_id: "20" }],
        ow_target_configs: [
            { id: 1, target_type: "user", target_id: "1", key: "social.atproto.auth.did", value: "did:owned" },
            { id: 2, target_type: "atproto_auth_session", target_id: "did:owned", key: "session", value: "secret" },
            { id: 3, target_type: "user", target_id: "2", key: "keep", value: "keep" },
        ],
    });
    const result = await cleanupUserData(db, 1, undefined, { permanent: true });
    assert.equal(result.tokenCacheRecords.length, 3);
    assert.deepEqual(result.tokenCacheRecords[1], { token_hash: "third-party", refresh_token_hash: "refresh-other" });
    assert.deepEqual(data.ow_tokens.map(({ id }) => id), [4]);
    assert.deepEqual(data.ow_oauth_access_tokens.map(({ id }) => id), [4]);
    assert.deepEqual(data.ow_oauth_authorizations.map(({ id }) => id), [300]);
    assert.deepEqual(data.ow_oauth_applications.map(({ id }) => id), [20]);
    assert.equal(data.ow_users.length, 2);
    assert.equal(data.ow_users_contacts[0].user_id, 2);
    for (const model of ["ow_users_totp", "ow_users_magiclink", "ow_push_subscriptions", "ow_analytics_device", "ow_user_relationships"]) assert.equal(data[model].length, 0, model);
    assert.equal(data.ow_projects_commits[0].author_id, null);
    assert.equal(data.ow_projects_file[0].create_userid, null);
    assert.equal(data.ow_projects_branch[0].creator, null);
    assert.equal(data.ow_projects_history[0].authorid, 0);
    assert.equal(data.project_clouddata_history[0].actor_name, null);
    assert.equal(data.ow_assets[0].uploader_id, null);
    assert.equal(data.ow_assets[0].uploader_ip, null);
    assert.equal(data.ow_assets[0].banned_by, null);
    assert.equal(data.ow_user_roles[0].assigned_by, null);
    assert.equal(data.ow_analytics_event[0].user_id, 2);
    assert.equal(data.ow_analytics_event[0].device_id, null);
    assert.equal(data.ow_target_configs[0].target_id, "2");
    assert.ok(!JSON.stringify(result.counts).includes("third-party"));
    assert.ok(!writes(calls).some(({ model, method }) => model === "ow_users" && method === "deleteMany"));
});

test("preview has exact UI category contract and secondary OAuth/visitor impact without credentials", async () => {
    const { db, calls } = fixture({
        ow_posts: [post(1, 1, { is_deleted: true })],
        ow_comment_spaces: [{ id: 5, owner_id: 1 }],
        ow_comment_service: [{ id: 1, space_id: 5, user_id: "1", account_user_id: 1 }, { id: 2, space_id: 5, user_id: "2" }, { id: 3, space_id: 5, user_id: null }],
        ow_tokens: [{ id: 1, user_id: 1, token_hash: "secret-own" }, { id: 2, user_id: 2, application_id: 10, token_hash: "secret-other" }],
        ow_oauth_applications: [{ id: 10, owner_id: 1, client_secret: "secret-app" }],
        ow_oauth_authorizations: [{ id: 1, user_id: 2, application_id: 10, code: "secret-code" }],
    });
    const result = await getUserDataSummary(db, 1);
    assert.deepEqual(result.categories.map(({ key }) => key), USER_DATA_CATEGORY_KEYS);
    assert.equal(result.categories.find(({ key }) => key === "posts").count, 1);
    assert.equal(result.categories.find(({ key }) => key === "commentSpaces").dangerous, true);
    assert.equal(result.account.tokens, 1);
    assert.equal(result.account.oauthApplications, 1);
    assert.equal(result.account.oauthAuthorizations, 1);
    assert.equal(result.account.affectedTokens, 2);
    assert.equal(result.account.thirdPartyTokens, 1);
    assert.equal(result.account.commentSpaceComments, 3);
    assert.equal(result.account.commentSpaceVisitors, 2);
    assert.ok(!JSON.stringify(result).includes("secret"));
    assert.ok(!calls.some(({ select }) => select && Object.keys(select).some((key) => /hash|secret|code|token$/.test(key))));
    assert.equal(writes(calls).length, 0);
});

test("bounded snapshots fail explicitly before deletion and chunked IN queries stay bounded", async () => {
    const large = fixture({ ow_posts: Array.from({ length: CLEANUP_LIMITS.ids + 1 }, (_, id) => post(id + 1, 1)) });
    await assert.rejects(cleanupUserData(large.db, 1, ["posts"]), { code: "CLEANUP_LIMIT_EXCEEDED" });
    assert.equal(writes(large.calls).length, 0);
    const small = fixture({ ow_projects_lists: Array.from({ length: CLEANUP_LIMITS.chunk + 1 }, (_, id) => ({ id: id + 1, authorid: 1 })) });
    const result = await cleanupUserData(small.db, 1, ["lists"]);
    assert.equal(result.counts.lists, CLEANUP_LIMITS.chunk + 1);
    const deletions = small.calls.filter(({ model, method }) => model === "ow_projects_lists" && method === "deleteMany");
    assert.equal(deletions.length, 2);
    assert.ok(deletions.every(({ where }) => where.id.in.length <= CLEANUP_LIMITS.chunk));
});

test("empty cleanup is repeatable and database failures propagate for caller rollback", async () => {
    const { db, calls } = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await cleanupUserData(db, 1, USER_DATA_CATEGORY_KEYS, { confirmCommentSpaces: true });
        assert.ok(Object.values(result.counts).every((count) => count === 0));
    }
    const failure = new Error("simulated database failure");
    const failed = new Proxy(db, {
        get(target, model) {
            if (model !== "ow_posts_like") return target[model];
            return { ...target[model], deleteMany: async () => { throw failure; } };
        },
    });
    await assert.rejects(cleanupUserData(failed, 1, ["interactions"]), (error) => error === failure);
    assert.ok(calls.length > 0);
});
