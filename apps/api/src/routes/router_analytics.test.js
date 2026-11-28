import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};
const routes = [];
const router = {
    get(path, ...handlers) {
        routes.push({method: 'get', path, handlers});
        return this;
    },
    post(path, ...handlers) {
        routes.push({method: 'post', path, handlers});
        return this;
    },
};

const db = {
    ow_analytics_device: {
        async findFirst(args) {
            state.deviceReads.push(args);
            return null;
        },
        async create(args) {
            state.deviceWrites.push(args);
            return {id: 91};
        },
    },
    ow_analytics_event: {
        async create(args) {
            state.eventWrites.push(args);
            return {id: 101};
        },
        async count(args) {
            state.countQueries.push(args);
            return state.eventCount;
        },
    },
    async $transaction(callback) {
        return callback(this);
    },
};

const strictTokenCheck = (_req, res, next) => {
    if (!res.locals.userid || !res.locals.tokenId) {
        return res.status(401).json({status: 'error', code: 'ZC_ERROR_NEED_LOGIN'});
    }
    next();
};
const requireScope = required => Object.assign((_req, res, next) => {
    state.requiredScopes.push(required);
    if (!res.locals.scopes?.includes(required)) {
        return res.status(403).json({status: 'error', code: 'ZC_ERROR_INSUFFICIENT_SCOPE'});
    }
    next();
}, {required});

mock.module('express', {defaultExport: {Router: () => router}});
mock.module('ua-parser-js', {namedExports: {UAParser: class {
    getResult() {
        return {browser: {}, os: {}, device: {}};
    }
}}});
mock.module(url('../services/prisma.js'), {namedExports: {prisma: db}});
mock.module(url('../services/logger.js'), {defaultExport: {
    error() {},
    info(message, details) {
        state.auditLogs.push({message, details});
    },
}});
mock.module(url('../services/ip/ipLocation.js'), {defaultExport: {
    async getIPLocation() {
        return {};
    },
}});
mock.module(url('../middleware/auth.js'), {namedExports: {strictTokenCheck}});
mock.module(url('../middleware/scope.js'), {namedExports: {requireScope}});
await import('./router_analytics.js');

beforeEach(() => Object.assign(state, {
    auditLogs: [],
    countQueries: [],
    deviceReads: [],
    deviceWrites: [],
    eventCount: 12,
    eventWrites: [],
    requiredScopes: [],
}));

function response(locals = {}) {
    return {
        body: undefined,
        ended: false,
        locals,
        statusCode: 200,
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.body = value;
            this.ended = true;
            return this;
        },
    };
}

async function invoke(method, path, {body = {}, headers = {}, locals = {}, query = {}} = {}) {
    const route = routes.find(item => item.method === method && item.path === path);
    assert.ok(route, `${method.toUpperCase()} ${path} must be registered`);
    const req = {body, headers, ip: '127.0.0.1', query};
    const res = response(locals);

    for (const handler of route.handlers) {
        let nextCalled = false;
        let nextError;
        await handler(req, res, error => {
            nextCalled = true;
            nextError = error;
        });
        if (nextError) throw nextError;
        if (res.ended || !nextCalled) break;
    }
    return res;
}

const validRange = {
    start_at: '2026-01-01T00:00:00.000Z',
    end_at: '2026-01-31T00:00:00.000Z',
};

test('analytics statistics reject anonymous and ordinary analytics readers', async () => {
    const anonymous = await invoke('get', '/stats', {query: validRange});
    assert.equal(anonymous.statusCode, 401);

    const ordinaryReader = await invoke('get', '/stats', {
        locals: {userid: 7, tokenId: 55, scopes: ['analytics:read']},
        query: validRange,
    });
    assert.equal(ordinaryReader.statusCode, 403);
    assert.deepEqual(state.requiredScopes, ['admin:analytics:read']);
    assert.equal(state.countQueries.length, 0);
});

test('authorized statistics return one bounded privacy-minimized aggregate', async () => {
    const res = await invoke('get', '/stats', {
        locals: {userid: 7, tokenId: 55, scopes: ['admin:analytics:read']},
        query: validRange,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {success: true, data: {...validRange, event_count: 12}});
    assert.deepEqual(state.countQueries, [{where: {created_at: {
        gte: new Date(validRange.start_at),
        lte: new Date(validRange.end_at),
    }}}]);
    assert.deepEqual(state.auditLogs, [{
        message: '[analytics] Aggregate stats accessed',
        details: {actor_id: 7, ...validRange, event_count: 12},
    }]);
});

test('statistics reject broad ranges and identity filters before querying', async () => {
    const requests = [
        {start_at: '2026-01-01T00:00:00.000Z', end_at: '2026-02-02T00:00:00.000Z'},
        {...validRange, fingerprint: 'device-fingerprint'},
        {...validRange, user_id: '42'},
    ];

    for (const query of requests) {
        const res = await invoke('get', '/stats', {
            locals: {userid: 7, tokenId: 55, scopes: ['admin:analytics:read']},
            query,
        });
        assert.equal(res.statusCode, 400);
    }
    assert.equal(state.countQueries.length, 0);
});

test('public analytics ingestion remains available', async () => {
    const res = await invoke('post', '/send', {
        body: {
            fingerprint: 'anonymous-device',
            hostname: 'example.test',
            screen: '1920x1080',
            language: 'en',
            url: 'https://example.test/page',
            referrer: 'https://example.test/',
            page_title: 'Page',
            target_type: 'page',
            target_id: 1,
        },
        headers: {'user-agent': 'test-agent'},
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {success: true});
    assert.equal(state.deviceWrites.length, 1);
    assert.equal(state.eventWrites.length, 1);
});
