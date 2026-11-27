import assert from "node:assert/strict";
import {mock, test} from "node:test";

const noop = () => {};
const asyncNoop = async () => {};
const geetestMiddleware = (_req, _res, next) => next();
const loginWithPassword = asyncNoop;
const needLogin = (_req, _res, next) => next();
const controller = (overrides = {}) => new Proxy(overrides, {
    get(target, property) {
        return target[property] || noop;
    },
});

mock.module("bcrypt", {namedExports: {hash: asyncNoop}});
mock.module("../services/logger.js", {defaultExport: {debug: noop, error: noop, info: noop, warn: noop}});
mock.module("../services/prisma.js", {namedExports: {prisma: {}}});
mock.module("../services/global.js", {namedExports: {validateUsername: () => ({valid: true})}});
mock.module("../middleware/auth.js", {namedExports: {needAdmin: noop, needLogin, parseToken: noop}});
mock.module("../middleware/sudo.js", {namedExports: {requireSudo: noop}});
mock.module("../middleware/scope.js", {namedExports: {requireResource: () => noop, requireScope: () => noop}});
mock.module("../middleware.js", {namedExports: {tokenAuthMiddleware: noop}});
mock.module("../middleware/geetest.js", {defaultExport: geetestMiddleware});
mock.module("../middleware/rateLimit.js", {namedExports: {createRateLimit: () => needLogin}});
mock.module("../services/auth/policyEngine.js", {namedExports: {
    assignDefaultRolesToUser: asyncNoop,
    userSatisfiesPolicy: async () => true,
}});
mock.module("../services/auth/scopes.js", {namedExports: {scopeSatisfies: () => true}});
mock.module("../controllers/events.js", {namedExports: {createEvent: asyncNoop}});
mock.module("../controllers/users.js", {namedExports: {
    changeUsername: noop,
    getRecommendedUsersForUser: asyncNoop,
    sanitizeFeaturedProjects: asyncNoop,
    sanitizeFeaturedProjectsBatch: asyncNoop,
}});
mock.module("../utils/avatarUrl.js", {namedExports: {buildAvatarURL: asyncNoop}});
mock.module("../services/moderation/visibility.js", {namedExports: {
    assertCanWrite: asyncNoop,
    visibleWhere: async () => ({}),
}});

mock.module("../controllers/auth/index.js", {namedExports: {
    emailController: controller(),
    loginController: controller({loginWithPassword}),
    oauthController: controller(),
    passkeyController: controller(),
    registerController: controller(),
    tokenController: controller(),
    twoFactorController: controller(),
}});
mock.module("../controllers/oauth.js", {namedExports: {initializeOAuthProviders: noop}});
mock.module("../services/auth/verification.js", {namedExports: {
    invalidateTemporaryToken: asyncNoop,
    validateTemporaryToken: asyncNoop,
}});
mock.module("../services/auth/tokenUtils.js", {defaultExport: {}});
mock.module("../services/config/zcconfig.js", {defaultExport: {get: asyncNoop}});
mock.module("../services/social/atprotoAuthOAuth.js", {namedExports: {buildAtprotoAuthClientMetadata: asyncNoop}});
mock.module("../controllers/auth/unifiedAuthController.js", {namedExports: {
    auth: noop,
    getAuthMethods: noop,
    sendCode: noop,
}});

const {default: userRouter} = await import("./router_user.js");
const {default: accountRouter} = await import("./router_account.js");
const {default: authRouter} = await import("./router_auth.js");

function route(router, method, path) {
    return router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
}

function response(locals = {}) {
    return {
        body: null,
        locals,
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("legacy user router exposes no password login endpoint", () => {
    assert.equal(route(userRouter, "post", "/login"), undefined);
    assert.ok(route(userRouter, "post", "/change-password"));
});

test("supported password login retains CAPTCHA before credential verification", () => {
    const loginRoute = route(accountRouter, "post", "/login");
    assert.ok(loginRoute);
    assert.deepEqual(loginRoute.route.stack.map((layer) => layer.handle), [
        geetestMiddleware,
        loginWithPassword,
    ]);
});

test("generic authentication rejects password verification for public purposes", () => {
    const passwordGuard = route(authRouter, "post", "/authenticate").route.stack[0].handle;

    for (const purpose of ["login", "reset_password"]) {
        let continued = false;
        const res = response();

        passwordGuard({body: {method: "password", purpose}}, res, () => {
            continued = true;
        });

        assert.equal(continued, false);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, "ZC_ERROR_PASSWORD_AUTH_UNAVAILABLE");
    }
});

test("protected password purposes still require an interactive session", async () => {
    const purposeGuard = route(authRouter, "post", "/authenticate").route.stack[2].handle;
    const req = {body: {method: "password", purpose: "sudo"}};
    let continued = false;
    const unauthenticatedResponse = response();

    await purposeGuard(req, unauthenticatedResponse, () => {
        continued = true;
    });

    assert.equal(continued, false);
    assert.equal(unauthenticatedResponse.statusCode, 403);
    assert.equal(unauthenticatedResponse.body.code, "ZC_ERROR_SESSION_REQUIRED");

    const sessionResponse = response({tokenType: "session", scopes: []});
    await purposeGuard(req, sessionResponse, () => {
        continued = true;
    });
    assert.equal(continued, true);
});

test("generic authentication preserves protected and non-password methods", () => {
    const passwordGuard = route(authRouter, "post", "/authenticate").route.stack[0].handle;

    for (const body of [
        {method: "password", purpose: "sudo"},
        {method: "email", purpose: "login"},
    ]) {
        let continued = false;
        passwordGuard({body}, {}, () => {
            continued = true;
        });
        assert.equal(continued, true);
    }
});
