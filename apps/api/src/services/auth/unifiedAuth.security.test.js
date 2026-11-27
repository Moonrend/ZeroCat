import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const state = {
    challenges: new Map(),
    issueCounts: new Map(),
    notifications: []
};
const moduleUrl = path => new URL(path, import.meta.url).href;

const rejectChallenge = (key, challenge, maxAttempts) => {
    challenge.attemptsRemaining = (challenge.attemptsRemaining ?? maxAttempts) - 1;
    if (challenge.attemptsRemaining <= 0) {
        state.challenges.delete(key);
        return { status: 'locked', attemptsRemaining: 0 };
    }
    return { status: 'invalid', attemptsRemaining: challenge.attemptsRemaining };
};

const redis = {
    async incrementWithExpiry(key) {
        const count = (state.issueCounts.get(key) || 0) + 1;
        state.issueCounts.set(key, count);
        return count;
    },
    async set(key, value) {
        state.challenges.set(key, structuredClone(value));
        return true;
    },
    async consumeVerificationCode(key, { code, purpose, userId, maxAttempts }) {
        const challenge = state.challenges.get(key);
        if (!challenge) return { status: 'missing' };
        if (challenge.purpose !== purpose
            || (userId !== null && userId !== undefined && Number(challenge.userId) !== Number(userId))
            || challenge.code !== code) {
            return rejectChallenge(key, challenge, maxAttempts);
        }
        state.challenges.delete(key);
        return { status: 'valid', data: structuredClone(challenge) };
    }
};

mock.module(moduleUrl('../redis.js'), { defaultExport: redis });
mock.module(moduleUrl('../prisma.js'), { namedExports: { prisma: {
    ow_users_contacts: { findFirst: async () => ({ contact_id: 1 }) },
    ow_users: { findFirst: async () => null, findUnique: async () => null }
} } });
mock.module(moduleUrl('../logger.js'), { defaultExport: { info() {}, warn() {}, error() {} } });
mock.module(moduleUrl('../../controllers/notifications.js'), { namedExports: {
    createNotification: async notification => state.notifications.push(notification)
} });
mock.module(moduleUrl('../config/zcconfig.js'), { defaultExport: { get: async () => 'ZeroCat' } });
mock.module(moduleUrl('./twoFactor.js'), { defaultExport: {} });
mock.module('bcrypt', { defaultExport: { compare: async () => false } });

const { unifiedAuth } = await import('./unifiedAuth.js');

beforeEach(() => {
    state.challenges.clear();
    state.issueCounts.clear();
    state.notifications = [];
});

test('reset challenges reject a code issued for another purpose and exhaust its attempts', async () => {
    state.challenges.set('verify_code:purpose-bound', {
        code: '123456', userId: 7, purpose: 'login', attemptsRemaining: 2
    });

    const request = {
        method: 'email', purpose: 'reset_password', codeId: 'purpose-bound', code: '123456'
    };
    assert.equal((await unifiedAuth.authenticate(request)).success, false);
    assert.equal((await unifiedAuth.authenticate(request)).success, false);
    assert.equal(state.challenges.has('verify_code:purpose-bound'), false);
});

test('wrong reset codes lock the challenge before a later correct guess', async () => {
    state.challenges.set('verify_code:bounded', {
        code: '123456', userId: 7, purpose: 'reset_password', attemptsRemaining: 2
    });

    const request = { method: 'email', purpose: 'reset_password', codeId: 'bounded' };
    assert.equal((await unifiedAuth.authenticate({ ...request, code: '000000' })).success, false);
    assert.equal((await unifiedAuth.authenticate({ ...request, code: '111111' })).success, false);
    assert.equal((await unifiedAuth.authenticate({ ...request, code: '123456' })).success, false);
});

test('a valid purpose-bound reset challenge succeeds exactly once', async () => {
    state.challenges.set('verify_code:single-use', {
        code: '123456', userId: 7, purpose: 'reset_password', attemptsRemaining: 5
    });

    const request = {
        method: 'email', purpose: 'reset_password', codeId: 'single-use', code: '123456'
    };
    const accepted = await unifiedAuth.authenticate(request);
    assert.equal(accepted.success, true);
    assert.equal(accepted.user.id, 7);
    assert.equal((await unifiedAuth.authenticate(request)).success, false);
});

test('authenticated email challenges remain bound to the issuing user', async () => {
    state.challenges.set('verify_code:user-bound', {
        code: '123456', userId: 7, purpose: 'sudo', attemptsRemaining: 2
    });

    const request = { method: 'email', purpose: 'sudo', codeId: 'user-bound', code: '123456' };
    assert.equal((await unifiedAuth.authenticate({ ...request, userId: 8 })).success, false);
    const accepted = await unifiedAuth.authenticate({ ...request, userId: 7 });
    assert.equal(accepted.success, true);
    assert.equal(accepted.user.id, 7);
});

test('reset code issuance is capped per account without suppressing allowed notifications', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal((await unifiedAuth.sendVerificationCode(
            7, 'owner@example.test', 'reset_password'
        )).success, true);
    }

    assert.equal((await unifiedAuth.sendVerificationCode(
        7, 'owner@example.test', 'reset_password'
    )).success, false);
    assert.equal(state.notifications.length, 3);
    assert.equal(state.challenges.size, 3);
});
