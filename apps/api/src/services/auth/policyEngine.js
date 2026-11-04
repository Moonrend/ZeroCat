import logger from "../logger.js";
import zcconfig from "../config/zcconfig.js";
import { prisma } from "../prisma.js";
import redisClient from "../redis.js";
import {
    normalizeScopes,
    isValidScope,
    parseScope,
    scopeSatisfies,
} from "./scopes.js";
import {
    assertExplicitRolePermissions,
    assertSystemRoleDefinitions,
    DEFAULT_USER_PERMISSIONS,
    DEFAULT_USER_ROLE_KEYS,
    SYSTEM_ROLE_KEYS,
    SYSTEM_ROLE_PERMISSIONS,
    SYSTEM_ROLES,
} from "./rolePermissions.js";

export {
    DEFAULT_USER_PERMISSIONS,
    DEFAULT_USER_ROLE_KEYS,
    SYSTEM_ROLE_KEYS,
    SYSTEM_ROLE_PERMISSIONS,
    SYSTEM_ROLES,
};

const POLICY_CACHE_VERSION_KEY = "auth:policy:version";

function normalizeUserId(userId) {
    const value = Number(userId);
    return Number.isInteger(value) && value > 0 ? value : null;
}

export function clearUserPolicyCache() {
    clearPolicyCache();
}

export function clearPolicyCache() {
    // Invalidate older process caches too; this process reads policy directly.
    redisClient.set(POLICY_CACHE_VERSION_KEY, String(Date.now())).catch((error) =>
        logger.warn(`[policy] 更新策略缓存版本失败: ${error.message}`)
    );
}

function getSystemRoleDefinition(roleKey) {
    return SYSTEM_ROLES.find((role) => role.key === roleKey) || null;
}

function getSystemRolePermissions(roleKey) {
    const permissions = SYSTEM_ROLE_PERMISSIONS[roleKey] || [];
    assertExplicitRolePermissions(roleKey, permissions);
    return permissions;
}

async function upsertRole(db, role) {
    const rows = await db.$queryRaw`
        INSERT INTO "ow_roles" ("key", "name", "description", "system", "priority", "created_at", "updated_at")
        VALUES (${role.key}, ${role.name}, ${role.description || null}, ${role.system === true}, ${role.priority || 0}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("key") DO UPDATE SET
            "name" = EXCLUDED."name",
            "description" = EXCLUDED."description",
            "system" = EXCLUDED."system",
            "priority" = EXCLUDED."priority",
            "updated_at" = CURRENT_TIMESTAMP
        RETURNING "id", "key"
    `;
    return rows[0] || null;
}

async function upsertRolePermission(db, roleId, scope, effect = "allow") {
    await db.$executeRaw`
        INSERT INTO "ow_role_permissions" ("role_id", "scope", "effect", "conditions", "created_at", "updated_at")
        VALUES (${roleId}, ${scope}, ${effect}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("role_id", "scope", "effect") DO UPDATE SET
            "updated_at" = CURRENT_TIMESTAMP
    `;
}

async function ensureSystemRole(db, roleKey, { syncPermissions = false } = {}) {
    const roleDefinition = getSystemRoleDefinition(roleKey);
    if (!roleDefinition) {
        throw new Error(`未知系统角色: ${roleKey}`);
    }

    const existing = await findRoleByKey(db, roleKey);
    if (existing) return existing;
    const role = await upsertRole(db, roleDefinition);
    if (syncPermissions) {
        const permissions = getSystemRolePermissions(roleKey);
        for (const permission of permissions) await upsertRolePermission(db, role.id, permission);
    }
    return role;
}

async function findRoleByKey(db, roleKey) {
    const rows = await db.$queryRaw`
        SELECT "id", "key"
        FROM "ow_roles"
        WHERE "key" = ${roleKey}
        LIMIT 1
    `;
    return rows[0] || null;
}

async function ensureSystemRoleForAssignment(db, roleKey) {
    const role = await findRoleByKey(db, roleKey);
    if (role) return role;
    return ensureSystemRole(db, roleKey, { syncPermissions: true });
}

async function insertUserRole(db, userId, roleId, {
    assignedBy = null,
    reason = "manual",
    expiresAt = null,
} = {}) {
    // 账号级授予：target_type/target_id 走数据库默认值 'global'。
    await db.$executeRaw`
        INSERT INTO "ow_user_roles" ("user_id", "role_id", "assigned_by", "reason", "expires_at", "created_at", "updated_at")
        VALUES (${userId}, ${roleId}, ${assignedBy}, ${reason}, ${expiresAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("user_id", "role_id", "target_type", "target_id") DO UPDATE SET
            "assigned_by" = COALESCE(EXCLUDED."assigned_by", "ow_user_roles"."assigned_by"),
            "reason" = EXCLUDED."reason",
            "expires_at" = EXCLUDED."expires_at",
            "updated_at" = CURRENT_TIMESTAMP
    `;
}

async function backfillRoleToActiveLocalUsers(db, roleId, reason) {
    await db.$executeRaw`
        INSERT INTO "ow_user_roles" ("user_id", "role_id", "assigned_by", "reason", "expires_at", "created_at", "updated_at")
        SELECT "id", ${roleId}, NULL, ${reason}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "ow_users"
        WHERE "status" = 'active'
          AND COALESCE("type", '') <> 'remote_activitypub'
        ON CONFLICT ("user_id", "role_id", "target_type", "target_id") DO NOTHING
    `;
}

/**
 * 同步系统角色和默认策略。这个函数是幂等的，可在应用启动时重复执行。
 */
export async function syncRolePolicyCatalog() {
    try {
        assertSystemRoleDefinitions();
        const bootstrapAdmins = await prisma.$transaction(async (tx) => {
            let bootstrap = false;
            for (const role of SYSTEM_ROLES) {
                const existing = await findRoleByKey(tx, role.key);
                const created = await ensureSystemRole(tx, role.key, { syncPermissions: true });
                if (!existing && role.key === SYSTEM_ROLE_KEYS.ADMIN) bootstrap = true;
                if (!existing && DEFAULT_USER_ROLE_KEYS.includes(role.key)) {
                    await backfillRoleToActiveLocalUsers(tx, created.id, `system-default-${role.key}`);
                }
            }
            return bootstrap;
        }, { isolationLevel: "Serializable" });
        if (bootstrapAdmins) await syncConfiguredAdminRoles(prisma, { syncPermissions: false });
        clearPolicyCache();
        logger.info("[policy] 已同步角色策略目录");
    } catch (error) {
        logger.error(`[policy] 同步角色策略目录失败: ${error.message}`);
    }
}

/**
 * 将配置文件中的 security.adminusers 同步为数据库 admin 角色，保留旧配置兼容。
 */
export async function syncConfiguredAdminRoles(db = prisma, { syncPermissions = true } = {}) {
    try {
        const adminRole = await ensureSystemRole(db, SYSTEM_ROLE_KEYS.ADMIN, { syncPermissions });
        const adminUsers = await zcconfig.get("security.adminusers");
        const adminIds = Array.isArray(adminUsers)
            ? adminUsers.map(normalizeUserId).filter(Boolean)
            : [];

        for (const userId of adminIds) {
            await insertUserRole(db, userId, adminRole.id, {
                reason: "system-config-admin",
            });
            clearUserPolicyCache(userId);
        }

        const rows = await db.$queryRaw`
            SELECT "id"
            FROM "ow_users"
            WHERE "status" = 'active'
              AND "type" IN ('admin', 'administrator')
        `;
        for (const row of rows) {
            const userId = normalizeUserId(row.id);
            if (!userId) continue;
            await insertUserRole(db, userId, adminRole.id, {
                reason: "system-user-type-admin",
            });
            clearUserPolicyCache(userId);
        }
    } catch (error) {
        logger.error(`[policy] 同步配置管理员角色失败: ${error.message}`);
    }
}

/**
 * 注册/创建本地账户时批量授予默认功能角色。
 * @param {number} userId
 * @param {object} [db] Prisma client 或 transaction client
 */
export async function assignDefaultRolesToUser(userId, db = prisma) {
    return assignRolesToUser(userId, DEFAULT_USER_ROLE_KEYS, {
        reason: "system-register",
        db,
    });
}

export async function assignRolesToUser(userId, roleKeys, {
    assignedBy = null,
    reason = "manual",
    expiresAt = null,
    db = prisma,
} = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    const uniqueRoleKeys = [...new Set((roleKeys || []).filter(Boolean))];
    for (const roleKey of uniqueRoleKeys) {
        const role = await ensureSystemRoleForAssignment(db, roleKey);
        await insertUserRole(db, normalizedUserId, role.id, {
            assignedBy: normalizeUserId(assignedBy),
            reason,
            expiresAt,
        });
    }
    clearUserPolicyCache(normalizedUserId);
}

/**
 * 给用户授予角色，可供管理后台或兼容逻辑调用。
 */
export async function assignRoleToUser(userId, roleKey, {
    assignedBy = null,
    reason = "manual",
    expiresAt = null,
    db = prisma,
} = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    let role = await findRoleByKey(db, roleKey);
    if (!role && getSystemRoleDefinition(roleKey)) {
        role = await ensureSystemRole(db, roleKey, { syncPermissions: true });
    }
    if (!role) {
        throw new Error(`角色不存在: ${roleKey}`);
    }

    await insertUserRole(db, normalizedUserId, role.id, {
        assignedBy: normalizeUserId(assignedBy),
        reason,
        expiresAt,
    });
    clearUserPolicyCache(normalizedUserId);
}

export async function revokeRoleFromUser(userId, roleKey, { db = prisma } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    const role = await findRoleByKey(db, roleKey);
    if (!role) return;

    await db.$executeRaw`
        DELETE FROM "ow_user_roles"
        WHERE "user_id" = ${normalizedUserId}
          AND "role_id" = ${role.id}
          AND "target_type" = 'global'
    `;
    clearUserPolicyCache(normalizedUserId);
}

const SCOPED_GRANT_RESERVED_TARGET = "global";

/**
 * 实例级（资源级）授予一个角色，并打上 grant_type 标记。
 * 与账号级 grant 区分：target_type/target_id 指向具体资源（如 project / <id>）。
 */
export async function assignScopedRole(userId, roleKey, {
    targetType,
    targetId,
    grantType = "manual",
    assignedBy = null,
    reason = "manual",
    expiresAt = null,
    metadata = null,
    db = prisma,
} = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    const normalizedTargetType = String(targetType || "").trim();
    const normalizedTargetId = String(targetId ?? "").trim();
    if (!normalizedTargetType || !normalizedTargetId) {
        throw new Error("实例级授予需要 target_type 和 target_id");
    }
    if (normalizedTargetType === SCOPED_GRANT_RESERVED_TARGET) {
        throw new Error("target_type 不能使用保留值 global");
    }

    const role = await ensureSystemRoleForAssignment(db, roleKey);
    const metadataJson = metadata === null || metadata === undefined
        ? null
        : JSON.stringify(metadata);

    await db.$executeRaw`
        INSERT INTO "ow_user_roles" ("user_id", "role_id", "assigned_by", "reason", "expires_at", "grant_type", "target_type", "target_id", "metadata", "created_at", "updated_at")
        VALUES (${normalizedUserId}, ${role.id}, ${normalizeUserId(assignedBy)}, ${reason}, ${expiresAt}, ${grantType}, ${normalizedTargetType}, ${normalizedTargetId}, ${metadataJson}::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("user_id", "role_id", "target_type", "target_id") DO UPDATE SET
            "assigned_by" = COALESCE(EXCLUDED."assigned_by", "ow_user_roles"."assigned_by"),
            "reason" = EXCLUDED."reason",
            "expires_at" = EXCLUDED."expires_at",
            "grant_type" = EXCLUDED."grant_type",
            "metadata" = EXCLUDED."metadata",
            "updated_at" = CURRENT_TIMESTAMP
    `;

    return role;
}

/**
 * 解除一个实例级角色授予。
 */
export async function revokeScopedRole(userId, roleKey, { targetType, targetId, db = prisma } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    const role = await findRoleByKey(db, roleKey);
    if (!role) return;

    await db.$executeRaw`
        DELETE FROM "ow_user_roles"
        WHERE "user_id" = ${normalizedUserId}
          AND "role_id" = ${role.id}
          AND "target_type" = ${String(targetType || "")}
          AND "target_id" = ${String(targetId ?? "")}
    `;
}

/**
 * 读取用户在某资源实例上有效（未过期）角色授予所覆盖的 allow scope 集合。
 * 资源边界检查用它判断协作者能否操作。
 */
export async function getUserResourceRoleScopes(userId, targetType, targetId, { db = prisma } = {}) {
    const policy = await getUserPolicy(userId, { db, targetType, targetId });
    if (!policy.valid) return [];
    const scopes = [];
    // Return explicit actions rather than a broad manage that could conceal a deny.
    for (const action of ["read", "create", "update", "delete", "interact", "manage"]) {
        const required = `${targetType}:${targetId}:${action}`;
        const broadGrantWouldHideDeny = action === "manage" && ["read", "create", "update", "delete", "interact"]
            .some((covered) => scopeSatisfies(policy.deny, `${targetType}:${targetId}:${covered}`));
        if (!broadGrantWouldHideDeny && policyAllowsScope(policy, required) && resourcePolicyAllowsScope(policy, required)) {
            scopes.push(`${targetType}:${action}`);
        }
    }
    return scopes;
}

/**
 * 列出用户被特殊授予的实例级角色（自助管理用）。可按 grant_type 过滤。
 */
export async function listUserScopedGrants(userId, { grantType = null, db = prisma } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return [];

    const rows = await db.$queryRaw`
        SELECT
            ur."id" AS "assignment_id",
            ur."role_id" AS "role_id",
            ur."grant_type" AS "grant_type",
            ur."target_type" AS "target_type",
            ur."target_id" AS "target_id",
            ur."reason" AS "reason",
            ur."metadata" AS "metadata",
            ur."expires_at" AS "expires_at",
            ur."created_at" AS "created_at",
            r."key" AS "role_key",
            r."name" AS "role_name",
            r."priority" AS "role_priority"
        FROM "ow_user_roles" ur
        INNER JOIN "ow_roles" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = ${normalizedUserId}
          AND ur."target_type" <> 'global'
          AND (${grantType}::text IS NULL OR ur."grant_type" = ${grantType})
        ORDER BY ur."created_at" DESC
    `;

    return rows.map((row) => ({
        id: row.assignment_id,
        role_key: row.role_key,
        role_name: row.role_name,
        role_priority: row.role_priority,
        grant_type: row.grant_type,
        target_type: row.target_type,
        target_id: row.target_id,
        reason: row.reason,
        metadata: row.metadata,
        expires_at: row.expires_at,
        created_at: row.created_at,
        active: !row.expires_at || row.expires_at > new Date(),
    }));
}

/**
 * 列出某资源实例上的全部角色授予（含被授予人信息），供资源所有者查看成员名单。
 */
export async function listResourceGrants(targetType, targetId, { db = prisma } = {}) {
    const tType = String(targetType || "").trim();
    const tId = String(targetId ?? "").trim();
    if (!tType || !tId || tType === SCOPED_GRANT_RESERVED_TARGET) return [];

    const rows = await db.$queryRaw`
        SELECT
            ur."id" AS "assignment_id",
            ur."user_id" AS "user_id",
            ur."grant_type" AS "grant_type",
            ur."reason" AS "reason",
            ur."assigned_by" AS "assigned_by",
            ur."expires_at" AS "expires_at",
            ur."created_at" AS "created_at",
            r."key" AS "role_key",
            r."name" AS "role_name",
            r."priority" AS "role_priority",
            u."username" AS "username",
            u."display_name" AS "display_name",
            u."avatar" AS "avatar",
            au."username" AS "assigned_by_username",
            au."display_name" AS "assigned_by_display_name"
        FROM "ow_user_roles" ur
        INNER JOIN "ow_roles" r ON r."id" = ur."role_id"
        INNER JOIN "ow_users" u ON u."id" = ur."user_id"
        LEFT JOIN "ow_users" au ON au."id" = ur."assigned_by"
        WHERE ur."target_type" = ${tType}
          AND ur."target_id" = ${tId}
          AND (ur."expires_at" IS NULL OR ur."expires_at" > CURRENT_TIMESTAMP)
        ORDER BY r."priority" DESC, u."username" ASC
    `;

    return rows.map((row) => ({
        id: row.assignment_id,
        user_id: row.user_id,
        user: {
            id: row.user_id,
            username: row.username,
            display_name: row.display_name,
            avatar: row.avatar,
        },
        role_key: row.role_key,
        role_name: row.role_name,
        role_priority: row.role_priority,
        grant_type: row.grant_type,
        reason: row.reason,
        assigned_by: row.assigned_by,
        assigned_by_user: row.assigned_by
            ? {
                id: row.assigned_by,
                username: row.assigned_by_username,
                display_name: row.assigned_by_display_name,
            }
            : null,
        expires_at: row.expires_at,
        created_at: row.created_at,
    }));
}

export async function listRoles({ db = prisma } = {}) {
    const rows = await db.$queryRaw`
        SELECT
            r."id" AS "role_id",
            r."key" AS "role_key",
            r."name" AS "role_name",
            r."description" AS "role_description",
            r."system" AS "role_system",
            r."priority" AS "role_priority",
            r."created_at" AS "role_created_at",
            r."updated_at" AS "role_updated_at",
            rp."id" AS "permission_id",
            rp."scope" AS "permission_scope",
            rp."effect" AS "permission_effect",
            rp."conditions" AS "permission_conditions",
            rp."created_at" AS "permission_created_at",
            rp."updated_at" AS "permission_updated_at"
        FROM "ow_roles" r
        LEFT JOIN "ow_role_permissions" rp ON rp."role_id" = r."id"
        ORDER BY r."priority" ASC, r."key" ASC, rp."effect" ASC, rp."scope" ASC
    `;

    const roles = [];
    const roleMap = new Map();
    const inheritance = await db.$queryRaw`
        SELECT ri."role_id", ri."parent_role_id", parent."key" AS parent_role_key
        FROM "ow_role_inheritance" ri JOIN "ow_roles" parent ON parent."id" = ri."parent_role_id"
        ORDER BY ri."role_id", ri."parent_role_id"
    `;
    const parents = new Map();
    for (const edge of inheritance) {
        if (!parents.has(edge.role_id)) parents.set(edge.role_id, []);
        parents.get(edge.role_id).push({ id: edge.parent_role_id, key: edge.parent_role_key });
    }
    for (const row of rows) {
        let role = roleMap.get(row.role_id);
        if (!role) {
            role = {
                id: row.role_id,
                key: row.role_key,
                name: row.role_name,
                description: row.role_description,
                system: row.role_system,
                priority: row.role_priority,
                created_at: row.role_created_at,
                updated_at: row.role_updated_at,
                permissions: [],
                parentRoleIds: (parents.get(row.role_id) || []).map((parent) => parent.id),
                parents: parents.get(row.role_id) || [],
            };
            roleMap.set(row.role_id, role);
            roles.push(role);
        }

        if (row.permission_id) {
            role.permissions.push({
                id: row.permission_id,
                scope: row.permission_scope,
                effect: row.permission_effect || "allow",
                conditions: row.permission_conditions,
                created_at: row.permission_created_at,
                updated_at: row.permission_updated_at,
            });
        }
    }

    return roles;
}

export async function getUserRoleAssignments(userId, { db = prisma } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return [];

    const rows = await db.$queryRaw`
        SELECT
            ur."id" AS "assignment_id",
            ur."user_id" AS "user_id",
            ur."role_id" AS "role_id",
            ur."assigned_by" AS "assigned_by",
            ur."reason" AS "reason",
            ur."expires_at" AS "expires_at",
            ur."created_at" AS "created_at",
            ur."updated_at" AS "updated_at",
            r."key" AS "role_key",
            r."name" AS "role_name",
            r."description" AS "role_description",
            r."system" AS "role_system",
            r."priority" AS "role_priority",
            au."username" AS "assigned_by_username",
            au."display_name" AS "assigned_by_display_name"
        FROM "ow_user_roles" ur
        INNER JOIN "ow_roles" r ON r."id" = ur."role_id"
        LEFT JOIN "ow_users" au ON au."id" = ur."assigned_by"
        WHERE ur."user_id" = ${normalizedUserId}
          AND ur."target_type" = 'global'
        ORDER BY r."priority" ASC, r."key" ASC
    `;

    return rows.map((row) => ({
        id: row.assignment_id,
        user_id: row.user_id,
        role_id: row.role_id,
        role_key: row.role_key,
        role_name: row.role_name,
        role_description: row.role_description,
        role_system: row.role_system,
        role_priority: row.role_priority,
        assigned_by: row.assigned_by,
        assigned_by_user: row.assigned_by
            ? {
                id: row.assigned_by,
                username: row.assigned_by_username,
                display_name: row.assigned_by_display_name,
            }
            : null,
        reason: row.reason,
        expires_at: row.expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        active: !row.expires_at || row.expires_at > new Date(),
    }));
}

export async function replaceUserRoles(userId, roleKeys, {
    assignedBy = null,
    reason = "admin-set-user-roles",
    expiresAt = null,
} = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) {
        throw new Error("无效的用户 ID");
    }

    const uniqueRoleKeys = [...new Set((roleKeys || [])
        .map((roleKey) => String(roleKey || "").trim())
        .filter(Boolean))];

    await prisma.$transaction(async (tx) => {
        // 先确保所有目标角色存在；不存在的非系统角色会抛错。
        for (const roleKey of uniqueRoleKeys) {
            await ensureSystemRoleForAssignment(tx, roleKey);
        }

        const currentAssignments = await getUserRoleAssignments(normalizedUserId, { db: tx });
        const desired = new Set(uniqueRoleKeys);
        for (const assignment of currentAssignments) {
            if (!desired.has(assignment.role_key)) {
                await revokeRoleFromUser(normalizedUserId, assignment.role_key, { db: tx });
            }
        }

        await assignRolesToUser(normalizedUserId, uniqueRoleKeys, {
            assignedBy,
            reason,
            expiresAt,
            db: tx,
        });
    });

    clearUserPolicyCache(normalizedUserId);
}

export function assertSupportedConditions(conditions) {
    if (conditions === null || conditions === undefined) return;
    if (typeof conditions === "object" && !Array.isArray(conditions)
        && Object.keys(conditions).length === 0) return;
    const error = new Error("不支持非空权限条件");
    error.code = "ZC_ERROR_UNSUPPORTED_POLICY_CONDITIONS";
    error.status = 400;
    throw error;
}

export function assertRoleInheritanceGraph(edges) {
    const parents = new Map();
    for (const edge of edges) {
        const roleId = String(edge.role_id), parentId = String(edge.parent_role_id);
        if (!parents.has(roleId)) parents.set(roleId, []);
        parents.get(roleId).push(parentId);
    }
    const visited = new Set(), visiting = new Set();
    const visit = (id) => {
        if (visiting.has(id)) {
            const error = new Error("角色继承不能包含循环");
            error.status = 409;
            error.code = "ZC_ERROR_ROLE_INHERITANCE_CYCLE";
            throw error;
        }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const parent of parents.get(id) || []) visit(parent);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of parents.keys()) visit(id);
}

// Keep every source for explanations; compact only the matching allow/deny sets.
export function policyFromRows(rows) {
    const sources = [], roles = new Set(), roleIds = new Set();
    for (const row of rows) {
        if (row.expires_at && new Date(row.expires_at) <= new Date()) continue;
        assertSupportedConditions(row.conditions);
        if (row.role_key) roles.add(row.role_key);
        if (row.role_id) roleIds.add(Number(row.role_id));
        if (!row.scope) continue;
        if (!isValidScope(row.scope) || !["allow", "deny"].includes(row.effect)) {
            throw new Error("无效的权限策略");
        }
        let scope = row.scope;
        const targetType = row.target_type || "global";
        const targetId = String(row.target_id ?? "global");
        if (targetType !== "global") {
            const parsed = parseScope(scope);
            // A scoped role cannot leak unrelated capabilities into another resource.
            if (targetType === "admin" || (!parsed.wildcard && parsed.resource !== targetType)) continue;
            if (parsed.id !== null && parsed.id !== targetId) continue;
            scope = `${targetType}:${targetId}:${parsed.wildcard ? "*" : parsed.action}`;
        }
        sources.push({
            scope, effect: row.effect, source: row.role_key ? "role" : "user",
            root_role_key: row.root_role_key || row.role_key || null,
            restrict_project_delete: row.restrict_project_delete === true,
            role_key: row.role_key || null, role_id: row.role_id || null,
            assignment_id: row.assignment_id || null, permission_id: row.permission_id || null,
            target_type: targetType, target_id: targetId, expires_at: row.expires_at || null,
        });
    }
    return {
        roles: [...roles], roleIds: [...roleIds], valid: true, sources,
        allow: normalizeScopes(sources.filter((source) => source.effect === "allow").map((source) => source.scope)),
        deny: normalizeScopes(sources.filter((source) => source.effect === "deny").map((source) => source.scope)),
    };
}

async function readUserPolicyRows(db, normalizedUserId, type, id, allTargets = false) {
    return db.$queryRaw`
            WITH RECURSIVE assigned AS (
                SELECT ur."id" AS assignment_id, ur."role_id", ur."target_type", ur."target_id", ur."expires_at", root."key" AS root_role_key,
                       root."key" = 'project_manager' AS restrict_project_delete
                FROM "ow_user_roles" ur JOIN "ow_roles" root ON root."id" = ur."role_id"
                WHERE ur."user_id" = ${normalizedUserId}
                  AND (ur."target_type" = 'global' OR (ur."target_type" = ${type} AND (${allTargets}::boolean OR ur."target_id" = ${id})))
                  AND (ur."expires_at" IS NULL OR ur."expires_at" > CURRENT_TIMESTAMP)
                UNION
                SELECT a.assignment_id, ri."parent_role_id", a."target_type", a."target_id", a."expires_at", a.root_role_key,
                       a.restrict_project_delete OR parent."key" = 'project_manager'
                FROM assigned a JOIN "ow_role_inheritance" ri ON ri."role_id" = a."role_id"
                JOIN "ow_roles" parent ON parent."id" = ri."parent_role_id"
            )
            SELECT a.assignment_id, a."role_id", r."key" AS role_key, a."target_type", a."target_id", a."expires_at",
                   rp."id" AS permission_id, rp."scope", rp."effect", rp."conditions", a.root_role_key, a.restrict_project_delete
            FROM assigned a JOIN "ow_roles" r ON r."id" = a."role_id"
            LEFT JOIN "ow_role_permissions" rp ON rp."role_id" = a."role_id"
            UNION ALL
            SELECT NULL::integer, NULL::integer, NULL::varchar, up."target_type", up."target_id", up."expires_at",
                   up."id", up."scope", up."effect", NULL::jsonb, NULL::varchar, false
            FROM "ow_user_permissions" up
            WHERE up."user_id" = ${normalizedUserId}
              AND (up."target_type" = 'global' OR (up."target_type" = ${type} AND (${allTargets}::boolean OR up."target_id" = ${id})))
              AND (up."expires_at" IS NULL OR up."expires_at" > CURRENT_TIMESTAMP)
        `;
}

// Authorization never trusts an allow cached before a revocation or an expiry.
// useCache remains accepted by existing callers, but all decisions read current rows.
export async function getUserPolicy(userId, { db = prisma, targetType = null, targetId = null } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return { roles: [], allow: [], deny: [], sources: [], valid: false };
    const type = targetType && String(targetType);
    const id = targetId === null || targetId === undefined ? null : String(targetId);
    try {
        return policyFromRows(await readUserPolicyRows(db, normalizedUserId, type, id));
    } catch (error) {
        logger.error(`[policy] 读取用户角色策略失败 user=${normalizedUserId}: ${error.message}`);
        return { roles: [], allow: [], deny: [], sources: [], valid: false };
    }
}

/** Read all candidate resource policies in one database snapshot, scoped to this call. */
export async function getUserResourcePolicies(userId, targetType, { db = prisma } = {}) {
    const normalizedUserId = normalizeUserId(userId);
    const type = String(targetType || "");
    if (!normalizedUserId || !type || type === "global") return new Map();
    try {
        const rows = await readUserPolicyRows(db, normalizedUserId, type, null, true);
        const globalRows = [], scopedRows = new Map();
        for (const row of rows) {
            if (row.target_type === "global") globalRows.push(row);
            else if (row.target_type === type) {
                const id = String(row.target_id);
                if (!scopedRows.has(id)) scopedRows.set(id, []);
                scopedRows.get(id).push(row);
            }
        }
        const globalPolicy = policyFromRows(globalRows);
        const candidates = new Set(scopedRows.keys());
        for (const source of globalPolicy.sources) {
            const scope = parseScope(source.scope);
            if (source.effect === "allow" && scope?.resource === type && scope.id !== null) candidates.add(scope.id);
        }
        const policies = new Map();
        for (const candidate of candidates) {
            // Match the canonical numeric resource IDs used by visibility queries.
            const id = Number(candidate);
            if (!Number.isSafeInteger(id) || id <= 0 || policies.has(id)) continue;
            try {
                policies.set(id, policyFromRows([...globalRows, ...(scopedRows.get(String(id)) || [])]));
            } catch (error) {
                // A malformed scoped grant must fail closed for that resource only.
                logger.error(`[policy] 读取资源策略失败 user=${normalizedUserId} target=${type}:${id}: ${error.message}`);
            }
        }
        return policies;
    } catch (error) {
        logger.error(`[policy] 批量读取用户资源策略失败 user=${normalizedUserId}: ${error.message}`);
        return new Map();
    }
}

function hasNonAdminDeny(policy) {
    return policy.deny.some((scope) => {
        const parsed = parseScope(scope);
        return parsed?.wildcard || parsed?.resource !== "admin";
    });
}

function sourceAllowsScope(source, requiredScope) {
    const required = parseScope(requiredScope);
    if (source.effect !== "allow") return false;
    if (required?.resource === "project" && required.action === "delete"
        && source.target_type !== "global"
        && (source.restrict_project_delete
            || [source.role_key, source.root_role_key].includes(SYSTEM_ROLE_KEYS.PROJECT_MANAGER))) return false;
    return scopeSatisfies([source.scope], requiredScope);
}

export function resourcePolicyAllowsScope(policy, requiredScope) {
    if (policy.valid === false || policyDeniesScope(policy, requiredScope)) return false;
    return (policy.sources || []).some((source) => {
        const parsed = parseScope(source.scope);
        const bound = source.target_type !== "global" || (parsed?.id !== null && parsed?.resource !== "admin");
        return bound && sourceAllowsScope(source, requiredScope);
    });
}

export function policyDeniesScope(policy, requiredScope) {
    if (scopeSatisfies(policy.deny || [], requiredScope)) return true;
    const required = parseScope(requiredScope);
    if (!required || !["manage", "write"].includes(required.action)) return false;
    const actions = ["read", "create", "update", "delete", "interact"];
    return actions.some((action) => scopeSatisfies(policy.deny || [], required.id === null
        ? `${required.resource}:${action}` : `${required.resource}:${required.id}:${action}`));
}

function policyAllowsConcreteScope(policy, requiredScope) {
    if (policy.valid === false || policyDeniesScope(policy, requiredScope)) return false;
    return Array.isArray(policy.sources)
        ? policy.sources.some((source) => sourceAllowsScope(source, requiredScope))
        : scopeSatisfies(policy.allow || [], requiredScope);
}

export function policyAllowsScope(policy, requiredScope) {
    const parsed = parseScope(requiredScope);
    if (!parsed) return false;

    if (parsed.wildcard) {
        return DEFAULT_USER_PERMISSIONS.every((permission) =>
            policyAllowsConcreteScope(policy, permission)
        ) && !hasNonAdminDeny(policy);
    }

    return policyAllowsConcreteScope(policy, requiredScope);
}

export async function userSatisfiesPolicy(userId, requiredScope) {
    const parsed = parseScope(requiredScope);
    const policy = await getUserPolicy(userId, parsed?.id && parsed.resource !== "admin"
        ? { targetType: parsed.resource, targetId: parsed.id } : {});
    return policyAllowsScope(policy, requiredScope);
}

/**
 * 校验用户是否能转授权一组 scope。角色策略是账号上限，token 自身 scope 是调用上下文上限。
 */
export async function canUserGrantScopes(userId, scopes) {
    const normalized = normalizeScopes(scopes);
    const policy = await getUserPolicy(userId);
    const denied = [];
    for (const scope of normalized) {
        const parsed = parseScope(scope);
        const effective = parsed?.id && parsed.resource !== "admin"
            ? await getUserPolicy(userId, { targetType: parsed.resource, targetId: parsed.id }) : policy;
        if (!policyAllowsScope(effective, scope)) denied.push(scope);
    }
    const admin = policyAllowsScope(policy, "admin:manage");

    return {
        allowed: denied.length === 0,
        denied,
        admin,
        roles: policy.roles,
    };
}

export default {
    SYSTEM_ROLE_KEYS,
    DEFAULT_USER_PERMISSIONS,
    DEFAULT_USER_ROLE_KEYS,
    SYSTEM_ROLES,
    SYSTEM_ROLE_PERMISSIONS,
    syncRolePolicyCatalog,
    syncConfiguredAdminRoles,
    assignDefaultRolesToUser,
    assignRolesToUser,
    assignRoleToUser,
    revokeRoleFromUser,
    assignScopedRole,
    revokeScopedRole,
    getUserResourceRoleScopes,
    listUserScopedGrants,
    listResourceGrants,
    listRoles,
    getUserRoleAssignments,
    replaceUserRoles,
    getUserPolicy,
    getUserResourcePolicies,
    resourcePolicyAllowsScope,
    policyDeniesScope,
    policyFromRows,
    assertSupportedConditions,
    assertRoleInheritanceGraph,
    policyAllowsScope,
    userSatisfiesPolicy,
    canUserGrantScopes,
    clearUserPolicyCache,
    clearPolicyCache,
};
