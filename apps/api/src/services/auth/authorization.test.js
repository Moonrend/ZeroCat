import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const url = (path) => new URL(path, import.meta.url).href;
const state = {};
const logger = { error() {}, warn() {}, info() {} };
mock.module(url("../logger.js"), { defaultExport: logger });
const db = { async $queryRaw(parts, ...values) { state.queries.push({ sql: parts.join("?"), values }); return state.rows; } };
mock.module(url("../prisma.js"), { namedExports: { prisma: db } });
mock.module(url("../redis.js"), { defaultExport: { async get() { throw new Error("redis unavailable"); }, async set() {} } });
mock.module(url("../config/zcconfig.js"), { defaultExport: { async get() { return []; } } });
const { policyFromRows, policyAllowsScope, resourcePolicyAllowsScope, assertRoleInheritanceGraph,
    getUserPolicy, getUserResourcePolicies, getUserResourceRoleScopes, assertSupportedConditions } = await import("./policyEngine.js");
const { scopeSatisfies, normalizeScopes, isValidScope } = await import("./scopes.js");
const { createAuthorizer } = await import("./authorization.js");
const row = (scope, effect = "allow", extra = {}) => ({ scope, effect, target_type: "global", target_id: "global", ...extra });
const resource = (scope, effect = "allow", extra = {}) => row(scope, effect, { target_type: "project", target_id: "7", ...extra });
beforeEach(() => Object.assign(state, { queries: [], rows: [] }));

function authorizer(policy, overrides = {}) {
    return createAuthorizer({
        getUser: async () => ({ status: "active" }), getPolicy: async () => policy,
        checkBoundary: async () => false, assertWrite: async () => {}, checkVisibility: async () => true,
        ...overrides,
    });
}
const context = { userId: 3, tokenType: "session", requiredScope: "project:7:update" };

test("session can exercise resource-only role without global allow or snapshot token scope", async () => {
    const policy = policyFromRows([resource("project:update", "allow", { role_key: "editor" })]);
    const decision = await authorizer(policy)({ ...context, tokenScopes: [] });
    assert.equal(decision.allowed, true);
    assert.equal(decision.actorId, 3);
    assert.equal(decision.principalId, 3);
    assert.equal(decision.resourceGrant, true);
    assert.equal(policyAllowsScope(policy, "project:8:update"), false);
    assert.equal(policyAllowsScope(policy, "project:update"), false);
});

for (const type of ["personal", "oauth", "editor", undefined]) {
    test(`${type || "unknown"} token retains fixed scope ceiling`, async () => {
        const policy = policyFromRows([resource("project:manage")]);
        assert.equal((await authorizer(policy)({ ...context, tokenType: type, tokenScopes: ["project:read"] })).code,
            "ZC_ERROR_INSUFFICIENT_SCOPE");
        if (type) assert.equal((await authorizer(policy)({ ...context, tokenType: type, tokenScopes: ["project:update"] })).allowed, true);
    });
}

for (const deny of [row("project:update", "deny"), resource("project:update", "deny")]) {
    test(`${deny.target_type} deny wins over ownership, resource allow and delegation`, async () => {
        let resolved = false;
        const policy = policyFromRows([row("project:manage"), resource("project:update"), deny]);
        const decision = await authorizer(policy, { checkBoundary: async () => true,
            resolveDelegation: async () => { resolved = true; return { allowed: true, principalId: 9 }; } })({
            ...context, delegationId: 4, allowDelegation: true,
        });
        assert.equal(decision.code, "ZC_ERROR_EXPLICIT_DENY");
        assert.equal(resolved, false);
    });
}

test("direct global assignment of an instance scope establishes only that resource boundary", async () => {
    const policy = policyFromRows([row("project:7:update")]);
    assert.equal((await authorizer(policy)(context)).allowed, true);
    assert.equal(policyAllowsScope(policy, "project:8:update"), false);
});

test("authorization passes a supplied transaction to every policy and resource check", async () => {
    const tx = {};
    const checks = [];
    const policy = policyFromRows([row("project:update")]);
    const authorize = authorizer(policy, {
        getUser: async (_id, options) => { checks.push(options.db); return { status: "active" }; },
        getPolicy: async (_id, options) => { checks.push(options.db); return policy; },
        assertWrite: async (_id, _category, _action, options) => { checks.push(options.db); },
        checkBoundary: async (_id, _scope, options) => { checks.push(options.db); return true; },
        checkVisibility: async (_parsed, _actor, options) => { checks.push(options.db); return true; },
    });
    assert.equal((await authorize({ ...context, db: tx })).allowed, true);
    assert.equal(checks.length, 5);
    assert.ok(checks.every(db => db === tx));
});

test("resource boundaries use the supplied transaction for comments and private credentials", async () => {
    state.rows = [row("*")];
    const checks = [];
    const ownerLookup = { async findUnique() { checks.push("transaction"); return { account_user_id: 3, user_id: 3, owner_id: 3 }; } };
    const tx = {
        async $queryRaw() { return state.rows; },
        ow_comment_spaces: { async findUnique() { checks.push("space-transaction"); return null; } },
        ow_comment_service: ownerLookup, ow_notifications: ownerLookup, ow_tokens: ownerLookup,
    };
    const { userCanAccessResourceScope } = await import("./scopes.js");
    for (const scope of ["comment:7:update", "notification:7:update", "token:7:manage"]) {
        assert.equal(await userCanAccessResourceScope(3, scope, { db: tx }), true);
    }
    assert.equal(checks.length, 4);
});

test("type-wide read success never claims a concrete resource grant", async () => {
    const policy = policyFromRows([row("comment:read")]);
    const decision = await authorizer(policy, { checkBoundary: async () => true })({ ...context, requiredScope: "comment:7:read" });
    assert.equal(decision.allowed, true);
    assert.equal(decision.resourceGrant, false);
});

test("hidden resources remain not found when the caller has no resource boundary", async () => {
    const policy = policyFromRows([row("project:update")]);
    const decision = await authorizer(policy, { checkVisibility: async (_parsed, _id, options) => {
        assert.equal(options.ignorePrivacy, false);
        return false;
    } })(context);
    assert.equal(decision.status, 404);
    assert.equal(decision.code, "ZC_ERROR_NOT_FOUND");
});

test("type-wide update capability still needs a resource boundary", async () => {
    const policy = policyFromRows([row("project:update")]);
    assert.equal((await authorizer(policy)(context)).code, "ZC_ERROR_SCOPE_RESOURCE_FORBIDDEN");
});

test("visibility blocks resource grants and current restrictions block delegated writes", async () => {
    const policy = policyFromRows([resource("project:update")]);
    assert.equal((await authorizer(policy, { checkVisibility: async () => false })(context)).status, 404);
    const decision = await authorizer(policy, { assertWrite: async () => {
        throw Object.assign(new Error("只读"), { status: 403, code: "ACCOUNT_READ_ONLY" });
    } })({ ...context, delegationId: 2, allowDelegation: true });
    assert.equal(decision.code, "ACCOUNT_READ_ONLY");
});

test("explicit delegation keeps actor and principal separate and requires an opted-in operation", async () => {
    const policy = policyFromRows([]);
    const authorize = authorizer(policy, { resolveDelegation: async () => ({ allowed: true, principalId: 9 }) });
    assert.equal((await authorize({ ...context, delegationId: 2 })).code, "ZC_ERROR_DELEGATION_NOT_SUPPORTED");
    const decision = await authorize({ ...context, delegationId: 2, allowDelegation: true });
    assert.equal(decision.allowed, true);
    assert.equal(decision.actorId, 3);
    assert.equal(decision.principalId, 9);
});

test("inactive account and unavailable policy fail closed", async () => {
    const policy = policyFromRows([resource("project:update")]);
    assert.equal((await authorizer(policy, { getUser: async () => ({ status: "banned" }) })(context)).code, "ZC_ERROR_ACCOUNT_INACTIVE");
    assert.equal((await authorizer({ valid: false, allow: ["*"] })(context)).code, "ZC_ERROR_POLICY_UNAVAILABLE");
});

test("scoped roles never leak admin or another resource type", () => {
    const policy = policyFromRows([resource("admin:manage"), resource("post:delete"), resource("*")]);
    assert.equal(policyAllowsScope(policy, "admin:manage"), false);
    assert.equal(policyAllowsScope(policy, "post:7:delete"), false);
    assert.equal(policyAllowsScope(policy, "project:7:update"), true);
    assert.equal(policyAllowsScope(policy, "project:8:update"), false);
});

test("expired allows and denies do not survive their boundaries", () => {
    const policy = policyFromRows([
        resource("project:update", "allow", { expires_at: new Date(0) }),
        resource("project:read"), resource("project:read", "deny", { expires_at: new Date(0) }),
    ]);
    assert.equal(policyAllowsScope(policy, "project:7:update"), false);
    assert.equal(policyAllowsScope(policy, "project:7:read"), true);
});

test("a denied child action cannot be bypassed through manage", async () => {
    const policy = policyFromRows([resource("project:manage"), resource("project:update", "deny")]);
    assert.equal(policyAllowsScope(policy, "project:7:manage"), false);
    assert.equal((await authorizer(policy)({ ...context, requiredScope: "project:7:manage" })).code, "ZC_ERROR_EXPLICIT_DENY");
});

test("scoped project manager cannot inherit deletion capability", () => {
    const policy = policyFromRows([resource("project:manage", "allow", { role_key: "project_manager" }),
        resource("project:delete", "allow", { role_key: "parent", root_role_key: "project_manager" })]);
    assert.equal(policyAllowsScope(policy, "project:7:manage"), true);
    assert.equal(resourcePolicyAllowsScope(policy, "project:7:delete"), false);
    assert.equal(policyAllowsScope(policy, "project:7:delete"), false);
});

test("inherited manager provenance cannot add deletion through a grandparent", () => {
    const policy = policyFromRows([resource("project:delete", "allow", {
        role_key: "grandparent", root_role_key: "custom", restrict_project_delete: true,
    })]);
    assert.equal(policyAllowsScope(policy, "project:7:delete"), false);
});

test("protected admin modules are explicit and admin:manage remains compatible", () => {
    assert.equal(isValidScope("admin:permissions:manage"), true);
    assert.equal(isValidScope("admin:made_up:manage"), false);
    assert.equal(scopeSatisfies(["*"], "admin:permissions:read"), false);
    assert.equal(scopeSatisfies(["admin:manage"], "admin:permissions:manage"), true);
    assert.equal(scopeSatisfies(["admin:permissions:manage"], "admin:restrictions:manage"), false);
    assert.deepEqual(normalizeScopes(["*", "admin:content:manage"]), ["*", "admin:content:manage"]);
});

test("inheritance accepts diamonds and rejects self and indirect cycles", () => {
    assert.doesNotThrow(() => assertRoleInheritanceGraph([
        { role_id: 1, parent_role_id: 2 }, { role_id: 1, parent_role_id: 3 },
        { role_id: 2, parent_role_id: 4 }, { role_id: 3, parent_role_id: 4 },
    ]));
    assert.throws(() => assertRoleInheritanceGraph([{ role_id: 1, parent_role_id: 1 }]), { code: "ZC_ERROR_ROLE_INHERITANCE_CYCLE" });
    assert.throws(() => assertRoleInheritanceGraph([{ role_id: 1, parent_role_id: 2 }, { role_id: 2, parent_role_id: 1 }]), { status: 409 });
});

test("unsupported conditions are rejected instead of silently applied", () => {
    for (const value of [{ when: "owner" }, [], "owner", true]) {
        assert.throws(() => assertSupportedConditions(value), { code: "ZC_ERROR_UNSUPPORTED_POLICY_CONDITIONS" });
        assert.throws(() => policyFromRows([row("project:update", "allow", { conditions: value })]));
    }
    assert.doesNotThrow(() => assertSupportedConditions({}));
});

test("policy reads current DB even with Redis down, honors revocation and scopes recursive lookup", async () => {
    state.rows = [resource("project:update")];
    assert.equal(policyAllowsScope(await getUserPolicy(3, { targetType: "project", targetId: 7 }), "project:7:update"), true);
    state.rows = [];
    assert.equal(policyAllowsScope(await getUserPolicy(3, { targetType: "project", targetId: 7 }), "project:7:update"), false);
    assert.equal(state.queries.length, 2);
    assert.match(state.queries[0].sql, /WITH RECURSIVE/);
    assert.match(state.queries[0].sql, /expires_at.*CURRENT_TIMESTAMP/s);
    assert.ok(state.queries[0].values.includes("project"));
    assert.ok(state.queries[0].values.includes("7"));
});

test("resource policies batch candidates with global and scoped denies in one fresh read", async () => {
    state.rows = [
        row("project:12:read"), row("project:13:read"),
        resource("project:read", "deny", { target_id: "13" }),
        resource("project:manage", "allow", { target_id: "14", role_key: "editor" }),
        resource("project:read", "allow", { target_id: "15", expires_at: new Date(0) }),
        resource("project:read", "allow", { target_id: "16", conditions: { unsupported: true } }),
    ];
    const policies = await getUserResourcePolicies(3, "project");
    assert.equal(state.queries.length, 1);
    assert.equal(resourcePolicyAllowsScope(policies.get(12), "project:12:read"), true);
    assert.equal(resourcePolicyAllowsScope(policies.get(13), "project:13:read"), false);
    assert.equal(resourcePolicyAllowsScope(policies.get(14), "project:14:read"), true);
    assert.equal(resourcePolicyAllowsScope(policies.get(15), "project:15:read"), false);
    assert.equal(policies.has(16), false);
    state.rows = [];
    assert.equal((await getUserResourcePolicies(3, "project")).size, 0);
    assert.equal(state.queries.length, 2);
});

test("resource policy batch rejects invalid global policy and respects caller transaction", async () => {
    let calls = 0;
    const transaction = { async $queryRaw() { calls++; return [row("project:read", "allow", { conditions: true })]; } };
    assert.equal((await getUserResourcePolicies(3, "project", { db: transaction })).size, 0);
    assert.equal(calls, 1);
    assert.equal(state.queries.length, 0);
});

test("legacy collaborator scopes include effective deny rather than returning raw allows", async () => {
    state.rows = [resource("project:manage"), row("project:update", "deny")];
    const scopes = await getUserResourceRoleScopes(3, "project", 7);
    assert.equal(scopes.includes("project:update"), false);
    assert.equal(scopes.includes("project:manage"), false);
    assert.equal(scopes.includes("project:read"), true);
});
