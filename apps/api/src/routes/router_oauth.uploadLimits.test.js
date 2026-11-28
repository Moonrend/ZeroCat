import test, { mock } from "node:test";
import assert from "node:assert/strict";

const state = { routes: [] };
const noop = () => {};
const routeMiddleware = () => {};
const uploadMiddleware = () => {};
const router = {};

for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (path, ...handlers) => {
        state.routes.push({ method, path, handlers });
        return router;
    };
}

const memoryStorage = {};
const multer = (options) => {
    state.multerOptions = options;
    return {
        single(field) {
            state.singleField = field;
            state.uploadMiddleware = uploadMiddleware;
            return uploadMiddleware;
        },
    };
};
multer.memoryStorage = () => memoryStorage;

mock.module("express", { namedExports: { Router: () => router } });
mock.module("multer", { defaultExport: multer });
mock.module("../services/logger.js", {
    defaultExport: { debug: noop, error: noop, info: noop, warn: noop },
});
mock.module("../services/config/zcconfig.js", { defaultExport: { get: async () => "" } });
mock.module("../services/prisma.js", { namedExports: { prisma: {} } });
mock.module("../services/global.js", { namedExports: { S3update: noop } });
mock.module("../middleware/auth.js", { namedExports: { needLogin: routeMiddleware } });
mock.module("../middleware/scope.js", {
    namedExports: { requireResource: () => routeMiddleware, requireScope: () => routeMiddleware },
});
mock.module("../middleware/rateLimit.js", { namedExports: { oauthRateLimit: routeMiddleware } });
mock.module("../services/auth/oauth.js", {
    namedExports: {
        generateAuthCode: noop,
        validatePKCE: noop,
        validateRedirectUri: noop,
        validateScopes: noop,
    },
});
mock.module("../services/auth/scopes.js", {
    namedExports: {
        isScopeSubset: noop,
        normalizeScopes: noop,
        scopeSatisfies: noop,
        tokenContextCanGrantScopes: noop,
        validateUserGrantableScopes: noop,
    },
});
mock.module("../services/auth/policyEngine.js", {
    namedExports: { userSatisfiesPolicy: noop },
});
mock.module("../services/auth/tokenManager.js", {
    namedExports: {
        generateOAuthTokens: noop,
        refreshOAuthTokens: noop,
        verifyOAuthClientCredentials: noop,
    },
});
mock.module("../services/auth/tokenService.js", { namedExports: { revokeTokensWhere: noop } });
mock.module("../services/assets.js", { namedExports: { handleAssetUpload: noop } });
mock.module("../middleware/sudo.js", { namedExports: { requireSudo: routeMiddleware } });

await import("./router_oauth.js");

test("OAuth logo parser bounds buffered multipart files and fields", () => {
    assert.equal(state.multerOptions.storage, memoryStorage);
    assert.deepEqual(state.multerOptions.limits, {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fieldSize: 64 * 1024,
        fields: 0,
        parts: 1,
    });
});

test("OAuth logo route preserves its single-file upload contract", () => {
    const logoRoute = state.routes.find(
        ({ method, path }) => method === "post" && path === "/applications/:client_id/logo",
    );

    assert.ok(logoRoute);
    assert.equal(state.singleField, "zcfile");
    assert.equal(logoRoute.handlers[2], state.uploadMiddleware);
    assert.equal(typeof logoRoute.handlers[3], "function");
});
