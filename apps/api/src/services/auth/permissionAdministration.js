import { prisma } from "../prisma.js";
import { isValidScope, parseScope } from "./scopes.js";
import {
    getUserPolicy, policyAllowsScope, assertSupportedConditions, assertRoleInheritanceGraph,
    clearPolicyCache, listRoles, assignRoleToUser, revokeRoleFromUser, assignScopedRole, revokeScopedRole,
} from "./policyEngine.js";

export class PermissionAdministrationError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function error(status, code, message) { throw new PermissionAdministrationError(status, code, message); }
function id(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0) error(400, "INVALID_ID", "无效 ID");
    return result;
}
function expiration(value) {
    if (value === undefined || value === null || value === "") return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date <= new Date()) error(400, "INVALID_EXPIRATION", "到期时间必须晚于当前时间");
    return date;
}
function target(input) {
    const targetType = input.targetType ?? input.target_type ?? "global";
    const targetId = String(input.targetId ?? input.target_id ?? "global");
    if (targetType === "global" && targetId === "global") return { targetType, targetId };
    if (targetType === "global" || targetType === "admin" || targetId === "global"
        || !isValidScope(`${targetType}:${targetId}:read`)) error(400, "INVALID_TARGET", "无效资源范围");
    return { targetType, targetId };
}
function permission(input) {
    const value = typeof input === "string" ? { scope: input, effect: "allow" } : input;
    if (!value || !isValidScope(value.scope) || !["allow", "deny"].includes(value.effect ?? "allow")) {
        error(400, "INVALID_PERMISSION", "无效权限");
    }
    assertSupportedConditions(value.conditions);
    return { scope: value.scope.trim(), effect: value.effect ?? "allow" };
}
function permissions(values) {
    if (!Array.isArray(values)) error(400, "INVALID_PERMISSIONS", "permissions 必须为数组");
    const result = values.map(permission), seen = new Set();
    for (const item of result) {
        const key = `${item.scope}|${item.effect}`;
        if (seen.has(key)) error(400, "DUPLICATE_PERMISSION", "权限重复");
        seen.add(key);
    }
    return result;
}

export function createPermissionAdministration({ db, getPolicy = getUserPolicy, invalidate = clearPolicyCache,
    list = listRoles, assignRole = assignRoleToUser, revokeRole = revokeRoleFromUser,
    assignResourceRole = assignScopedRole, revokeResourceRole = revokeScopedRole,
    assertWrite = async (userId, tx) => {
        const { assertCanWrite } = await import("../moderation/visibility.js");
        await assertCanWrite(userId, "permissions", "manage", { db: tx });
    } }) {
    async function transaction(work) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const result = await db.$transaction(work, { isolationLevel: "Serializable", timeout: 30000, maxWait: 5000 });
                invalidate();
                return result;
            } catch (cause) {
                if (cause.code === "P2002") error(409, "PERMISSION_CONFLICT", "角色或权限记录已存在");
                if (cause.code !== "P2034") throw cause;
                if (attempt === 2) error(409, "PERMISSION_OPERATION_CONFLICT", "权限正在变化，请刷新后重试");
            }
        }
    }
    async function actor(tx, actorId) {
        const actorUser = await tx.ow_users.findUnique({ where: { id: id(actorId) }, select: { id: true, status: true } });
        const policy = await getPolicy(actorId, { db: tx });
        if (!actorUser || actorUser.status !== "active" || !policyAllowsScope(policy, "admin:permissions:manage")) {
            error(403, "PERMISSION_ADMIN_REQUIRED", "需要权限管理能力");
        }
        await assertWrite(id(actorId), tx);
        return policy;
    }
    async function otherUser(tx, actorId, userId) {
        if (id(actorId) === id(userId)) error(403, "SELF_PERMISSION_CHANGE_FORBIDDEN", "不能在此修改自己的权限");
        const user = await tx.ow_users.findUnique({ where: { id: id(userId) }, select: { id: true, status: true } });
        if (!user) error(404, "USER_NOT_FOUND", "用户不存在");
        return user;
    }
    async function role(tx, roleId) {
        const record = await tx.ow_roles.findUnique({ where: { id: id(roleId) } });
        if (!record) error(404, "ROLE_NOT_FOUND", "角色不存在");
        return record;
    }
    async function audit(tx, actorId, targetType, targetId, action, input = {}) {
        await tx.ow_events.create({ data: {
            actor_id: id(actorId), target_type: targetType, target_id: id(targetId),
            public: false, event_type: "permission_administration", event_data: { action, ...input },
        } });
    }
    function assertGrantable(actorPolicy, values) {
        for (const item of values) {
            if (!policyAllowsScope(actorPolicy, item.scope)) error(403, "PERMISSION_GRANT_EXCEEDS_ACTOR", "不能授予或管理超出自身范围的权限");
            // A module-level permission manager cannot turn an unrelated administrator deny into a global allow.
            if (item.scope === "*" && !policyAllowsScope(actorPolicy, "*")) error(403, "PERMISSION_GRANT_EXCEEDS_ACTOR", "权限超出自身范围");
        }
    }
    async function protectActorRoles(tx, actorId, roleId) {
        const assignments = await tx.ow_user_roles.findMany({ where: { user_id: id(actorId),
            OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }, select: { role_id: true } });
        const edges = await tx.ow_role_inheritance.findMany();
        const ownRoles = new Set(assignments.map((item) => item.role_id));
        const visit = (currentId) => {
            for (const edge of edges.filter((item) => item.role_id === currentId)) {
                if (!ownRoles.has(edge.parent_role_id)) { ownRoles.add(edge.parent_role_id); visit(edge.parent_role_id); }
            }
        };
        for (const assignment of assignments) visit(assignment.role_id);
        if (ownRoles.has(id(roleId))) {
            error(403, "SELF_PERMISSION_CHANGE_FORBIDDEN", "不能修改当前账号使用或继承的角色");
        }
    }
    async function replaceParents(tx, roleId, parentIds) {
        if (!Array.isArray(parentIds)) error(400, "INVALID_ROLE_PARENTS", "父角色必须为数组");
        const ids = [...new Set(parentIds.map(id))];
        const edges = await tx.ow_role_inheritance.findMany();
        const proposed = edges.filter((edge) => Number(edge.role_id) !== id(roleId));
        if (ids.length) {
            const parents = await tx.ow_roles.findMany({ where: { id: { in: ids } }, select: { id: true } });
            const existing = new Set(parents.map(parent => parent.id));
            for (const parentId of ids) {
                if (!existing.has(parentId)) error(404, "ROLE_NOT_FOUND", "角色不存在");
                proposed.push({ role_id: id(roleId), parent_role_id: parentId });
            }
        }
        assertRoleInheritanceGraph(proposed);
        await tx.ow_role_inheritance.deleteMany({ where: { role_id: id(roleId) } });
        if (ids.length) await tx.ow_role_inheritance.createMany({ data: ids.map((parentId) => ({ role_id: id(roleId), parent_role_id: parentId })) });
    }
    async function readRoleGraph(tx) {
        const roles = await tx.ow_roles.findMany({ include: { permissions: true } });
        const edges = await tx.ow_role_inheritance.findMany();
        assertRoleInheritanceGraph(edges);
        return { roles, edges };
    }
    async function assertRoleGrantable(tx, actorPolicy, roleId, range = null, graph = null) {
        const { roles, edges } = graph || await readRoleGraph(tx);
        const visited = new Set();
        const visit = (currentId) => {
            if (visited.has(currentId)) return;
            visited.add(currentId);
            const record = roles.find((item) => item.id === currentId);
            if (!record) error(404, "ROLE_NOT_FOUND", "角色不存在");
            for (const item of record.permissions) assertSupportedConditions(item.conditions);
            const values = record.permissions.flatMap((item) => {
                if (!range) return [item];
                const parsed = parseScope(item.scope);
                if (!parsed || (!parsed.wildcard && parsed.resource !== range.targetType)
                    || (!parsed.wildcard && parsed.id !== null && parsed.id !== range.targetId)) return [];
                return [{ ...item, scope: `${range.targetType}:${range.targetId}:${parsed.wildcard ? "*" : parsed.action}` }];
            });
            assertGrantable(actorPolicy, values);
            for (const edge of edges.filter((item) => item.role_id === currentId)) visit(edge.parent_role_id);
        };
        visit(id(roleId));
    }
    function roleDetails(input, creating = false) {
        const data = {};
        if (creating) {
            if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.key || "")) error(400, "INVALID_ROLE_KEY", "角色标识必须为小写字母、数字或下划线");
            data.key = input.key;
        }
        if (creating || input.name !== undefined) {
            if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) error(400, "INVALID_ROLE_NAME", "无效角色名称");
            data.name = input.name.trim();
        }
        if (input.description !== undefined) data.description = input.description === null ? null : String(input.description).slice(0, 4000);
        if (input.priority !== undefined) {
            if (!Number.isSafeInteger(input.priority)) error(400, "INVALID_ROLE_PRIORITY", "无效角色顺序");
            data.priority = input.priority;
        }
        return data;
    }
    return {
        listPermissionRoles: (options = {}) => list({ db, ...options }),
        listUserPermissions(userId, { targetType, targetId } = {}) {
            return db.ow_user_permissions.findMany({ where: { user_id: id(userId),
                ...(targetType ? { target_type: targetType } : {}), ...(targetId ? { target_id: String(targetId) } : {}) }, orderBy: { created_at: "desc" } });
        },
        createRole(actorId, input) {
            const data = roleDetails(input, true), values = permissions(input.permissions || []);
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId);
                assertGrantable(policy, values);
                const record = await tx.ow_roles.create({ data: { ...data, system: false } });
                if (values.length) await tx.ow_role_permissions.createMany({ data: values.map((value) => ({ ...value, role_id: record.id })) });
                await replaceParents(tx, record.id, input.parentRoleIds || []);
                await assertRoleGrantable(tx, policy, record.id);
                await audit(tx, actorId, "role", record.id, "create_role", { reason: input.reason || null });
                return record;
            });
        },
        updateRole(actorId, roleId, input) {
            const data = roleDetails(input), values = input.permissions === undefined ? null : permissions(input.permissions);
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId);
                await role(tx, roleId);
                await protectActorRoles(tx, actorId, roleId);
                await assertRoleGrantable(tx, policy, roleId);
                if (values) {
                    assertGrantable(policy, values);
                    await tx.ow_role_permissions.deleteMany({ where: { role_id: id(roleId) } });
                    if (values.length) await tx.ow_role_permissions.createMany({ data: values.map((value) => ({ ...value, role_id: id(roleId) })) });
                }
                if (input.parentRoleIds !== undefined) await replaceParents(tx, roleId, input.parentRoleIds);
                await assertRoleGrantable(tx, policy, roleId);
                const record = await tx.ow_roles.update({ where: { id: id(roleId) }, data });
                await audit(tx, actorId, "role", roleId, "update_role", { reason: input.reason || null });
                return record;
            });
        },
        deleteRole(actorId, roleId, input = {}) {
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId), record = await role(tx, roleId);
                if (record.system) error(403, "SYSTEM_ROLE_PROTECTED", "不能删除系统角色");
                await protectActorRoles(tx, actorId, roleId);
                await assertRoleGrantable(tx, policy, roleId);
                await tx.ow_roles.delete({ where: { id: id(roleId) } });
                await audit(tx, actorId, "role", roleId, "delete_role", { key: record.key, reason: input.reason || null });
                return { success: true };
            });
        },
        setRoleInheritance(actorId, roleId, parentRoleIds, input = {}) {
            return this.updateRole(actorId, roleId, { parentRoleIds, reason: input.reason });
        },
        grantUserPermission(actorId, userId, input) {
            const value = permission(input), range = target(input), expiresAt = expiration(input.expiresAt ?? input.expires_at);
            const parsed = parseScope(value.scope);
            if (range.targetType !== "global" && (parsed.wildcard || parsed.resource !== range.targetType
                || (parsed.id !== null && parsed.id !== range.targetId))) error(400, "PERMISSION_TARGET_MISMATCH", "权限和资源范围不匹配");
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId);
                await otherUser(tx, actorId, userId);
                const effectiveScope = range.targetType === "global" ? value.scope
                    : `${range.targetType}:${range.targetId}:${parsed.action}`;
                const effective = parseScope(effectiveScope);
                const grantPolicy = effective.id !== null && effective.resource !== "admin"
                    ? await getPolicy(actorId, { db: tx, targetType: effective.resource, targetId: effective.id }) : policy;
                assertGrantable(grantPolicy, [{ ...value, scope: effectiveScope }]);
                const record = await tx.ow_user_permissions.upsert({
                    where: { user_id_scope_effect_target_type_target_id: { user_id: id(userId), scope: value.scope, effect: value.effect,
                        target_type: range.targetType, target_id: range.targetId } },
                    create: { user_id: id(userId), ...value, target_type: range.targetType, target_id: range.targetId,
                        assigned_by: id(actorId), expires_at: expiresAt, reason: input.reason || null },
                    update: { assigned_by: id(actorId), expires_at: expiresAt, reason: input.reason || null },
                });
                await audit(tx, actorId, "user", userId, "grant_user_permission", { permission_id: record.id, ...value, ...range, reason: input.reason || null });
                return record;
            });
        },
        revokeUserPermission(actorId, userId, permissionId, input = {}) {
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId);
                await otherUser(tx, actorId, userId);
                const record = await tx.ow_user_permissions.findUnique({ where: { id: id(permissionId) } });
                if (!record || record.user_id !== id(userId)) error(404, "PERMISSION_NOT_FOUND", "权限记录不存在");
                const effectiveScope = record.target_type && record.target_type !== "global"
                    ? `${record.target_type}:${record.target_id}:${parseScope(record.scope).action}` : record.scope;
                const effective = parseScope(effectiveScope);
                const grantPolicy = effective.id !== null && effective.resource !== "admin"
                    ? await getPolicy(actorId, { db: tx, targetType: effective.resource, targetId: effective.id }) : policy;
                assertGrantable(grantPolicy, [{ ...record, scope: effectiveScope }]);
                await tx.ow_user_permissions.delete({ where: { id: record.id } });
                await audit(tx, actorId, "user", userId, "revoke_user_permission", { permission_id: record.id, reason: input.reason || null });
                return { success: true };
            });
        },
        setUserRoles(actorId, userId, roleKeys, input = {}) {
            if (!Array.isArray(roleKeys) || roleKeys.some((key) => typeof key !== "string")) error(400, "INVALID_ROLES", "角色必须为数组");
            const expiresAt = expiration(input.expiresAt);
            return transaction(async (tx) => {
                const policy = await actor(tx, actorId);
                await otherUser(tx, actorId, userId);
                const current = await tx.ow_user_roles.findMany({ where: { user_id: id(userId), target_type: "global" }, include: { role: true } });
                const keys = [...new Set(roleKeys)];
                const checkedKeys = new Set([...keys, ...current.map((item) => item.role.key)]);
                if (checkedKeys.size) {
                    const graph = await readRoleGraph(tx);
                    const rolesByKey = new Map(graph.roles.map(record => [record.key, record]));
                    for (const key of checkedKeys) {
                        const record = rolesByKey.get(key);
                        if (!record) error(404, "ROLE_NOT_FOUND", "角色不存在");
                        await assertRoleGrantable(tx, policy, record.id, null, graph);
                    }
                }
                for (const assignment of current) if (!keys.includes(assignment.role.key)) await revokeRole(userId, assignment.role.key, { db: tx });
                for (const key of keys) await assignRole(userId, key, { assignedBy: id(actorId), expiresAt, reason: input.reason || "admin-set-user-roles", db: tx });
                await audit(tx, actorId, "user", userId, "set_user_roles", { roles: keys, reason: input.reason || null });
                return { success: true };
            });
        },
        grantResourceRole(actorId, userId, roleKey, input) {
            return resourceRoleMutation(false, actorId, userId, roleKey, input);
        },
        revokeResourceRole(actorId, userId, roleKey, input) {
            return resourceRoleMutation(true, actorId, userId, roleKey, input);
        },
    };

    async function resourceRoleMutation(revoke, actorId, userId, roleKey, input) {
        const range = target(input);
        if (range.targetType === "global") error(400, "INVALID_TARGET", "资源角色需要指定资源");
        const expiresAt = expiration(input.expiresAt);
        return transaction(async (tx) => {
            await actor(tx, actorId);
            await otherUser(tx, actorId, userId);
            const record = await tx.ow_roles.findUnique({ where: { key: roleKey } });
            if (!record) error(404, "ROLE_NOT_FOUND", "角色不存在");
            const grantPolicy = await getPolicy(actorId, { db: tx, targetType: range.targetType, targetId: range.targetId });
            await assertRoleGrantable(tx, grantPolicy, record.id, range);
            const operation = revoke ? revokeResourceRole : assignResourceRole;
            await operation(userId, roleKey, { ...range, assignedBy: id(actorId), expiresAt, reason: input.reason || "manual", db: tx });
            await audit(tx, actorId, "user", userId, revoke ? "revoke_resource_role" : "grant_resource_role", { role_key: roleKey, ...range, reason: input.reason || null });
            return { success: true };
        });
    }
}

const service = createPermissionAdministration({ db: prisma });
export const listPermissionRoles = (...args) => service.listPermissionRoles(...args);
export const listUserPermissions = (...args) => service.listUserPermissions(...args);
export const createRole = (...args) => service.createRole(...args);
export const updateRole = (...args) => service.updateRole(...args);
export const deleteRole = (...args) => service.deleteRole(...args);
export const setRoleInheritance = (...args) => service.setRoleInheritance(...args);
export const grantUserPermission = (...args) => service.grantUserPermission(...args);
export const revokeUserPermission = (...args) => service.revokeUserPermission(...args);
export const setUserRoles = (...args) => service.setUserRoles(...args);
export const grantResourceRole = (...args) => service.grantResourceRole(...args);
export const revokeResourceRole = (...args) => service.revokeResourceRole(...args);
export default service;
