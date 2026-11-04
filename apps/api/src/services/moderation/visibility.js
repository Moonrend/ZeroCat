import { Prisma } from "../../../generated/prisma/client.ts";
import { prisma } from "../prisma.js";
import { activeRestrictionWhere, assertCanWrite } from "./restrictions.js";
import { categoryFor, contentIsShadowbanned, ModerationError } from "./policy.js";

export { assertCanWrite };

const KINDS = {
    post: { owner: "author_id", category: "posts", table: "ow_posts" },
    project: { owner: "authorid", nullableOwner: true, category: "projects", table: "ow_projects" },
    profile: { owner: "id", category: "profile", table: "ow_users" },
    user: { owner: "id", category: "profile", table: "ow_users" },
    comment: { owner: "user_id", nullableOwner: true, category: "comments", table: "ow_comment" },
    comment_service: { owner: "account_user_id", nullableOwner: true, category: "comments", table: "ow_comment_service" },
    list: { owner: "authorid", nullableOwner: true, category: "lists", table: "ow_projects_lists" },
    activity: { owner: "actor_id", nullableOwner: true, category: "activity", table: "ow_events" },
    event: { owner: "actor_id", nullableOwner: true, category: "activity", table: "ow_events" },
    relation: { owner: "source_user_id", nullableOwner: true, category: "relations", table: "ow_user_relationships" },
    asset: { owner: "uploader_id", nullableOwner: true, category: "assets", table: "ow_assets" },
    extension: { owner: null, category: "extensions", table: "ow_scratch_extensions" },
};

function kindDefinition(kind) {
    const config = KINDS[kind];
    if (!config) throw new Error(`Unknown visibility kind: ${kind}`);
    return config;
}

function reviewer(options) {
    // This context is created by a separately authorized review route, never from request JSON.
    return options?.review === true && options?.reviewAuthorized === true;
}

function ownerFilter(field, ids, nullable = false) {
    if (!ids.length) return {};
    const excluded = { [field]: { notIn: ids } };
    return nullable ? { OR: [{ [field]: null }, excluded] } : excluded;
}

async function hiddenOwners(category, viewerId, db) {
    const rules = await db.ow_user_restrictions.findMany({
        where: activeRestrictionWhere("shadowban", category),
        select: { user_id: true },
    });
    return [...new Set(rules.map((rule) => rule.user_id))].filter((id) => id !== Number(viewerId));
}

async function privateResourceWhere(kind, viewerId, db) {
    const owner = "authorid";
    const alternatives = [{ state: "public" }];
    if (!viewerId) return { OR: alternatives };
    const id = Number(viewerId);
    alternatives.push({ [owner]: id });
    const { getUserResourcePolicies, resourcePolicyAllowsScope } = await import("../auth/policyEngine.js");
    const policies = await getUserResourcePolicies(id, kind, { db });
    const allowed = [];
    for (const [candidate, policy] of policies) {
        if (resourcePolicyAllowsScope(policy, `${kind}:${candidate}:read`)) allowed.push(candidate);
    }
    if (allowed.length) alternatives.push({ id: { in: allowed } });
    return { OR: alternatives };
}

function singleItemShadowWhere(owner, viewerId, now) {
    return { OR: [
        { is_shadowbanned: false },
        { shadowban_expires_at: { lte: now } },
        ...(viewerId ? [{ [owner]: Number(viewerId) }] : []),
    ] };
}

export async function visibleWhere(kind, viewerId = null, options = {}) {
    return buildVisibleWhere(kind, viewerId, options, new Map());
}

async function buildVisibleWhere(kind, viewerId, options, ownerQueries) {
    const config = kindDefinition(kind);
    if (reviewer(options)) return {};
    const db = options.db || prisma;
    const ownersFor = (category) => {
        if (!ownerQueries.has(category)) ownerQueries.set(category, hiddenOwners(category, viewerId, db));
        return ownerQueries.get(category);
    };
    if (kind === "extension") return { AND: [{ project: { is: await buildVisibleWhere("project", viewerId, options, ownerQueries) } },
        { project: { is: ownerFilter("authorid", await ownersFor("extensions"), KINDS.project.nullableOwner) } }] };
    const now = options.now || new Date();
    const clauses = [];
    if (["project", "list"].includes(kind) && !options.ignorePrivacy) clauses.push(await privateResourceWhere(kind, viewerId, db));
    if (kind === "post") clauses.push({ is_deleted: false, deleted_at: null });
    if (kind === "project") clauses.push({ deleted_at: null });
    if (["post", "project"].includes(kind)) clauses.push(singleItemShadowWhere(config.owner, viewerId, now));
    if (kind === "project") {
        const [projects, blog] = await Promise.all([
            ownersFor("projects"), ownersFor("blog"),
        ]);
        clauses.push({ OR: [
            { AND: [{ type: "article" }, ownerFilter(config.owner, [...new Set([...projects, ...blog])], config.nullableOwner)] },
            { AND: [{ OR: [{ type: null }, { type: { not: "article" } }] }, ownerFilter(config.owner, projects, config.nullableOwner)] },
        ] });
    } else {
        clauses.push(ownerFilter(config.owner, await ownersFor(options.category || config.category), config.nullableOwner));
    }
    if (kind === "relation") {
        clauses.push(ownerFilter("target_user_id", await ownersFor("profile"), true));
    }
    if (kind === "post" && options.reference) clauses.push({ post_type: { not: "retweet" } });
    if (kind === "post" && !options.reference) {
        clauses.push({ OR: [
            { post_type: { not: "retweet" } },
            { retweet_post: { is: await buildVisibleWhere("post", viewerId, { ...options, reference: true }, ownerQueries) } },
        ] });
    }
    return { AND: clauses };
}

function identifier(alias) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error("Invalid SQL alias");
    return Prisma.raw(`"${alias}"`);
}

function publicOwnerSql(ownerExpression, category, viewerId, now) {
    const categories = ["*", category];
    return Prisma.sql`(${ownerExpression} IS NULL OR ${ownerExpression} = ${Number(viewerId) || 0} OR NOT EXISTS (
        SELECT 1 FROM "ow_user_restrictions" vr
        WHERE vr."user_id" = ${ownerExpression} AND vr."type" = 'shadowban'
          AND vr."revoked_at" IS NULL AND vr."starts_at" <= ${now}
          AND (vr."expires_at" IS NULL OR vr."expires_at" > ${now})
          AND vr."categories" && ARRAY[${Prisma.join(categories)}]::text[]
    ))`;
}

export async function visibleSql(kind, alias, viewerId = null, options = {}) {
    const config = kindDefinition(kind);
    const name = identifier(alias);
    if (reviewer(options)) return Prisma.sql`TRUE`;
    if (kind === "extension") {
        const projectVisibility = await visibleSql("project", "vep", viewerId, options);
        const extensionVisibility = publicOwnerSql(Prisma.sql`vep."authorid"`, "extensions", viewerId, options.now || new Date());
        return Prisma.sql`EXISTS (SELECT 1 FROM "ow_projects" vep WHERE vep."id" = ${name}."projectid" AND ${projectVisibility} AND ${extensionVisibility})`;
    }
    const owner = Prisma.sql`${name}.${Prisma.raw(`"${config.owner}"`)}`;
    const now = options.now || new Date();
    const conditions = [];
    if (["project", "list"].includes(kind) && !options.ignorePrivacy) {
        const privacy = await privateResourceWhere(kind, viewerId, options.db || prisma);
        const granted = privacy.OR.filter((item) => item.id?.in).flatMap((item) => item.id.in);
        conditions.push(Prisma.sql`(${name}."state" = 'public' OR ${owner} = ${Number(viewerId) || 0}${granted.length ? Prisma.sql` OR ${name}."id" IN (${Prisma.join(granted)})` : Prisma.empty})`);
    }
    if (kind === "post") conditions.push(Prisma.sql`${name}."is_deleted" = false AND ${name}."deleted_at" IS NULL`);
    if (kind === "project") conditions.push(Prisma.sql`${name}."deleted_at" IS NULL`);
    if (["post", "project"].includes(kind)) {
        conditions.push(Prisma.sql`(${name}."is_shadowbanned" = false OR ${name}."shadowban_expires_at" <= ${now} OR ${owner} = ${Number(viewerId) || 0})`);
    }
    conditions.push(publicOwnerSql(owner, options.category || config.category, viewerId, now));
    if (kind === "post" && options.reference) conditions.push(Prisma.sql`${name}."post_type" <> 'retweet'`);
    if (kind === "project") conditions.push(Prisma.sql`(${name}."type" IS DISTINCT FROM 'article' OR ${publicOwnerSql(owner, "blog", viewerId, now)})`);
    if (kind === "relation") conditions.push(publicOwnerSql(Prisma.sql`${name}."target_user_id"`, "profile", viewerId, now));
    if (kind === "post" && !options.reference) {
        const source = await visibleSql("post", "vrs", viewerId, { ...options, reference: true });
        conditions.push(Prisma.sql`(${name}."post_type" <> 'retweet' OR EXISTS (SELECT 1 FROM "ow_posts" vrs WHERE vrs."id" = ${name}."retweet_post_id" AND ${source}))`);
    }
    return Prisma.sql`(${Prisma.join(conditions, " AND ")})`;
}

export async function canViewContent(kind, record, viewerId = null, options = {}) {
    if (!record) return false;
    const config = kindDefinition(kind);
    if (reviewer(options)) return true;
    const db = options.db || prisma;
    if (kind === "extension") {
        const current = record.project || await db.ow_projects.findUnique({ where: { id: Number(record.projectid) || 0 } });
        return Boolean(current) && await canViewContent("project", current, viewerId, options)
            && await userPublicDataVisible(current.authorid, "extensions", viewerId, { db });
    }
    // A lean projection without governance fields must be checked against its canonical row.
    let current = record;
    const missingFields = kind === "list" ? ["authorid", "state"]
        : kind === "post" ? ["author_id", "is_shadowbanned", "deleted_at", "is_deleted", "post_type"]
            : kind === "project" ? ["authorid", "state", "type", "is_shadowbanned", "deleted_at"] : [];
    if (record.id && missingFields.some((field) => !Object.hasOwn(record, field))) {
        current = await db[config.table].findUnique({ where: { id: Number(record.id) } });
        if (!current) return false;
    }
    if (current.deleted_at || (kind === "post" && current.is_deleted)) return false;
    if (kind === "post" && current.post_type === "retweet") {
        // Retweets are normalized to an original post on creation; reject legacy chains and cycles.
        if (options.reference || !current.retweet_post_id) return false;
        const source = await db.ow_posts.findUnique({ where: { id: Number(current.retweet_post_id) } });
        if (!await canViewContent("post", source, viewerId, { ...options, reference: true })) return false;
    }
    if (kind === "relation" && !await userPublicDataVisible(current.target_user_id, "profile", viewerId, { db })) return false;
    if (["project", "list"].includes(kind) && !options.ignorePrivacy && current.state !== "public"
        && Number(current[config.owner]) !== Number(viewerId)) {
        if (!viewerId) return false;
        const { getUserPolicy, resourcePolicyAllowsScope } = await import("../auth/policyEngine.js");
        const policy = await getUserPolicy(viewerId, { db, targetType: kind, targetId: String(current.id) });
        if (!resourcePolicyAllowsScope(policy, `${kind}:${current.id}:read`)) return false;
    }
    const owner = Number(current[config.owner]);
    if (viewerId && owner === Number(viewerId)) return true;
    if (contentIsShadowbanned(current, options.now)) return false;
    if (!owner) return true;
    const categories = [options.category || config.category, ...(kind === "project" && current.type === "article" ? ["blog"] : [])];
    const rule = await db.ow_user_restrictions.findFirst({ where: {
        user_id: owner,
        ...activeRestrictionWhere("shadowban"),
        categories: { hasSome: ["*", ...categories] },
    }, select: { id: true } });
    return !rule;
}

export async function sanitizePublicUser(user, viewerId = null, options = {}) {
    if (!user) return null;
    return await canViewContent("profile", user, viewerId, options) ? user : null;
}

export const sanitizeProfile = sanitizePublicUser;

/** Sanitize a page of profiles with fresh, bounded restriction reads. Keeps input positions. */
export async function sanitizeProfiles(users, viewerId = null, options = {}) {
    if (reviewer(options)) return users.map(user => user || null);
    const db = options.db || prisma;
    const candidates = [...new Set(users.filter(Boolean).map(user => Number(user.id))
        .filter(id => id && (!viewerId || id !== Number(viewerId))))];
    const hidden = new Set();
    for (let start = 0; start < candidates.length; start += 500) {
        const rules = await db.ow_user_restrictions.findMany({
            where: { user_id: { in: candidates.slice(start, start + 500) },
                ...activeRestrictionWhere("shadowban"),
                categories: { hasSome: ["*", options.category || "profile"] } },
            select: { user_id: true },
        });
        for (const rule of rules) hidden.add(rule.user_id);
    }
    return users.map(user => {
        if (!user || user.deleted_at) return null;
        if (viewerId && Number(user.id) === Number(viewerId)) return user;
        return contentIsShadowbanned(user, options.now) || hidden.has(Number(user.id)) ? null : user;
    });
}

export async function assertPubliclyVisible(kind, record, viewerId = null, options = {}) {
    if (!await canViewContent(kind, record, viewerId, options)) {
        throw new ModerationError(404, "RESOURCE_NOT_FOUND", "内容不存在");
    }
    return record;
}

export async function userPublicDataVisible(userId, category, viewerId = null, { db = prisma } = {}) {
    if (Number(userId) === Number(viewerId)) return true;
    if (!userId) return true;
    return !await db.ow_user_restrictions.findFirst({ where: {
        user_id: Number(userId), ...activeRestrictionWhere("shadowban", categoryFor(category)),
    }, select: { id: true } });
}
