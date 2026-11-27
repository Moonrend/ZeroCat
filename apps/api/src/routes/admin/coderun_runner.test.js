import test, {beforeEach, mock} from 'node:test';
import assert from 'node:assert/strict';

const routes = [];
const router = {};
for (const method of ['get', 'post']) {
    router[method] = (path, ...handlers) => routes.push({method, path, handlers});
}
const pass = (_req, _res, next) => next();
const state = {};

mock.module('express', {namedExports: {Router: () => router}});
mock.module('../../middleware/auth.js', {namedExports: {needLogin: pass}});
mock.module('../../services/logger.js', {defaultExport: {debug() {}, error() {}}});
mock.module('../../services/config/zcconfig.js', {defaultExport: {get: async () => null}});
mock.module('../../services/cachekv.js', {namedExports: {getValue: async () => null}});
mock.module('../../services/coderunManager.js', {defaultExport: {
    getAllRunners: () => ({'runner-a': {status: 'active'}}),
    updateRunnerStatus: async () => {},
    handleRunnerReport: async () => {},
}});
mock.module('../../services/auth/authorization.js', {namedExports: {
    authorize: async (context) => {
        state.authorization = context;
        return state.projectVisible
            ? {allowed: true, status: 200}
            : {allowed: false, status: 404, code: 'ZC_ERROR_NOT_FOUND', message: 'Project not found'};
    },
}});
mock.module('../../services/coderunCapability.js', {namedExports: {
    CODERUN_CAPABILITY_TTL_SECONDS: 30,
    CODERUN_SUBPROTOCOL_PREFIX: 'zerocat-terminal-v1.',
    issueCodeRunCapability: async (input) => {
        state.issued = input;
        return {capability: 'zcr_capability', record: {expires_at: 123, session_id: 'session-a'}};
    },
    consumeCodeRunCapability: async (capability, runnerId) => {
        state.consumed = {capability, runnerId};
        return state.session;
    },
}});
mock.module('../../services/prisma.js', {namedExports: {prisma: {
    ow_projects: {findUnique: async () => ({id: 42, state: 'public'})},
    ow_coderun_devices: {
        findMany: async () => [{id: 'runner-a', device_name: 'Runner', request_url: 'https://runner.example/base?secret=x'}],
        findFirst: async ({where}) => where.runner_token === 'runner-secret' ? {id: 'runner-a'} : null,
        create: async () => ({}),
    },
}}});

await import('./coderun_runner.js');

function response(locals = {}) {
    return {
        locals,
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

function route(method, path) {
    return routes.find((candidate) => candidate.method === method && candidate.path === path);
}

beforeEach(() => {
    state.projectVisible = true;
    state.authorization = null;
    state.issued = null;
    state.consumed = null;
    state.session = {runner_id: 'runner-a', permission: 'terminal:connect'};
});

test('session issuance authenticates and binds the visible project', async () => {
    const selected = route('post', '/session');
    assert.equal(selected.handlers[0], pass);

    const res = response({userid: 7, tokenType: 'oauth', scopes: ['project:42:read']});
    await selected.handlers[1]({body: {project_id: 42}}, res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(state.authorization, {
        userId: 7,
        requiredScope: 'project:42:read',
        tokenType: 'oauth',
        tokenScopes: ['project:42:read'],
    });
    assert.deepEqual(state.issued, {runnerId: 'runner-a', userId: 7, projectId: 42});
    assert.equal(res.body.runner.request_url, 'https://runner.example/');
    assert.equal(res.body.capability, 'zcr_capability');
});

test('debug sessions retain type-wide authorization and session binding', async () => {
    const res = response({userid: 7, tokenType: 'session', scopes: []});
    await route('post', '/session').handlers[1]({body: {project_id: null}}, res);

    assert.equal(res.statusCode, 201);
    assert.equal(state.authorization.requiredScope, 'project:read');
    assert.deepEqual(state.issued, {runnerId: 'runner-a', userId: 7, projectId: null});
    assert.equal(typeof res.body.session_id, 'string');
});

test('runner introspection consumes the capability under its own audience', async () => {
    const res = response();
    await route('post', '/session/introspect').handlers[0](
        {headers: {runner_token: 'runner-secret'}, body: {capability: 'zcr_capability'}},
        res
    );

    assert.deepEqual(state.consumed, {capability: 'zcr_capability', runnerId: 'runner-a'});
    assert.deepEqual(res.body.session, state.session);
});

test('runner configuration advertises the capability handshake contract', async () => {
    const res = response();
    await route('get', '/config').handlers[0]({headers: {runner_token: 'runner-secret'}}, res);

    assert.deepEqual(res.body.config.terminalAuth, {
        type: 'one-time-capability',
        transport: 'websocket-subprotocol',
        subprotocolPrefix: 'zerocat-terminal-v1.',
        introspectionPath: '/coderun/session/introspect',
        expiresIn: 30,
        terminationMessageType: 'terminal.terminate',
    });
});

test('hidden projects cannot mint terminal capabilities', async () => {
    state.projectVisible = false;
    const res = response({userid: 7, tokenType: 'oauth', scopes: ['project:42:read']});

    await route('post', '/session').handlers[1]({body: {project_id: 42}}, res);

    assert.equal(res.statusCode, 404);
    assert.equal(state.issued, null);
});

test('runner endpoints reject missing credentials before reading a device', async () => {
    const introspection = response();
    await route('post', '/session/introspect').handlers[0]({headers: {}, body: {}}, introspection);
    assert.equal(introspection.statusCode, 401);
    assert.equal(state.consumed, null);

    const config = response();
    await route('get', '/config').handlers[0]({headers: {}}, config);
    assert.equal(config.statusCode, 401);
});
