import crypto from "node:crypto";
import test, {beforeEach, mock} from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
const providers = {
    google: {id: 'google', enabled: true, redirectUri: 'https://api.example.test/account/oauth/google/callback'},
    github: {id: 'github', enabled: true, redirectUri: 'https://api.example.test/account/oauth/github/callback'},
};
const state = {
    cache: new Map(),
    generatedStates: [],
    callbackCalls: [],
    temporaryTokenCalls: [],
    validateResult: null,
    invalidateCalls: [],
    loginTokenCalls: [],
};

mock.module("../../services/logger.js", {
    defaultExport: {info: noop, warn: noop, error: noop, debug: noop},
});
mock.module("../../services/prisma.js", {
    namedExports: {
        prisma: {
            ow_users: {findUnique: async () => ({id: 7, username: 'alice', display_name: 'Alice'})},
            ow_users_contacts: {},
        },
    },
});
mock.module("../../services/memoryCache.js", {
    defaultExport: {
        get: (key) => state.cache.get(key) || null,
        set: (key, value) => state.cache.set(key, value),
        delete: (key) => state.cache.delete(key),
    },
});
mock.module("../oauth.js", {
    namedExports: {
        OAUTH_PROVIDERS: providers,
        generateAuthUrl: async (provider, oauthState) => {
            state.generatedStates.push(oauthState);
            return `https://provider.example.test/authorize?provider=${provider}&state=${oauthState}`;
        },
        handleOAuthCallback: async (...args) => {
            state.callbackCalls.push(args);
            return {
                success: true,
                user: {id: 7, username: 'alice', display_name: 'Alice', avatar: null},
                contact: {contact_type: 'email', contact_value: 'alice@example.test'},
            };
        },
        handleOAuthSyncBind: async () => ({success: true}),
        resolveTwitterOAuthStateByRequestToken: () => null,
    },
});
mock.module("../../services/social/atprotoAuthOAuth.js", {
    namedExports: {getAtprotoAuthAppStateByCallbackState: async () => null},
});
mock.module("../../services/config/zcconfig.js", {
    defaultExport: {get: async (key) => key === 'urls.frontend' ? 'https://frontend.example.test' : null},
});
mock.module("../../services/auth/verification.js", {
    namedExports: {
        createTemporaryToken: async (...args) => {
            state.temporaryTokenCalls.push(args);
            return {success: true, token: 'one-time-login-token'};
        },
        validateTemporaryToken: async () => state.validateResult,
        invalidateTemporaryToken: async (token) => {
            state.invalidateCalls.push(token);
            return {success: true};
        },
    },
});
mock.module("../../services/auth/tokenUtils.js", {
    defaultExport: {
        getUserInfoForToken: async (user, email) => ({...user, email}),
        createUserLoginTokens: async (...args) => {
            state.loginTokenCalls.push(args);
            return {success: true, tokenId: 11, accessToken: 'access'};
        },
        generateLoginResponse: (user, _tokens, email) => ({
            status: 'success',
            userid: user.id,
            username: user.username,
            email,
        }),
        respondWithBrowserAuthTokens: (res, body) => res.status(200).json(body),
    },
});

const controller = await import("./oauthController.js");

function secureRequest(overrides = {}) {
    return {
        params: {provider: 'google'},
        query: {},
        cookies: {},
        headers: {'user-agent': 'security-test'},
        hostname: 'api.example.test',
        secure: true,
        ip: '192.0.2.10',
        ...overrides,
    };
}

function response(req, userid = 7) {
    return {
        req,
        locals: {userid},
        cookiesSet: [],
        cookiesCleared: [],
        statusCode: 200,
        cookie(name, value, options) {
            this.cookiesSet.push({name, value, options});
            return this;
        },
        clearCookie(name, options) {
            this.cookiesCleared.push({name, options});
            return this;
        },
        redirect(url) {
            this.redirectUrl = url;
            return this;
        },
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

async function beginLogin(redirect = null) {
    const req = secureRequest({query: redirect ? {redirect} : {}});
    const res = response(req);
    await controller.authWithOAuth(req, res);
    const oauthState = state.generatedStates.at(-1);
    const transactionCookie = res.cookiesSet.find(({name}) => name.startsWith('oauth_transaction_'));
    return {req, res, oauthState, transactionCookie};
}

async function completeProviderCallback(started, overrides = {}) {
    const req = secureRequest({
        query: {code: 'provider-code', state: started.oauthState},
        cookies: {[started.transactionCookie.name]: started.transactionCookie.value},
        ...overrides,
    });
    const res = response(req);
    await controller.handleOAuthCallbackRequest(req, res);
    return {req, res};
}

beforeEach(() => {
    state.cache.clear();
    state.generatedStates = [];
    state.callbackCalls = [];
    state.temporaryTokenCalls = [];
    state.validateResult = null;
    state.invalidateCalls = [];
    state.loginTokenCalls = [];
});

test("OAuth initiation binds state to provider, flow, redirect URI, and an HttpOnly browser cookie", async () => {
    const started = await beginLogin('/projects/7');
    const cached = state.cache.get(`oauth_state:${started.oauthState}`);

    assert.equal(cached.provider, 'google');
    assert.equal(cached.flow, 'login');
    assert.equal(cached.redirectUri, providers.google.redirectUri);
    assert.equal(cached.context.redirect, '/projects/7');
    assert.equal(
        cached.browserBindingHash,
        crypto.createHash('sha256').update(started.transactionCookie.value).digest('hex')
    );
    assert.deepEqual(started.transactionCookie.options, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/account/oauth',
        maxAge: 600000,
    });
});

test("OAuth binding preserves same-browser account binding and clears its transaction cookie", async () => {
    const beginReq = secureRequest();
    const beginRes = response(beginReq, 7);
    await controller.bindOAuth(beginReq, beginRes);
    const oauthState = state.generatedStates.at(-1);
    const transactionCookie = beginRes.cookiesSet.find(({name}) => name.startsWith('oauth_transaction_'));
    const cached = state.cache.get(`oauth_state:${oauthState}`);

    assert.equal(cached.flow, 'bind');
    assert.equal(cached.provider, 'google');

    const callbackReq = secureRequest({
        query: {code: 'provider-code', state: oauthState},
        cookies: {[transactionCookie.name]: transactionCookie.value},
    });
    const callbackRes = response(callbackReq);
    await controller.handleOAuthCallbackRequest(callbackReq, callbackRes);

    assert.equal(state.callbackCalls.length, 1);
    assert.equal(state.callbackCalls[0][2], 7);
    assert.equal(callbackRes.redirectUrl, 'https://frontend.example.test/app/account/oauth/bind/success');
    assert.equal(callbackRes.cookiesCleared.some(({name}) => name === transactionCookie.name), true);
});

test("OAuth callback rejects a different browser before exchanging the provider code", async () => {
    const started = await beginLogin();
    const req = secureRequest({query: {code: 'provider-code', state: started.oauthState}});
    const res = response(req);

    await controller.handleOAuthCallbackRequest(req, res);

    assert.equal(state.callbackCalls.length, 0);
    assert.equal(state.cache.has(`oauth_state:${started.oauthState}`), true);
    assert.match(res.redirectUrl, /\/app\/account\/oauth\/login\/error/);
});

test("OAuth callback rejects provider, flow, and redirect URI mismatches without consuming state", async () => {
    const providerMismatch = await beginLogin();
    const providerReq = secureRequest({
        params: {provider: 'github'},
        query: {code: 'provider-code', state: providerMismatch.oauthState},
        cookies: {[providerMismatch.transactionCookie.name]: providerMismatch.transactionCookie.value},
    });
    await controller.handleOAuthCallbackRequest(providerReq, response(providerReq));

    const flowMismatch = await beginLogin();
    state.cache.get(`oauth_state:${flowMismatch.oauthState}`).flow = 'bind';
    await completeProviderCallback(flowMismatch);

    const redirectMismatch = await beginLogin();
    state.cache.get(`oauth_state:${redirectMismatch.oauthState}`).redirectUri =
        'https://api.example.test/account/oauth/other/callback';
    await completeProviderCallback(redirectMismatch);

    assert.equal(state.callbackCalls.length, 0);
    assert.equal(state.cache.has(`oauth_state:${providerMismatch.oauthState}`), true);
    assert.equal(state.cache.has(`oauth_state:${flowMismatch.oauthState}`), true);
    assert.equal(state.cache.has(`oauth_state:${redirectMismatch.oauthState}`), true);
});

test("OAuth callback keeps the one-time credential out of URLs and preserves the requested redirect", async () => {
    const started = await beginLogin('/projects/7');
    const browserBindingHash = crypto.createHash('sha256')
        .update(started.transactionCookie.value)
        .digest('hex');
    const completed = await completeProviderCallback(started);
    const redemptionTransactionCookie = completed.res.cookiesSet.find(
        ({name}) => name === started.transactionCookie.name
    );
    const loginCookie = completed.res.cookiesSet.find(({name}) => name === 'oauth_login_token');
    const tokenCall = state.temporaryTokenCalls[0];

    assert.equal(state.callbackCalls.length, 1);
    assert.equal(state.cache.has(`oauth_state:${started.oauthState}`), false);
    assert.equal(tokenCall[3], 600);
    assert.deepEqual(tokenCall[2].oauthTransaction, {
        state: started.oauthState,
        provider: 'google',
        flow: 'login',
        redirectUri: providers.google.redirectUri,
        browserBindingHash,
    });
    assert.equal(loginCookie.value, 'one-time-login-token');
    assert.equal(redemptionTransactionCookie.value, started.transactionCookie.value);
    assert.equal(redemptionTransactionCookie.options.sameSite, 'none');
    assert.deepEqual(loginCookie.options, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/account/oauth/validate-token',
        maxAge: 600000,
    });
    assert.equal(
        completed.res.redirectUrl,
        'https://frontend.example.test/app/account/oauth/callback?redirect=%2Fprojects%2F7'
    );
    assert.equal(completed.res.redirectUrl.includes('one-time-login-token'), false);
    assert.equal(completed.res.redirectUrl.includes('temp_token'), false);
});

test("OAuth login redemption requires the initiating browser and preserves the normal login response", async () => {
    const started = await beginLogin();
    const completed = await completeProviderCallback(started);
    const loginCookie = completed.res.cookiesSet.find(({name}) => name === 'oauth_login_token');
    state.validateResult = {
        success: true,
        data: state.temporaryTokenCalls[0][2],
    };

    const wrongBrowserReq = secureRequest({cookies: {[loginCookie.name]: loginCookie.value}});
    const wrongBrowserRes = response(wrongBrowserReq);
    await controller.validateOAuthLoginToken(wrongBrowserReq, wrongBrowserRes);
    assert.equal(wrongBrowserRes.statusCode, 401);
    assert.equal(state.loginTokenCalls.length, 0);

    const legitimateReq = secureRequest({
        cookies: {
            [loginCookie.name]: loginCookie.value,
            [started.transactionCookie.name]: started.transactionCookie.value,
        },
    });
    const legitimateRes = response(legitimateReq);
    await controller.validateOAuthLoginToken(legitimateReq, legitimateRes);

    assert.equal(legitimateRes.statusCode, 200);
    assert.equal(legitimateRes.body.status, 'success');
    assert.equal(legitimateRes.body.userid, 7);
    assert.equal(state.loginTokenCalls.length, 1);
    assert.deepEqual(state.invalidateCalls, ['one-time-login-token']);
    assert.equal(legitimateRes.cookiesCleared.some(({name}) => name === 'oauth_login_token'), true);
    assert.equal(legitimateRes.cookiesCleared.some(({name}) => name === started.transactionCookie.name), true);
});
