import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const state = {};
const moduleUrl = (path) => new URL(path, import.meta.url).href;

mock.module(moduleUrl("../../services/logger.js"), {
    defaultExport: { debug() {}, error() {}, info() {}, warn() {} },
});
mock.module(moduleUrl("../../services/auth/auth.js"), {
    defaultExport: {
        async getUserActiveTokens() { return []; },
        async refreshAccessToken() { return { success: false }; },
        async revokeToken() { return { success: true }; },
    },
});
mock.module(moduleUrl("../../services/prisma.js"), {
    namedExports: { prisma: { ow_tokens: {} } },
});
mock.module(moduleUrl("../../services/ip/ipLocation.js"), {
    defaultExport: { async getIPLocation() { return null; } },
});
mock.module(moduleUrl("../../services/config/zcconfig.js"), {
    defaultExport: {
        async get(key) {
            if (key === "cors") return ["https://app.example.test"];
            if (key === "urls.frontend") return "https://app.example.test";
            return null;
        },
    },
});
mock.module(moduleUrl("../../services/auth/tokenUtils.js"), {
    namedExports: {
        extractRefreshTokenFromRequest() {
            return {
                fromCookie: true,
                refresh_token: "zc_refresh",
                refresh_tokens: ["zc_refresh"],
            };
        },
        respondWithBrowserAuthTokens(res, payload) { return res.json(payload); },
        toIsoOrValue(value) { return value instanceof Date ? value.toISOString() : value; },
    },
});
mock.module(moduleUrl("../../services/auth/tokenService.js"), {
    namedExports: {
        async getSessionFromRefreshToken() {
            return {
                userId: 5,
                user: { id: 5, username: "owner", display_name: "Owner" },
            };
        },
        async issueToken(params) {
            state.issued.push(params);
            return {
                success: true,
                accessToken: "zc_editor",
                expiresAt: new Date("2027-01-01T00:00:00.000Z"),
            };
        },
    },
});
mock.module(moduleUrl("../../services/auth/scopes.js"), {
    namedExports: {
        tokenContextCanGrantScopes(tokenType, currentTokenScopes, requestedScopes) {
            state.contextChecks.push({ tokenType, currentTokenScopes, requestedScopes });
            if (tokenType === "session") return true;
            return requestedScopes.every((scope) => currentTokenScopes.includes(scope));
        },
        async userCanAccessResourceScope(_userId, scope) {
            return state.accountScopes.has(scope);
        },
    },
});

const { issueEditorSession, issueEditorToken } = await import("./tokenController.js");
const requestedScopes = [
    "user:read",
    "project:7:read",
    "project:7:update",
    "project:7:interact",
    "project:7:manage",
];

function request() {
    return {
        body: { project_id: 7 },
        query: {},
        headers: { origin: "https://app.example.test", "user-agent": "test-agent" },
        ip: "127.0.0.1",
        ipInfo: { clientIP: "127.0.0.1" },
    };
}

function response(locals = {}) {
    return {
        locals,
        statusCode: 200,
        headers: {},
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

beforeEach(() => {
    state.issued = [];
    state.contextChecks = [];
    state.accountScopes = new Set(requestedScopes.slice(1));
});

for (const tokenType of ["oauth", "personal"]) {
    test(`${tokenType} access tokens cannot mint editor scopes beyond their source grant`, async () => {
        const res = response({
            userid: 5,
            username: "owner",
            display_name: "Owner",
            tokenType,
            scopes: ["user:read", "project:7:read"],
        });

        await issueEditorToken(request(), res);

        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, "ZC_ERROR_SCOPE_ESCALATION");
        assert.equal(state.issued.length, 0);
        assert.deepEqual(state.contextChecks, [{
            tokenType,
            currentTokenScopes: ["user:read", "project:7:read"],
            requestedScopes,
        }]);
    });
}

test("session access tokens retain editor token issuance", async () => {
    const res = response({
        userid: 5,
        username: "owner",
        display_name: "Owner",
        tokenType: "session",
        scopes: [],
    });

    await issueEditorToken(request(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.token, "zc_editor");
    assert.deepEqual(state.issued[0].scopes, requestedScopes);
    assert.equal(state.issued[0].accessTokenExpiry, 60 * 60 * 24 * 365);
});

test("fully scoped personal tokens retain bounded editor token issuance", async () => {
    const res = response({
        userid: 5,
        username: "owner",
        display_name: "Owner",
        tokenType: "personal",
        scopes: requestedScopes.slice(),
    });

    await issueEditorToken(request(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(state.issued.length, 1);
    assert.deepEqual(state.contextChecks[0], {
        tokenType: "personal",
        currentTokenScopes: requestedScopes,
        requestedScopes,
    });
});

test("refresh-cookie editor sessions retain interactive issuance", async () => {
    const res = response();

    await issueEditorSession(request(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.token, "zc_editor");
    assert.equal(state.contextChecks[0].tokenType, "session");
    assert.deepEqual(state.contextChecks[0].currentTokenScopes, []);
    assert.equal(state.issued.length, 1);
});
