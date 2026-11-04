/**
 * Database-only cleanup. The caller owns the transaction, authorization and all
 * post-commit cache work. Never catch an error and commit this transaction.
 * Shared commits, CAS files, assets and external social copies are not deleted.
 */
export const USER_DATA_CATEGORIES = Object.freeze([
    { key: "posts", label: "帖子", description: "本人帖子、回复、引用、转发及附件关系（含软删记录）", dangerous: false },
    { key: "projects", label: "项目（含文章）", description: "本人拥有的项目、文章、草稿及专属关系，不删除他人的 fork 或共享提交和文件", dangerous: false },
    { key: "lists", label: "收藏夹", description: "本人收藏夹及列表项，不删除收录项目", dangerous: false },
    { key: "comments", label: "评论", description: "准确归属本人的旧评论和评论服务内容，保留他人回复", dangerous: false },
    { key: "interactions", label: "互动记录", description: "本人发起的关注、屏蔽、静音、点赞、书签及项目收藏", dangerous: false },
    { key: "commentSpaces", label: "评论空间", description: "本人空间及其中全部访客评论、用户映射和页面计数", dangerous: true },
]);
export const USER_DATA_CATEGORY_KEYS = Object.freeze(USER_DATA_CATEGORIES.map(({ key }) => key));
export const CLEANUP_LIMITS = Object.freeze({ ids: 5000, chunk: 250, queries: 2000, rows: 100000, milliseconds: 20000 });

export class UserDataCleanupError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.name = "UserDataCleanupError";
        this.code = code;
        this.status = statusCode;
        this.statusCode = statusCode;
    }
}

function checkUserId(userId) {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new UserDataCleanupError("INVALID_USER_ID", "无效的用户 ID");
    }
}

function normalizeCategories(categories, permanent) {
    if ((!permanent || categories !== undefined) && (!Array.isArray(categories) || categories.some((key) => !USER_DATA_CATEGORY_KEYS.includes(key)))) {
        throw new UserDataCleanupError("INVALID_CLEANUP_CATEGORIES", "包含不支持的清理类别");
    }
    const selected = new Set(permanent ? USER_DATA_CATEGORY_KEYS : categories);
    if (selected.size === 0) {
        throw new UserDataCleanupError("INVALID_CLEANUP_CATEGORIES", "请至少选择一个清理类别");
    }
    return selected;
}

function chunks(values) {
    const result = [];
    for (let start = 0; start < values.length; start += CLEANUP_LIMITS.chunk) {
        result.push(values.slice(start, start + CLEANUP_LIMITS.chunk));
    }
    return result;
}

function bounded(values) {
    const ids = [...new Set(values.filter((value) => value !== null && value !== undefined))];
    if (ids.length > CLEANUP_LIMITS.ids) {
        throw new UserDataCleanupError("CLEANUP_LIMIT_EXCEEDED", "数据量超过单次清理上限，请联系管理员分批处理", 409);
    }
    return ids;
}

function database(db) {
    const started = Date.now();
    let queries = 0;
    let changedRows = 0;
    function check() {
        if (++queries > CLEANUP_LIMITS.queries || Date.now() - started > CLEANUP_LIMITS.milliseconds) {
            throw new UserDataCleanupError("CLEANUP_BUDGET_EXCEEDED", "清理超过事务预算，请联系管理员分批处理", 409);
        }
    }
    async function call(model, method, args) {
        check();
        return db[model][method](args);
    }
    return {
        call,
        count: (model, where) => call(model, "count", { where }),
        async read(model, where, select) {
            const rows = await call(model, "findMany", { where, select, take: CLEANUP_LIMITS.ids + 1 });
            if (rows.length > CLEANUP_LIMITS.ids) bounded(rows.map((_, index) => index));
            return rows;
        },
        async mutate(model, method, where, data) {
            // Preflight each set before writing; a caller-owned transaction rolls
            // back earlier writes if a later dependency exceeds the budget.
            const count = await call(model, "count", { where });
            changedRows += count;
            if (changedRows > CLEANUP_LIMITS.rows) {
                throw new UserDataCleanupError("CLEANUP_LIMIT_EXCEEDED", "关联数据量超过单次清理上限", 409);
            }
            const args = { where };
            if (data !== undefined) args.data = data;
            return (await call(model, method, args)).count;
        },
    };
}

async function forIds(ids, callback) {
    for (const batch of chunks(bounded(ids))) await callback(batch);
}

const idsOf = (rows, field = "id") => bounded(rows.map((row) => row[field]));
const target = (types, ids) => ({ target_type: { in: types }, target_id: { in: ids.map(String) } });
const entity = (type, ids) => ({ entity_type: type, entity_id: { in: ids } });

async function ownedApplications(db, userId) {
    return idsOf(await db.read("ow_oauth_applications", { owner_id: userId }, { id: true }));
}

async function authorizationIds(db, userId, applicationIds) {
    const rows = await db.read("ow_oauth_authorizations", { user_id: userId }, { id: true });
    await forIds(applicationIds, async (batch) => {
        rows.push(...await db.read("ow_oauth_authorizations", { application_id: { in: batch } }, { id: true }));
    });
    return idsOf(rows);
}

async function credentialRows(db, model, userId, applicationIds, grantIds, select) {
    const rows = new Map();
    const add = async (where) => {
        for (const row of await db.read(model, where, { id: true, ...select })) rows.set(row.id, row);
        bounded([...rows.keys()]);
    };
    await add({ user_id: userId });
    await forIds(applicationIds, (batch) => add({ application_id: { in: batch } }));
    await forIds(grantIds, (batch) => add({ authorization_id: { in: batch } }));
    return [...rows.values()];
}

/** Safe preview DTO; no credential columns or arbitrary user metadata. */
export async function getUserDataSummary(client, userId) {
    checkUserId(userId);
    const db = database(client);
    const counts = {};
    counts.posts = await db.count("ow_posts", { author_id: userId });
    counts.projects = await db.count("ow_projects", { authorid: userId });
    counts.lists = await db.count("ow_projects_lists", { authorid: userId });
    const legacyComments = await db.count("ow_comment", { user_id: userId });
    const serviceComments = await db.count("ow_comment_service", { account_user_id: userId });
    counts.comments = legacyComments + serviceComments;
    const relationships = await db.count("ow_user_relationships", { source_user_id: userId });
    const likes = await db.count("ow_posts_like", { user_id: userId });
    const bookmarks = await db.count("ow_posts_bookmark", { user_id: userId });
    const projectStars = await db.count("ow_projects_stars", { userid: userId });
    counts.interactions = relationships + likes + bookmarks + projectStars;
    const spaces = await db.read("ow_comment_spaces", { owner_id: userId }, { id: true });
    counts.commentSpaces = spaces.length;
    let commentSpaceComments = 0;
    let commentSpaceVisitors = 0;
    await forIds(idsOf(spaces), async (batch) => {
        const total = await db.count("ow_comment_service", { space_id: { in: batch } });
        commentSpaceComments += total;
        commentSpaceVisitors += total - await db.count("ow_comment_service", { space_id: { in: batch }, account_user_id: userId });
    });
    const applicationIds = await ownedApplications(db, userId);
    const grantIds = await authorizationIds(db, userId, applicationIds);
    const oauthTokens = await credentialRows(db, "ow_tokens", userId, applicationIds, grantIds, { user_id: true });
    const legacyTokens = await credentialRows(db, "ow_oauth_access_tokens", userId, applicationIds, grantIds, {});
    return {
        categories: USER_DATA_CATEGORIES.map((category) => ({ ...category, count: counts[category.key] })),
        account: {
            tokens: oauthTokens.filter((row) => row.user_id === userId).length,
            contacts: await db.count("ow_users_contacts", { user_id: userId }),
            oauthApplications: applicationIds.length,
            oauthAuthorizations: grantIds.length,
            affectedTokens: oauthTokens.length,
            thirdPartyTokens: oauthTokens.filter((row) => row.user_id !== userId).length,
            legacyOauthTokens: legacyTokens.length,
            commentSpaceComments,
            commentSpaceVisitors,
            totp: await db.count("ow_users_totp", { user_id: userId }),
            magicLinks: await db.count("ow_users_magiclink", { userId }),
            pushSubscriptions: await db.count("ow_push_subscriptions", { user_id: userId }),
        },
        details: { legacyComments, serviceComments, relationships, likes, bookmarks, projectStars },
        limitations: ["共享提交、文件、素材及物理存储保留", "他人的 fork 和评论回复保留", "不保证删除外部社交平台副本"],
    };
}

async function reconcilePosts(db, ids) {
    await forIds(ids, async (batch) => {
        const survivors = await db.read("ow_posts", { id: { in: batch } }, {
            id: true, reply_count: true, retweet_count: true, like_count: true, bookmark_count: true,
        });
        if (!survivors.length) return;
        const ids = survivors.map(post => post.id);
        const countBy = async (model, field, where) => new Map((await db.call(model, "groupBy", {
            by: [field], where, _count: { _all: true },
        })).map(row => [row[field], row._count._all]));
        const replies = await countBy("ow_posts", "in_reply_to_id", { in_reply_to_id: { in: ids }, is_deleted: false });
        const reposts = await db.call("ow_posts", "groupBy", {
            by: ["post_type", "retweet_post_id", "quoted_post_id"],
            where: { is_deleted: false, OR: [
                { retweet_post_id: { in: ids }, post_type: "retweet" },
                { quoted_post_id: { in: ids }, post_type: "quote" },
            ] },
            _count: { _all: true },
        });
        const retweets = new Map();
        for (const row of reposts) {
            const id = row.post_type === "retweet" ? row.retweet_post_id : row.quoted_post_id;
            retweets.set(id, (retweets.get(id) || 0) + row._count._all);
        }
        const likes = await countBy("ow_posts_like", "post_id", { post_id: { in: ids } });
        const bookmarks = await countBy("ow_posts_bookmark", "post_id", { post_id: { in: ids } });
        for (const post of survivors) {
            const data = { reply_count: replies.get(post.id) || 0, retweet_count: retweets.get(post.id) || 0,
                like_count: likes.get(post.id) || 0, bookmark_count: bookmarks.get(post.id) || 0 };
            if (Object.entries(data).some(([field, count]) => post[field] !== count)) {
                await db.call("ow_posts", "updateMany", { where: { id: post.id }, data });
            }
        }
    });
}

/**
 * @returns {Promise<{counts: object, postIds: number[], projectIds: number[], tokenCacheRecords: object[]}>}
 * tokenCacheRecords is INTERNAL ONLY: the service must remove it from HTTP DTOs.
 * Permanent deletion includes every category and still requires space confirmation.
 * The user row is deliberately left for the caller's final transaction statement.
 */
export async function cleanupUserData(client, userId, categories, { permanent = false, confirmCommentSpaces = false } = {}) {
    checkUserId(userId);
    const selected = normalizeCategories(categories, permanent);
    if (selected.has("commentSpaces") && confirmCommentSpaces !== true) {
        const hasSpaces = await client.ow_comment_spaces.count({ where: { owner_id: userId } });
        if (!permanent || hasSpaces > 0) {
            throw new UserDataCleanupError("COMMENT_SPACES_CONFIRMATION_REQUIRED", "删除评论空间会删除访客内容，请单独确认");
        }
    }
    const db = database(client);
    const counts = Object.fromEntries(USER_DATA_CATEGORY_KEYS.map((key) => [key, 0]));
    const dependencies = {};
    const result = { counts, dependencies, postIds: [], projectIds: [], listIds: [], commentSpaceIds: [], commentSpaceCuids: [], tokenCacheRecords: [], affectedPostIds: [], affectedProjectIds: [], assetIds: [], affectedUserIds: [userId] };
    const affectedPosts = new Set();
    const affectedProjects = new Set();
    const assets = new Set();
    const remove = async (model, where) => {
        const count = await db.mutate(model, "deleteMany", where);
        dependencies[model] = (dependencies[model] || 0) + count;
        return count;
    };
    const update = (model, where, data) => db.mutate(model, "updateMany", where, data);
    const removeIds = (model, field, ids) => forIds(ids, (batch) => remove(model, { [field]: { in: batch } }));
    const removeTargetData = async (types, ids, entityType) => {
        await forIds(ids, async (batch) => {
            await remove("ow_target_configs", target(types, batch));
            const resourceTypes = entityType === "project" ? ["project", "blog"] : types;
            for (const model of ["ow_user_roles", "ow_user_permissions", "ow_permission_delegations"]) {
                await remove(model, target(resourceTypes, batch));
            }
            if (entityType) await remove("ow_embeddings", entity(entityType, batch));
        });
    };

    if (selected.has("posts")) {
        const rows = await db.read("ow_posts", { author_id: userId }, {
            id: true, in_reply_to_id: true, thread_root_id: true, quoted_post_id: true, retweet_post_id: true,
        });
        result.postIds = idsOf(rows);
        for (const row of rows) {
            for (const field of ["in_reply_to_id", "thread_root_id", "quoted_post_id", "retweet_post_id"]) {
                if (row[field] != null) affectedPosts.add(row[field]);
            }
        }
        await forIds(result.postIds, async (batch) => {
            for (const field of ["in_reply_to_id", "thread_root_id", "quoted_post_id", "retweet_post_id"]) {
                // Includes internal references: otherwise Restrict can reject a
                // multi-row delete even when both endpoints are selected.
                const referencing = await db.read("ow_posts", { [field]: { in: batch } }, { id: true });
                for (const { id } of referencing) affectedPosts.add(id);
                await update("ow_posts", { [field]: { in: batch } }, { [field]: null });
            }
            for (const { asset_id } of await db.read("ow_posts_media", { post_id: { in: batch } }, { asset_id: true })) {
                if (asset_id != null) assets.add(asset_id);
            }
            for (const model of ["ow_posts_media", "ow_posts_mention", "ow_posts_like", "ow_posts_bookmark"]) {
                await remove(model, { post_id: { in: batch } });
            }
            await remove("ow_notifications", { target_type: "post", target_id: { in: batch } });
            await remove("ow_events", { target_type: "post", target_id: { in: batch } });
            await remove("ow_analytics_event", { target_type: "post", target_id: { in: batch } });
            counts.posts += await remove("ow_posts", { author_id: userId, id: { in: batch } });
        });
        await removeTargetData(["post", "ap_remote_post"], result.postIds, "post");
    }

    if (selected.has("projects")) {
        result.projectIds = idsOf(await db.read("ow_projects", { authorid: userId }, { id: true }));
        await forIds(result.projectIds, async (batch) => {
            for (const { user_id } of await db.read("ow_user_roles", target(["project"], batch), { user_id: true })) {
                result.affectedUserIds.push(user_id);
            }
            for (const { asset_id } of await db.read("ow_projects_assets", { project_id: { in: batch } }, { asset_id: true })) {
                if (asset_id != null) assets.add(asset_id);
            }
            for (const model of ["ow_projects_branch", "ow_projects_tags", "ow_projects_stars", "ow_projects_list_items"]) {
                await remove(model, { projectid: { in: batch } });
            }
            await remove("ow_projects_assets", { project_id: { in: batch } });
            await remove("ow_project_collaboration_invitations", { project_id: { in: batch } });
            await remove("ow_user_roles", target(["project"], batch));
            await remove("ow_notification_settings", target(["PROJECT"], batch));
            await remove("project_clouddata_history", { project_id: { in: batch } });
            await remove("ow_projects_history", { projectid: { in: batch } });
            await remove("ow_cache_kv", { key: { in: batch.flatMap((id) => [`blog.draft.${id}`, `scratch:cloud:${id}:vars`]) } });
            await remove("ow_scratch_extensions", { projectid: { in: batch } });
            await update("ow_scratch_extensions", { samples: { in: batch } }, { samples: null });
            await update("ow_projects", { fork: { in: batch } }, { fork: null });
            await update("ow_users", { featured_projects: { in: batch } }, { featured_projects: null });
            for (const model of ["ow_notifications", "ow_events", "ow_analytics_event"]) {
                await remove(model, { target_type: { in: ["project", "scratch_cloud"] }, target_id: { in: batch } });
            }
            counts.projects += await remove("ow_projects", { authorid: userId, id: { in: batch } });
        });
        await removeTargetData(["project", "blog_post", "extension", "mirror40_project"], result.projectIds, "project");
    }

    if (selected.has("lists")) {
        result.listIds = idsOf(await db.read("ow_projects_lists", { authorid: userId }, { id: true }));
        await forIds(result.listIds, async (batch) => {
            await remove("ow_projects_list_items", { listid: { in: batch } });
            counts.lists += await remove("ow_projects_lists", { authorid: userId, id: { in: batch } });
        });
        await removeTargetData(["list"], result.listIds);
    }

    if (selected.has("comments")) {
        const legacy = idsOf(await db.read("ow_comment", { user_id: userId }, { id: true }));
        const service = idsOf(await db.read("ow_comment_service", { account_user_id: userId }, { id: true }));
        for (const [model, ids, stringIds] of [["ow_comment", legacy, false], ["ow_comment_service", service, true]]) {
            await forIds(ids, async (batch) => {
                for (const field of ["pid", "rid"]) {
                    await update(model, { [field]: { in: stringIds ? batch.map(String) : batch } }, { [field]: null });
                }
                counts.comments += await remove(model, { id: { in: batch }, ...(stringIds ? { account_user_id: userId } : { user_id: userId }) });
            });
        }
        // Comment-service page counters represent visits/reactions, not comment
        // totals. They must survive an author's comment-only cleanup.
    }

    if (selected.has("interactions")) {
        for (const model of ["ow_posts_like", "ow_posts_bookmark"]) {
            for (const { post_id } of await db.read(model, { user_id: userId }, { post_id: true })) affectedPosts.add(post_id);
            counts.interactions += await remove(model, { user_id: userId });
        }
        for (const { projectid } of await db.read("ow_projects_stars", { userid: userId }, { projectid: true })) {
            if (projectid != null) affectedProjects.add(projectid);
        }
        counts.interactions += await remove("ow_projects_stars", { userid: userId });
        counts.interactions += await remove("ow_user_relationships", { source_user_id: userId });
    }

    if (selected.has("commentSpaces")) {
        const spaces = await db.read("ow_comment_spaces", { owner_id: userId }, { id: true, cuid: true });
        result.commentSpaceIds = idsOf(spaces);
        result.commentSpaceCuids = idsOf(spaces, "cuid");
        // Detach references to visitor comments too, without deleting replies
        // outside the selected spaces (even malformed cross-space references).
        await forIds(result.commentSpaceIds, async (batch) => {
            const commentIds = idsOf(await db.read("ow_comment_service", { space_id: { in: batch } }, { id: true }));
            await forIds(commentIds, async (comments) => {
                for (const field of ["pid", "rid"]) await update("ow_comment_service", { [field]: { in: comments.map(String) } }, { [field]: null });
            });
            for (const model of ["ow_comment_service", "ow_comment_service_users", "ow_comment_service_counter"]) {
                await remove(model, { space_id: { in: batch } });
            }
            counts.commentSpaces += await remove("ow_comment_spaces", { owner_id: userId, id: { in: batch } });
        });
        await removeTargetData(["comment_space"], result.commentSpaceCuids);
    }

    if (permanent) {
        // These OAuth sessions are keyed by an external DID, not a numeric user
        // ID. Resolve only explicit bindings; never scan values for credentials.
        const didKeys = ["social.atproto.auth.did", "social.atproto.sync.did"];
        const bindings = await db.read("ow_target_configs", {
            target_type: "user", target_id: String(userId), key: { in: didKeys },
        }, { key: true, value: true });
        for (const binding of bindings) {
            const otherBindings = await db.count("ow_target_configs", {
                target_type: "user", target_id: { not: String(userId) },
                key: { in: didKeys }, value: binding.value,
            });
            if (!otherBindings) {
                await remove("ow_target_configs", {
                    target_type: { in: ["atproto_auth_session", "atproto_sync_session"] }, target_id: binding.value,
                });
            }
        }
        const applicationIds = await ownedApplications(db, userId);
        const grantIds = await authorizationIds(db, userId, applicationIds);
        const tokens = await credentialRows(db, "ow_tokens", userId, applicationIds, grantIds, { token_hash: true, refresh_token_hash: true, user_id: true });
        result.tokenCacheRecords = tokens.map(({ token_hash, refresh_token_hash }) => ({ token_hash, refresh_token_hash }));
        result.affectedUserIds.push(...tokens.map(({ user_id }) => user_id));
        const legacyTokens = await credentialRows(db, "ow_oauth_access_tokens", userId, applicationIds, grantIds, {});
        await removeIds("ow_tokens", "id", idsOf(tokens));
        await removeIds("ow_oauth_access_tokens", "id", idsOf(legacyTokens));
        await removeIds("ow_oauth_authorizations", "id", grantIds);
        await removeIds("ow_oauth_applications", "id", applicationIds);
        for (const model of ["ow_users_contacts", "ow_users_totp", "ow_push_subscriptions", "ow_cache_kv", "ow_notification_settings", "ow_user_embedding_updates", "ow_comment_service_users", "ow_posts_mention", "ow_user_roles", "ow_user_permissions", "ow_user_restrictions"]) {
            await remove(model, { user_id: userId });
        }
        await remove("ow_permission_delegations", { OR: [{ grantor_id: userId }, { delegate_id: userId }] });
        await remove("ow_users_magiclink", { userId });
        await remove("ow_project_collaboration_invitations", { OR: [{ inviter_id: userId }, { invitee_id: userId }] });
        await remove("ow_user_relationships", { target_user_id: userId });
        await remove("ow_notifications", { OR: [{ user_id: userId }, { actor_id: userId }, { target_type: "user", target_id: userId }] });
        await remove("ow_events", { OR: [{ actor_id: userId }, { target_type: "user", target_id: userId }] });
        await remove("ow_notification_settings", { target_type: "USER", target_id: String(userId) });
        const devices = idsOf(await db.read("ow_analytics_device", { user_id: userId }, { id: true }));
        await remove("ow_analytics_event", { user_id: userId });
        // Preserve events explicitly belonging to other users, detaching their
        // shared device instead of cascading a different user's history.
        await forIds(devices, (batch) => update("ow_analytics_event", { device_id: { in: batch } }, { device_id: null }));
        await remove("ow_analytics_device", { user_id: userId });
        await remove("ow_analytics_event", { target_type: "user", target_id: userId });
        await removeTargetData(["user", "ap_user", "ap_follow", "ap_remote_user", "mirror40_user"], [userId], "user");
        // Shared objects and other users' histories must remain usable.
        await update("ow_projects_commits", { author_id: userId }, { author_id: null });
        await update("ow_projects_file", { create_userid: userId }, { create_userid: null });
        // This legacy field is required Int with no FK: 0 is an anonymous ID.
        await update("ow_projects_history", { authorid: userId }, { authorid: 0 });
        await update("ow_projects_branch", { creator: userId }, { creator: null });
        await update("project_clouddata_history", { actor_id: userId }, { actor_id: null, actor_name: null, ip: null });
        await update("ow_user_roles", { assigned_by: userId }, { assigned_by: null });
        await update("ow_user_permissions", { assigned_by: userId }, { assigned_by: null });
        await update("ow_user_restrictions", { created_by: userId }, { created_by: null });
        await update("ow_user_restrictions", { revoked_by: userId }, { revoked_by: null });
        await update("ow_assets", { uploader_id: userId }, { uploader_id: null, uploader_ip: null, uploader_ua: null });
        await update("ow_assets", { banned_by: userId }, { banned_by: null });
        for (const model of ["ow_posts", "ow_projects"]) {
            await update(model, { deleted_by: userId }, { deleted_by: null });
            await update(model, { shadowban_by: userId }, { shadowban_by: null });
        }
    }

    result.affectedPostIds = bounded([...affectedPosts]);
    result.affectedProjectIds = bounded([...affectedProjects]);
    result.affectedUserIds = bounded(result.affectedUserIds);
    result.assetIds = bounded([...assets]);
    await reconcilePosts(db, result.affectedPostIds);
    await forIds(result.affectedProjectIds, async (ids) => {
        const groups = await db.call("ow_projects_stars", "groupBy", {
            by: ["projectid"], where: { projectid: { in: ids } }, _count: { _all: true },
        });
        const counts = new Map(groups.map(row => [row.projectid, row._count._all]));
        for (const id of ids) {
            const star_count = counts.get(id) || 0;
            await db.call("ow_projects", "updateMany", { where: { id, star_count: { not: star_count } }, data: { star_count } });
        }
    });
    // Asset usage can include avatars, thumbnails and shared CAS references;
    // deleting these joins does not establish a complete global usage count.
    return result;
}
