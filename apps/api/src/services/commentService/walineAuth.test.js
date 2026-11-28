import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const state = {};

mock.module('jsonwebtoken', { defaultExport: {
    sign(payload, secret, options) {
        state.signed = { payload, secret, options };
        return 'signed-waline-token';
    },
    verify(token, secret, options) {
        state.verified = { token, secret, options };
        return structuredClone(state.payload);
    },
} });
mock.module(url('../logger.js'), { defaultExport: { debug() {} } });
mock.module(url('../prisma.js'), { namedExports: { prisma: {
    ow_tokens: {
        async findUnique() { return structuredClone(state.parentToken); },
    },
    ow_comment_tokens: {
        async create(args) { state.created = args.data; return args.data; },
        async findUnique() { return structuredClone(state.derivedToken); },
        async updateMany(args) { state.revoked = args; return { count: 1 }; },
    },
} } });
mock.module(url('../auth/tokenService.js'), { namedExports: {
    async getEffectiveTokenScopes() { return [...state.parentScopes]; },
} });
mock.module(url('../auth/authorization.js'), { namedExports: {
    async authorize({ requiredScope }) {
        state.authorized.push(requiredScope);
        return { allowed: !state.deniedScopes.has(requiredScope) };
    },
} });

const {
    createWalineToken,
    revokeWalineToken,
    verifyWalineToken,
} = await import('./walineAuth.js');

beforeEach(() => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const jti = '0123456789abcdef0123456789abcdef';
    Object.assign(state, {
        authorized: [],
        created: null,
        deniedScopes: new Set(),
        parentScopes: ['comment:create'],
        parentToken: {
            id: 41,
            user_id: 7,
            type: 'oauth',
            scopes: ['comment:create'],
            revoked: false,
            expires_at: future,
            user: { status: 'active' },
        },
        payload: {
            sub: '7',
            jti,
            purpose: 'waline',
            spaceCuid: 'space-cuid',
            parentTokenId: 41,
            scopes: ['comment:create'],
        },
        derivedToken: {
            jti,
            user_id: 7,
            space_id: 3,
            parent_token_id: 41,
            scopes: ['comment:create'],
            expires_at: future,
            revoked_at: null,
            parent_token: {
                id: 41,
                user_id: 7,
                type: 'oauth',
                scopes: ['comment:create'],
                revoked: false,
                expires_at: future,
                user: { status: 'active' },
            },
        },
        revoked: null,
        signed: null,
        verified: null,
    });
});

test('issuance attenuates a comment:create parent into a short-lived space credential', async () => {
    const token = await createWalineToken({
        userId: 7,
        jwtSecret: 'space-secret',
        spaceId: 3,
        spaceCuid: 'space-cuid',
        parentTokenId: 41,
    });

    assert.equal(token, 'signed-waline-token');
    assert.deepEqual(state.signed.payload.scopes, ['comment:create']);
    assert.equal(state.signed.payload.purpose, 'waline');
    assert.equal(state.signed.payload.spaceCuid, 'space-cuid');
    assert.equal(state.signed.payload.parentTokenId, 41);
    assert.deepEqual(state.signed.options, {
        algorithm: 'HS256',
        audience: 'zerocat:waline:space-cuid',
        issuer: 'zerocat:commentservice',
        subject: '7',
        jwtid: state.created.jti,
        expiresIn: 900,
    });
    assert.match(state.created.jti, /^[a-f0-9]{32}$/);
    assert.equal(state.created.parent_token_id, 41);
    assert.equal(state.created.space_id, 3);
    assert.deepEqual(state.created.scopes, ['comment:create']);
});

test('verification removes capabilities no longer granted by the parent token', async () => {
    state.payload.scopes = ['comment:create', 'comment:update'];
    state.derivedToken.scopes = ['comment:create', 'comment:update'];
    state.parentScopes = ['comment:create'];

    const result = await verifyWalineToken('signed-waline-token', 'space-secret', {
        spaceId: 3,
        spaceCuid: 'space-cuid',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.scopes, ['comment:create']);
    assert.deepEqual(state.verified.options, {
        algorithms: ['HS256'],
        audience: 'zerocat:waline:space-cuid',
        issuer: 'zerocat:commentservice',
    });
});

test('verification rejects a derived token after parent revocation', async () => {
    state.derivedToken.parent_token.revoked = true;

    const result = await verifyWalineToken('signed-waline-token', 'space-secret', {
        spaceId: 3,
        spaceCuid: 'space-cuid',
    });

    assert.deepEqual(result, { valid: false, userId: null, scopes: [] });
    assert.deepEqual(state.authorized, []);
});

test('logout revokes only the presented derived token record', async () => {
    assert.equal(await revokeWalineToken('signed-waline-token'), true);
    assert.deepEqual(state.revoked.where, {
        token_hash: crypto.createHash('sha256').update('signed-waline-token').digest('hex'),
        revoked_at: null,
    });
    assert.equal(state.revoked.where.token_hash.length, 64);
    assert.ok(state.revoked.data.revoked_at instanceof Date);
});
