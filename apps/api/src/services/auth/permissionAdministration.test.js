import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url("../logger.js"), { defaultExport: { error() {}, warn() {}, info() {} } });
mock.module(url("../prisma.js"), { namedExports: { prisma: {} } });
mock.module(url("../redis.js"), { defaultExport: { async set() {} } });
mock.module(url("../config/zcconfig.js"), { defaultExport: { async get() { return []; } } });
const { createPermissionAdministration } = await import("./permissionAdministration.js");
const state = {};
const roles = [
    { id: 1, key: "operator", name: "Operator", system: false, permissions: [{ scope: "admin:permissions:manage", effect: "allow" }] },
    { id: 2, key: "custom", name: "Custom", system: false, permissions: [{ scope: "project:read", effect: "allow" }] },
    { id: 3, key: "parent", name: "Parent", system: false, permissions: [{ scope: "project:read", effect: "allow" }] },
];
const tx = {
    ow_users: { async findUnique() { return { id: 1, status: "active" }; } },
    ow_roles: {
        async findUnique({ where }) { return structuredClone(state.roles.find((item) => item.id === where.id || item.key === where.key)); },
        async findMany() { state.roleReads++; return structuredClone(state.roles); },
        async create({ data }) { const result = { id: 4, ...data, permissions: [] }; state.roles.push(result); return result; },
        async update({ where, data }) { state.writes.push("role"); return { id: where.id, ...data }; },
        async delete() { state.writes.push("delete"); },
    },
    ow_role_permissions: { async createMany() {}, async deleteMany() { state.writes.push("permissions"); } },
    ow_role_inheritance: {
        async findMany() { state.edgeReads++; return structuredClone(state.edges); },
        async deleteMany({ where }) { state.edges = state.edges.filter((edge) => edge.role_id !== where.role_id); state.writes.push("inheritance"); },
        async createMany({ data }) { state.edges.push(...data); },
    },
    ow_user_roles: { async findMany({ where }) { return where.user_id === 1 ? [{ role_id: 1 }] : state.targetAssignments; } },
    ow_user_permissions: {
        async upsert({ create }) { state.writes.push("direct"); return { id: 8, ...create }; },
        async findUnique() { return { id: 8, user_id: 7, scope: "project:read", effect: "allow" }; },
        async delete() { state.writes.push("direct-delete"); },
    },
    ow_events: { async create({ data }) { if (state.auditFails) throw new Error("audit failed"); state.audits.push(data); } },
};
const db = { async $transaction(work, options) {
    state.transactions.push(options);
    if (state.conflicts-- > 0) throw Object.assign(new Error("retry"), { code: "P2034" });
    const snapshot = structuredClone({ edges: state.edges, writes: state.writes, roles: state.roles });
    try { return await work(tx); } catch (cause) { Object.assign(state, snapshot); throw cause; }
} };
const service = createPermissionAdministration({ db,
    getPolicy: async () => state.policy, assertWrite: async () => {}, invalidate: () => state.invalidations++,
    assignRole: async (_userId, key) => { state.writes.push(`assign:${key}`); },
    revokeRole: async (_userId, key) => { state.writes.push(`revoke:${key}`); },
});
beforeEach(() => Object.assign(state, {
    roles: structuredClone(roles), edges: [], writes: [], audits: [], transactions: [], conflicts: 0,
    auditFails: false, invalidations: 0, roleReads: 0, edgeReads: 0, targetAssignments: [],
    policy: { valid: true, roles: ["operator"], allow: ["*", "admin:manage"], deny: [] },
}));

test("direct permission mutation rejects own account before any write", async () => {
    await assert.rejects(service.grantUserPermission(1, 1, { scope: "project:read" }), { code: "SELF_PERMISSION_CHANGE_FORBIDDEN" });
    assert.deepEqual(state.writes, []);
    assert.equal(state.invalidations, 0);
});

test("module operator cannot grant capabilities beyond current own policy", async () => {
    state.policy.allow = ["admin:permissions:manage", "project:read"];
    await assert.rejects(service.grantUserPermission(1, 7, { scope: "admin:manage" }), { code: "PERMISSION_GRANT_EXCEEDS_ACTOR" });
    assert.deepEqual(state.writes, []);
});

test("inheritance update is serializable, rejects a cycle and rolls back", async () => {
    state.edges = [{ role_id: 3, parent_role_id: 2 }];
    await assert.rejects(service.setRoleInheritance(1, 2, [3]), { code: "ZC_ERROR_ROLE_INHERITANCE_CYCLE" });
    assert.deepEqual(state.edges, [{ role_id: 3, parent_role_id: 2 }]);
    assert.deepEqual(state.writes, []);
    assert.equal(state.transactions[0].isolationLevel, "Serializable");
});

test("role edits cannot elevate actor through an inherited assigned role", async () => {
    state.edges = [{ role_id: 1, parent_role_id: 2 }];
    await assert.rejects(service.updateRole(1, 2, { permissions: ["project:manage"] }), { code: "SELF_PERMISSION_CHANGE_FORBIDDEN" });
    assert.deepEqual(state.writes, []);
});

test("serializable conflicts retry and audited grant commits in one transaction", async () => {
    state.conflicts = 1;
    const result = await service.grantUserPermission(1, 7, { scope: "project:read", targetType: "project", targetId: "9", reason: "support" });
    assert.equal(result.target_type, "project");
    assert.equal(result.target_id, "9");
    assert.equal(state.transactions.length, 2);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].public, false);
    assert.equal(state.audits[0].actor_id, 1);
    assert.equal(state.audits[0].target_id, 7);
    assert.equal(state.invalidations, 1);
});

test("audit failure rolls back direct grant and does not invalidate before commit", async () => {
    state.auditFails = true;
    await assert.rejects(service.grantUserPermission(1, 7, { scope: "project:read" }), /audit failed/);
    assert.deepEqual(state.writes, []);
    assert.equal(state.invalidations, 0);
});

test("setting multiple roles shares one grantability graph within the transaction", async () => {
    state.targetAssignments = [{ role_id: 2, role: state.roles[1] }];
    await service.setUserRoles(1, 7, ["custom", "parent"]);
    assert.equal(state.roleReads, 1);
    assert.equal(state.edgeReads, 1);
    assert.deepEqual(state.writes, ["assign:custom", "assign:parent"]);
    assert.equal(state.audits.length, 1);
    assert.equal(state.transactions[0].isolationLevel, "Serializable");
});

test("batched role grantability still checks removed roles and inherited permissions", async () => {
    state.policy.allow = ["admin:permissions:manage", "project:read"];
    state.roles[2].permissions = [{ scope: "project:delete", effect: "allow" }];
    state.edges = [{ role_id: 2, parent_role_id: 3 }];
    state.targetAssignments = [{ role_id: 2, role: state.roles[1] }];
    await assert.rejects(service.setUserRoles(1, 7, []), { code: "PERMISSION_GRANT_EXCEEDS_ACTOR" });
    assert.deepEqual(state.writes, []);
    assert.equal(state.invalidations, 0);
});

test("unsupported conditions and mismatched target cannot enter storage", async () => {
    assert.throws(() => service.createRole(1, { key: "new_role", name: "New", permissions: [{ scope: "project:read", conditions: { owner: true } }] }),
        { code: "ZC_ERROR_UNSUPPORTED_POLICY_CONDITIONS" });
    assert.throws(() => service.grantUserPermission(1, 7, { scope: "admin:manage", targetType: "project", targetId: "9" }),
        { code: "PERMISSION_TARGET_MISMATCH" });
    assert.equal(state.transactions.length, 0);
});
