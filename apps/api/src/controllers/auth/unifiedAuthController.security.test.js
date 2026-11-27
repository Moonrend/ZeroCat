import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const state = {};
const moduleUrl = path => new URL(path, import.meta.url).href;
const noop = () => {};

mock.module(moduleUrl('../../services/logger.js'), {
    defaultExport: { info: noop, warn: noop, error: noop }
});
mock.module(moduleUrl('../../services/prisma.js'), { namedExports: { prisma: {
    ow_users_contacts: {
        findFirst: async () => state.userExists
            ? { user_id: 7, user: { status: 'active' } }
            : null
    },
    ow_users: { findFirst: async () => null }
} } });
mock.module(moduleUrl('../../services/auth/unifiedAuth.js'), { namedExports: {
    sendVerificationCode: async () => {
        state.sendCalls += 1;
        return state.sendResult;
    },
    authenticate: async () => ({ success: false })
} });
mock.module(moduleUrl('../../services/global.js'), { namedExports: {
    hash: value => value,
    userpwTest: () => true
} });
mock.module(moduleUrl('../../services/auth/sudoAuth.js'), { namedExports: {
    generateSudoToken: async () => ({ token: 'sudo' })
} });

const { sendCode } = await import('./unifiedAuthController.js');
const response = () => ({
    locals: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

beforeEach(() => {
    Object.assign(state, {
        userExists: false,
        sendCalls: 0,
        sendResult: { success: true, codeId: 'real-challenge' }
    });
});

test('password reset code issuance does not reveal whether the email exists', async () => {
    const missingResponse = response();
    await sendCode({ body: {
        email: 'missing@example.test', purpose: 'reset_password'
    } }, missingResponse);

    state.userExists = true;
    const existingResponse = response();
    await sendCode({ body: {
        email: 'owner@example.test', purpose: 'reset_password'
    } }, existingResponse);

    assert.equal(missingResponse.statusCode, 200);
    assert.equal(existingResponse.statusCode, 200);
    assert.equal(missingResponse.body.status, existingResponse.body.status);
    assert.equal(missingResponse.body.message, existingResponse.body.message);
    assert.equal(state.sendCalls, 1);
    assert.equal(existingResponse.body.data.code_id, 'real-challenge');
});

test('password reset issuance limits retain the same public response', async () => {
    state.userExists = true;
    state.sendResult = { success: false, message: 'rate limited' };
    const res = response();

    await sendCode({ body: {
        email: 'owner@example.test', purpose: 'reset_password'
    } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'success');
    assert.equal(typeof res.body.data.code_id, 'string');
});
