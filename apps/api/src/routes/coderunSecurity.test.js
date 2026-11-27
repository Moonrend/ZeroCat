import test, {beforeEach, mock} from 'node:test';
import assert from 'node:assert/strict';

const state = {};
const noop = () => {};

mock.module('../services/prisma.js', {namedExports: {prisma: {
    ow_coderun_devices: {findFirst: async ({where}) => where.runner_token === 'runner-token' ? state.device : null},
}}});
mock.module('../services/config/zcconfig.js', {defaultExport: {get: async (key, fallback) => {
    state.configReads.push(key);
    if (key === 'security.jwttoken') return 'api-signing-secret';
    if (key === 'coderun.pool_size') return 5;
    return fallback;
}}});
mock.module('../services/logger.js', {defaultExport: {debug: noop}});
mock.module('../services/coderunManager.js', {defaultExport: {getAllRunners: () => ({}), updateRunnerStatus: noop}});
mock.module('../services/cachekv.js', {namedExports: {getValue: async () => ({endpoint: 'wss://cloud.example'})}});
mock.module('../services/auth/tokenService.js', {namedExports: {verifyToken: noop}});
mock.module('../middleware/ipMiddleware.js', {defaultExport: noop});
mock.module('../middleware/auth.js', {namedExports: {needLogin: noop}});
mock.module('../services/auth/authorization.js', {namedExports: {authorize: noop}});
mock.module('../services/coderunCapability.js', {namedExports: {
    CODERUN_CAPABILITY_TTL_SECONDS: 30,
    CODERUN_SUBPROTOCOL_PREFIX: 'zerocat-terminal-v1.',
    issueCodeRunCapability: noop,
    consumeCodeRunCapability: noop,
}});

const {default: runnerRouter} = await import('./admin/coderun_runner.js');
const {extractTokenFromRequest} = await import('../middleware.js');

function handler(path) {
    return runnerRouter.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
}

function response() {
    return {
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

beforeEach(() => Object.assign(state, {
    configReads: [],
    device: {device_config: {poolSize: 2, customOption: true, jwtSecret: 'legacy-secret'}},
}));

test('runner config excludes API signing material after device overrides', async () => {
    const res = response();
    await handler('/config')({headers: {runner_token: 'runner-token'}}, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.config, {
        enabled: true,
        poolSize: 2,
        reportInterval: undefined,
        cloudconfig: {endpoint: 'wss://cloud.example'},
        customOption: true,
        terminalAuth: {
            type: 'one-time-capability',
            transport: 'websocket-subprotocol',
            subprotocolPrefix: 'zerocat-terminal-v1.',
            introspectionPath: '/coderun/session/introspect',
            expiresIn: 30,
            terminationMessageType: 'terminal.terminate',
        },
    });
    assert.equal(state.configReads.includes('security.jwttoken'), false);
    assert.equal(Object.hasOwn(res.body.config, 'jwtSecret'), false);
});

test('runner config still rejects unknown runner credentials', async () => {
    const res = response();
    await handler('/config')({headers: {runner_token: 'unknown'}}, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.deepEqual(state.configReads, []);
});

test('project capability routes preserve cookie authentication without changing normal query precedence', () => {
    assert.equal(extractTokenFromRequest({
        headers: {},
        cookies: {token: 'session-token'},
        query: {token: 'project-capability'},
    }, {preferCookie: true}), 'session-token');
    assert.equal(extractTokenFromRequest({
        headers: {authorization: 'Bearer explicit-token'},
        cookies: {token: 'session-token'},
        query: {token: 'project-capability'},
    }, {preferCookie: true}), 'explicit-token');
    assert.equal(extractTokenFromRequest({
        headers: {},
        cookies: {token: 'session-token'},
        query: {token: 'query-access-token'},
    }), 'query-access-token');
    assert.equal(extractTokenFromRequest({
        headers: {},
        cookies: {},
        query: {token: 'query-access-token'},
    }), 'query-access-token');
});
