import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

// Mock every service import before loading tokenService: no Prisma/Redis/config initialization.
const state = {};
const moduleUrl = (path) => new URL(path, import.meta.url).href;
const silentLogger = { error() {}, warn() {}, info() {} };
function matches(record, where) {
    return Object.entries(where).every(([key, value]) => {
        if (key === "AND") return value.every((part) => matches(record, part));
        if (key === "OR") return value.some((part) => matches(record, part));
        if (key === "user") return matches(record.user || {}, value.is);
        if (value && typeof value === "object" && !(value instanceof Date)) {
            if ("not" in value) return record[key] !== value.not;
            if ("gt" in value) return record[key] > value.gt;
        }
        return record[key] === value;
    });
}
const prisma = { ow_tokens: {
    async findUnique(query) {
        state.queries.push(query);
        const row = state.rows.find((record) => matches(record, query.where));
        return row ? structuredClone(row) : null;
    },
    async findMany(query) {
        state.order.push("findMany");
        return structuredClone(state.rows.filter((record) => matches(record, query.where)));
    },
    async updateMany(query) {
        state.order.push("updateMany");
        state.updates.push(query);
        if (state.dbFailure) throw new Error("simulated database failure");
        if (state.onUpdate) return state.onUpdate(query);
        const rows = state.rows.filter((record) => matches(record, query.where));
        for (const row of rows) {
            for (const [key, value] of Object.entries(query.data)) {
                row[key] = value?.increment ? (row[key] || 0) + value.increment : value;
            }
        }
        return { count: rows.length };
    },
    async updateManyAndReturn(query) {
        state.order.push("updateManyAndReturn");
        state.updates.push(query);
        if (state.dbFailure) throw new Error("simulated database failure");
        const rows = state.rows.filter(record => matches(record, query.where));
        for (const row of rows) Object.assign(row, query.data);
        return structuredClone(rows);
    },
    async update() { throw new Error("Unexpected activity write in test"); },
} };
const redis = {
    isConnected: true,
    async get(key) { return structuredClone(state.cache.get(key) ?? null); },
    async set(key, value) {
        if (state.redisWriteFailure) return false;
        state.cache.set(key, structuredClone(value));
        if (state.onCacheSet) await state.onCacheSet(key, value);
        return true;
    },
    async setIfNotExists() { return false; },
    async deleteMany(keys) {
        state.order.push("deleteMany");
        if (state.redisThrow) throw new Error("simulated Redis disconnect");
        if (state.redisDeleteFailure) return false;
        for (const key of keys) state.cache.delete(key);
        return true;
    },
};
mock.module(moduleUrl("../logger.js"), { defaultExport: silentLogger });
mock.module(moduleUrl("../prisma.js"), { namedExports: { prisma } });
mock.module(moduleUrl("../redis.js"), { defaultExport: redis });
mock.module(moduleUrl("../config/zcconfig.js"), { defaultExport: { async get() { return 3600; } } });
mock.module(moduleUrl("./tokenUtils.js"), { namedExports: { parseDeviceInfo: () => ({}) } });
mock.module(moduleUrl("./scopes.js"), { namedExports: {
    normalizeScopes: (scopes) => Array.isArray(scopes) ? scopes : [],
    validateUserGrantableScopes: async () => ({ allowed: true }),
} });
mock.module(moduleUrl("./policyEngine.js"), { namedExports: {
    getUserPolicy: async () => {
        if (state.onPolicy) await state.onPolicy();
        return { allow: ["project:read"] };
    },
} });
const service = await import("./tokenService.js");
const raw = (character) => "zc_" + character.repeat(96);
const ACCESS = raw("a"), REFRESH = raw("b"), OLD_REFRESH = raw("c");
const accessKey = (token = ACCESS) => "token:cache:" + service.hashToken(token);
const graceKey = (token = OLD_REFRESH) => "refresh:grace:" + service.hashToken(token);
function row(overrides = {}) {
    return {
        id: 7, user_id: 10, type: "session", revoked: false,
        token_hash: service.hashToken(ACCESS), refresh_token_hash: service.hashToken(REFRESH),
        expires_at: new Date(Date.now() + 60_000), refresh_expires_at: new Date(Date.now() + 120_000),
        scopes: ["project:write"], user: { id: 10, status: "active", username: "test-user" },
        ...overrides,
    };
}
function seedAccess(record = state.rows[0]) {
    state.cache.set(accessKey(), {
        tokenId: record.id, user: { userid: record.user_id, username: "cached-user" },
        type: record.type, scopes: ["project:write"], expires_at: Date.now() + 300_000,
    });
}
function seedGrace() {
    state.cache.set(graceKey(), {
        tokenId: 7, accessToken: ACCESS, refreshToken: REFRESH,
        expiresAt: new Date(Date.now() + 300_000).toISOString(), scopes: ["*"],
    });
}
beforeEach(() => {
    Object.assign(state, {
        rows: [row()], cache: new Map(), order: [], queries: [], updates: [],
        dbFailure: false, redisDeleteFailure: false, redisThrow: false, redisWriteFailure: false,
        onUpdate: null, onPolicy: null, onCacheSet: null,
    });
});

test("valid cached token uses one narrow indexed authority lookup", async () => {
    seedAccess();
    const result = await service.verifyToken(ACCESS);
    assert.equal(result.valid, true);
    assert.deepEqual(result.scopes, ["project:read"]);
    assert.equal(state.queries.length, 1);
    assert.deepEqual(state.queries[0].where, { id: 7 });
    assert.equal(state.queries[0].select.token_hash, true);
    assert.equal(state.queries[0].select.user.select.status, true);
    assert.equal(state.queries[0].include, undefined);
});

for (const type of ["session", "personal", "oauth", "editor"]) {
    test(`${type} cache cannot authenticate a kicked or disabled account even when Redis deletion fails`, async () => {
        state.rows = [row({ type })];
        seedAccess();
        state.redisDeleteFailure = true;
        state.rows[0].user.status = "banned";
        assert.equal((await service.verifyToken(ACCESS)).valid, false);
        state.rows[0].user.status = "active";
        state.rows[0].revoked = true;
        assert.equal((await service.verifyToken(ACCESS)).valid, false);
        assert.equal(state.cache.has(accessKey()), true);
    });
}

for (const change of ["missing", "hash", "expiry", "type", "user"]) {
    test(`access cache rejects current row ${change} mismatch`, async () => {
        seedAccess();
        if (change === "missing") state.rows = [];
        if (change === "hash") state.rows[0].token_hash = "new-hash";
        if (change === "expiry") state.rows[0].expires_at = new Date(0);
        if (change === "type") state.rows[0].type = "personal";
        if (change === "user") state.rows[0].user.id = 11;
        assert.equal((await service.verifyToken(ACCESS)).valid, false);
    });
}

test("valid grace returns the current pair and current policy, not cached scope/expiry", async () => {
    seedGrace();
    const result = await service.refreshAccessToken(OLD_REFRESH);
    assert.equal(result.success, true);
    assert.equal(result.fromGrace, true);
    assert.equal(result.accessToken, ACCESS);
    assert.equal(result.refreshToken, REFRESH);
    assert.deepEqual(result.scopes, ["project:read"]);
    assert.deepEqual(result.expiresAt, state.rows[0].expires_at);
    assert.equal(state.updates.length, 0);
});

for (const change of ["revoked", "missing", "banned", "accessHash", "refreshHash", "expiry", "refreshExpiry", "type"]) {
    test(`grace rejects ${change} despite stale Redis entry`, async () => {
        seedGrace();
        state.redisDeleteFailure = true;
        if (change === "revoked") state.rows[0].revoked = true;
        if (change === "missing") state.rows = [];
        if (change === "banned") state.rows[0].user.status = "banned";
        if (change === "accessHash") state.rows[0].token_hash = "changed";
        if (change === "refreshHash") state.rows[0].refresh_token_hash = "changed";
        if (change === "expiry") state.rows[0].expires_at = new Date(0);
        if (change === "refreshExpiry") state.rows[0].refresh_expires_at = new Date(0);
        if (change === "type") state.rows[0].type = "personal";
        assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
    });
}

test("grace rechecks revocation that races the policy lookup", async () => {
    seedGrace();
    state.onPolicy = () => { state.rows[0].revoked = true; };
    assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
});

test("normal refresh rotates first, then clears cache, and supports old refresh grace", async () => {
    seedAccess();
    const result = await service.refreshAccessToken(REFRESH);
    assert.equal(result.success, true);
    assert.notEqual(result.accessToken, ACCESS);
    assert.equal(state.rows[0].token_hash, service.hashToken(result.accessToken));
    assert.deepEqual(state.order, ["updateMany", "deleteMany"]);
    assert.deepEqual(state.updates[0].where.user, { is: { status: "active" } });
    const grace = await service.refreshAccessToken(REFRESH);
    assert.equal(grace.fromGrace, true);
    assert.equal(grace.accessToken, result.accessToken);
});

test("refresh success survives Redis false and old access cache still fails authority check", async () => {
    seedAccess();
    state.redisDeleteFailure = true;
    state.redisWriteFailure = true;
    assert.equal((await service.refreshAccessToken(REFRESH)).success, true);
    assert.equal((await service.verifyToken(ACCESS)).valid, false);
});

test("revoke during rotation cannot return a successful refreshed pair or revive through grace", async () => {
    state.onCacheSet = (key) => {
        if (key.startsWith("refresh:grace:")) state.rows[0].revoked = true;
    };
    assert.equal((await service.refreshAccessToken(REFRESH)).success, false);
    state.redisDeleteFailure = true;
    assert.equal((await service.refreshAccessToken(REFRESH)).success, false);
});

for (const revoked of [false, true]) {
    test(`lost refresh CAS validates retry grace (revoked=${revoked})`, async () => {
        state.rows[0].refresh_token_hash = service.hashToken(OLD_REFRESH);
        state.onUpdate = () => {
            state.rows[0].refresh_token_hash = service.hashToken(REFRESH);
            state.rows[0].revoked = revoked;
            seedGrace();
            return { count: 0 };
        };
        const result = await service.refreshAccessToken(OLD_REFRESH);
        assert.equal(result.success, !revoked);
        if (!revoked) assert.equal(result.fromGrace, true);
    });
}

test("single revoke is DB-first, idempotent, and rejects old cached access/grace after unban", async () => {
    seedAccess(); seedGrace();
    const result = await service.revokeToken(7);
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.cacheInvalidated, true);
    assert.deepEqual(state.order, ["updateManyAndReturn", "deleteMany"]);
    state.rows[0].user.status = "active";
    assert.equal((await service.verifyToken(ACCESS)).valid, false);
    assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
    assert.equal((await service.revokeToken(7)).success, true);
});

for (const throws of [false, true]) {
    test(`committed revoke remains successful with Redis ${throws ? "exception" : "false"}`, async () => {
        seedAccess(); seedGrace();
        state.redisDeleteFailure = !throws;
        state.redisThrow = throws;
        const result = await service.revokeAllUserTokens(10);
        assert.equal(result.success, true);
        assert.equal(result.count, 1);
        assert.equal(result.cacheInvalidated, false);
        assert.ok(result.warning);
        assert.equal(state.rows[0].revoked, true);
        assert.equal((await service.verifyToken(ACCESS)).valid, false);
        assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
    });
}

test("database revoke failure reports failure and leaves cache untouched", async () => {
    state.dbFailure = true;
    const result = await service.revokeTokensWhere({ user_id: 10 });
    assert.equal(result.success, false);
    assert.deepEqual(state.order, ["updateManyAndReturn"]);
    assert.equal(state.rows[0].revoked, false);
});

test("transaction client is used exclusively and invalidation waits for caller commit", async () => {
    const calls = [];
    const db = { ow_tokens: {
        async updateManyAndReturn(query) { calls.push(["updateManyAndReturn", query]); return [row()]; },
    } };
    const result = await service.revokeTokensWhere({ user_id: 10, type: "session" }, { db });
    assert.equal(result.success, true);
    assert.equal(result.cacheInvalidated, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].where, { AND: [{ user_id: 10, type: "session" }, { revoked: false }] });
    assert.deepEqual(state.order, []);
    assert.deepEqual(result.cacheKeys, service.tokenCacheKeysForRecords([row()]));
    const invalidated = await service.invalidateTokenCaches(result.cacheKeys);
    assert.equal(invalidated.success, true);
    assert.deepEqual(state.order, ["deleteMany"]);
});

test("session revoke filter and exclude token never revoke other users/types", async () => {
    state.rows = [row(), row({ id: 8, type: "personal" }), row({ id: 9, user_id: 11 })];
    assert.equal((await service.revokeTokensWhere({ user_id: 10, type: "session" })).count, 1);
    assert.deepEqual(state.rows.map((record) => record.revoked), [true, false, false]);
    assert.equal((await service.revokeAllUserTokens(10, 8)).count, 0);
    assert.equal((await service.revokeAllUserTokens(10)).count, 1);
    assert.equal(state.rows[2].revoked, false);
});

test("captured records helper deduplicates private key formats and handles absent refresh", () => {
    const record = row();
    assert.deepEqual(service.tokenCacheKeysForRecords([record, record, { token_hash: record.token_hash }]), [
        accessKey(), "refresh:grace:" + service.hashToken(REFRESH),
    ]);
});

test("OAuth refresh grace preserves token scopes and never substitutes cached scopes", async () => {
    state.rows[0].type = "oauth";
    seedGrace();
    const result = await service.refreshAccessToken(OLD_REFRESH);
    assert.equal(result.success, true);
    assert.deepEqual(result.scopes, ["project:write"]);
});

for (const malformed of [{ tokenId: "7" }, { accessToken: "invalid" }, { refreshToken: "invalid" }]) {
    test(`malformed grace payload rejects ${Object.keys(malformed)[0]}`, async () => {
        seedGrace();
        Object.assign(state.cache.get(graceKey()), malformed);
        assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
    });
}

test("account disable between refresh read and CAS prevents rotation", async () => {
    state.onUpdate = (query) => {
        state.rows[0].user.status = "banned";
        assert.equal(matches(state.rows[0], query.where), false);
        return { count: 0 };
    };
    assert.equal((await service.refreshAccessToken(REFRESH)).success, false);
    assert.equal(state.rows[0].token_hash, service.hashToken(ACCESS));
});

test("old caches remain unusable if refresh races revoke record capture and Redis is down", async () => {
    seedAccess(); seedGrace();
    const newAccess = raw("d"), newRefresh = raw("e");
    const db = { ow_tokens: {
        async updateManyAndReturn(query) {
            state.rows[0].token_hash = service.hashToken(newAccess);
            state.rows[0].refresh_token_hash = service.hashToken(newRefresh);
            state.cache.set("token:cache:" + service.hashToken(newAccess), {
                tokenId: 7, user: { userid: 10 }, type: "session", scopes: [],
            });
            return prisma.ow_tokens.updateManyAndReturn(query);
        },
    } };
    state.redisDeleteFailure = true;
    const result = await service.revokeTokensWhere({ id: 7 }, { db, invalidateCache: true });
    assert.equal(result.success, true);
    assert.equal(result.cacheInvalidated, false);
    assert.ok(result.cacheKeys.includes("token:cache:" + service.hashToken(newAccess)));
    assert.ok(result.cacheKeys.includes("refresh:grace:" + service.hashToken(newRefresh)));
    assert.equal((await service.verifyToken(newAccess)).valid, false);
    assert.equal((await service.refreshAccessToken(OLD_REFRESH)).success, false);
});

test("invalid revoke filters do not perform writes or invalidate caches", async () => {
    for (const where of [null, {}, []]) {
        assert.equal((await service.revokeTokensWhere(where)).success, false);
    }
    assert.equal((await service.revokeAllUserTokens("invalid")).success, false);
    assert.deepEqual(state.order, []);
});

test("refresh-token logout forwards transaction options and not-found keeps old failure behavior", async () => {
    const result = await service.revokeTokenByRefreshToken(REFRESH, { invalidateCache: false });
    assert.equal(result.success, true);
    assert.equal(result.cacheInvalidated, false);
    assert.equal(state.order.includes("deleteMany"), false);
    assert.equal((await service.revokeToken(999)).success, false);
});
