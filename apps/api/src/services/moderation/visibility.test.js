import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { empty, join, raw, sqltag } from "@prisma/client/runtime/client";

const url = path => new URL(path, import.meta.url).href;
const state = {};
const db = {
    ow_posts: { async findUnique({ where }) { return state.posts.get(where.id) || null; } },
    ow_projects: { async findUnique({ where }) { return state.projects.get(where.id) || null; } },
    ow_projects_lists: { async findUnique({ where }) { return state.lists.get(where.id) || null; } },
    ow_user_roles: { async findMany() { return state.roles; } },
    ow_user_permissions: { async findMany() { return state.permissions; } },
    ow_user_restrictions: {
        async findMany() { state.ownerReads++; return state.hidden.map(user_id => ({ user_id })); },
        async findFirst({ where }) { state.restrictionReads.push(where); return state.hidden.includes(where.user_id) ? { id: 1 } : null; },
    },
};
mock.module(url("../../../generated/prisma/client.ts"), { namedExports: { Prisma: { empty, join, raw, sql: sqltag } } });
mock.module(url("../prisma.js"), { namedExports: { prisma: db } });
mock.module(url("./restrictions.js"), { namedExports: {
    assertCanWrite: async () => {},
    activeRestrictionWhere: (type, category, now) => ({ type, category, now }),
} });
mock.module(url("../auth/policyEngine.js"), { namedExports: {
    getUserPolicy: async (_id, options) => options.targetId ? { candidate: Number(options.targetId) } : { sources: state.sources },
    getUserResourcePolicies: async () => new Map(state.allowed.map(candidate => [candidate, { candidate }])),
    resourcePolicyAllowsScope: policy => state.allowed.includes(policy.candidate),
} });
const { visibleWhere, visibleSql, canViewContent, sanitizeProfiles } = await import("./visibility.js");
const post = (id, owner, extra = {}) => ({ id, author_id: owner, post_type: "normal", is_deleted: false, deleted_at: null, is_shadowbanned: false, ...extra });
const project = (id, owner, extra = {}) => ({ id, authorid: owner, state: "public", type: "scratch", deleted_at: null, is_shadowbanned: false, ...extra });
beforeEach(() => Object.assign(state, {
    posts: new Map(), projects: new Map(), lists: new Map(), hidden: [], roles: [], permissions: [], sources: [], allowed: [], restrictionReads: [], ownerReads: 0,
}));

test("author sees shadowban but cannot view deleted content", async () => {
    const item = post(1, 7, { is_shadowbanned: true });
    assert.equal(await canViewContent("post", item, 7), true);
    assert.equal(await canViewContent("post", item, 8), false);
    item.deleted_at = new Date();
    assert.equal(await canViewContent("post", item, 7), false);
});

test("retweet author cannot expose another author's hidden or deleted source", async () => {
    const item = post(1, 7, { post_type: "retweet", retweet_post_id: 2 });
    state.posts.set(2, post(2, 8, { is_shadowbanned: true }));
    assert.equal(await canViewContent("post", item, 7), false);
    state.posts.set(2, post(2, 8));
    assert.equal(await canViewContent("post", item, 7), true);
    state.posts.get(2).is_deleted = true;
    assert.equal(await canViewContent("post", item, 7), false);
});

test("retweet chains, cycles and missing source fail closed", async () => {
    const item = post(1, 7, { post_type: "retweet", retweet_post_id: 1 });
    state.posts.set(1, item);
    assert.equal(await canViewContent("post", item, 7), false);
    item.retweet_post_id = 99;
    assert.equal(await canViewContent("post", item, 7), false);
});

test("lean post and private list projections reload governance fields", async () => {
    state.posts.set(1, post(1, 7, { is_deleted: true }));
    assert.equal(await canViewContent("post", { id: 1 }, 7), false);
    state.lists.set(2, { id: 2, authorid: 9, state: "private" });
    assert.equal(await canViewContent("list", { id: 2 }, 7), false);
    assert.equal(await canViewContent("list", { id: 2 }, 9), true);
});

test("privacy bypass preserves actual viewer shadowban rules", async () => {
    const item = project(1, 9, { state: "private" });
    assert.equal(await canViewContent("project", item, 7), false);
    assert.equal(await canViewContent("project", item, 7, { ignorePrivacy: true }), true);
    state.hidden = [9];
    assert.equal(await canViewContent("project", item, 7, { ignorePrivacy: true }), false);
});

test("article and category override use current selected restriction categories", async () => {
    await canViewContent("project", project(1, 7, { type: "article" }), 8);
    assert.deepEqual(state.restrictionReads.at(-1).categories.hasSome, ["*", "projects", "blog"]);
    await canViewContent("profile", { id: 7 }, 8, { category: "relations" });
    assert.deepEqual(state.restrictionReads.at(-1).categories.hasSome, ["*", "relations"]);
});

test("account shadowban filters required owners without null and retains nullable authors", async () => {
    state.hidden = [7];
    const postWhere = await visibleWhere("post");
    assert.deepEqual(postWhere.AND[2], { author_id: { notIn: [7] } });
    assert.deepEqual(await visibleWhere("profile"), { AND: [{ id: { notIn: [7] } }] });
    for (const [kind, owner] of [
        ["comment", "user_id"], ["comment_service", "account_user_id"], ["list", "authorid"],
        ["activity", "actor_id"], ["relation", "source_user_id"], ["asset", "uploader_id"],
    ]) {
        const where = await visibleWhere(kind, null, { ignorePrivacy: true });
        assert.deepEqual(where.AND[0], { OR: [{ [owner]: null }, { [owner]: { notIn: [7] } }] });
    }
    const projectWhere = await visibleWhere("project", null, { ignorePrivacy: true });
    assert.deepEqual(projectWhere.AND[2].OR[0].AND[1], { OR: [{ authorid: null }, { authorid: { notIn: [7] } }] });
    const relationWhere = await visibleWhere("relation");
    assert.deepEqual(relationWhere.AND[1], { OR: [{ target_user_id: null }, { target_user_id: { notIn: [7] } }] });
    assert.deepEqual((await visibleWhere("post", 7)).AND[2], {});
});

test("private concrete global scope candidates are checked with targeted deny policy", async () => {
    state.sources = [{ effect: "allow", scope: "project:12:read" }, { effect: "allow", scope: "project:13:read" }];
    state.allowed = [12];
    const where = await visibleWhere("project", 7);
    assert.deepEqual(where.AND[0].OR.at(-1), { id: { in: [12] } });
    const sql = await visibleSql("project", "p", 7);
    assert.ok(sql.values.includes(12));
    assert.equal(sql.values.includes(13), false);
});

test("retweet visibility shares one owner query per call and rereads newly hidden owners", async () => {
    const first = await visibleWhere("post");
    assert.equal(state.ownerReads, 1);
    assert.deepEqual(first.AND[2], {});
    state.hidden = [8];
    const second = await visibleWhere("post");
    assert.equal(state.ownerReads, 2);
    assert.deepEqual(second.AND[2], { author_id: { notIn: [8] } });
    assert.deepEqual(second.AND.at(-1).OR[1].retweet_post.is.AND[2], { author_id: { notIn: [8] } });
});

test("profile pages batch restrictions, preserve positions and reread revocations", async () => {
    const users = [{ id: 7 }, { id: 8 }, { id: 8 }, null, { id: 9, is_shadowbanned: true }, { id: 7, deleted_at: new Date() }];
    state.hidden = [7, 8];
    assert.deepEqual(await sanitizeProfiles(users, 7), [users[0], null, null, null, null, null]);
    assert.equal(state.ownerReads, 1);
    state.hidden = [];
    assert.deepEqual(await sanitizeProfiles(users, 7), [users[0], users[1], users[2], null, null, null]);
    assert.equal(state.ownerReads, 2);
    assert.deepEqual(await sanitizeProfiles([users[0], null], 7), [users[0], null]);
    assert.equal(state.ownerReads, 2);
    assert.deepEqual(await sanitizeProfiles(users, 7, { review: true, reviewAuthorized: true }), users);
});

test("review bypass requires both explicit authorized flags in all helpers", async () => {
    const item = post(1, 7, { is_deleted: true });
    assert.equal(await canViewContent("post", item, 8, { review: true }), false);
    assert.equal(await canViewContent("post", item, 8, { review: true, reviewAuthorized: true }), true);
    assert.deepEqual(await visibleWhere("post", 8, { review: true, reviewAuthorized: true }), {});
    assert.equal((await visibleSql("post", "p", 8, { review: true, reviewAuthorized: true })).text, "TRUE");
});

test("SQL stays parameterized and retweet source filter matches where guard", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const where = await visibleWhere("post", 7, { now });
    const source = where.AND.at(-1).OR[1].retweet_post.is;
    assert.deepEqual(source.AND.at(-1), { post_type: { not: "retweet" } });
    const sql = await visibleSql("post", "p", 7, { now });
    assert.match(sql.text, /EXISTS \(SELECT 1 FROM "ow_posts" vrs/);
    assert.match(sql.text, /"vrs"\."post_type" <> 'retweet'/);
    assert.ok(sql.values.includes(now));
    assert.equal(sql.text.includes(now.toISOString()), false);
    await assert.rejects(visibleSql("post", 'p"; DROP TABLE posts', 7), /Invalid SQL alias/);
});
