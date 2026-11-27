import test, {mock} from 'node:test';
import assert from 'node:assert/strict';

mock.module('./prisma.js', {namedExports: {prisma: {}}});
mock.module('./logger.js', {defaultExport: {}});
mock.module('./config/zcconfig.js', {defaultExport: {}});
mock.module('./auth/policyEngine.js', {namedExports: {getUserPolicy: async () => ({})}});
mock.module('./auth/tokenUtils.js', {namedExports: {parseDeviceInfo: () => ({})}});

const values = new Map();
const ttls = new Map();
mock.module('./redis.js', {defaultExport: {
    async setIfNotExists(key, value, ttl) {
        if (values.has(key)) return false;
        values.set(key, value);
        ttls.set(key, ttl);
        return true;
    },
    async getAndDelete(key) {
        const value = values.get(key) || null;
        values.delete(key);
        return value;
    },
}});

const {
    CODERUN_CAPABILITY_PERMISSION,
    CODERUN_CAPABILITY_TTL_SECONDS,
    consumeCodeRunCapability,
    issueCodeRunCapability,
    isCodeRunCapability,
} = await import('./coderunCapability.js');
const {isValidRawTokenFormat} = await import('./auth/tokenService.js');

test('CodeRun capabilities are attenuated and single use', async () => {
    const issued = await issueCodeRunCapability({runnerId: 'runner-a', userId: 7, projectId: 42});

    assert.equal(isCodeRunCapability(issued.capability), true);
    assert.equal(isValidRawTokenFormat(issued.capability), false);
    assert.equal(issued.record.audience, 'coderun-runner:runner-a');
    assert.equal(issued.record.permission, CODERUN_CAPABILITY_PERMISSION);
    assert.equal(issued.record.user_id, 7);
    assert.equal(issued.record.project_id, 42);
    assert.deepEqual([...ttls.values()], [CODERUN_CAPABILITY_TTL_SECONDS]);

    assert.equal(await consumeCodeRunCapability(issued.capability, 'runner-b'), null);
    assert.deepEqual(await consumeCodeRunCapability(issued.capability, 'runner-a'), issued.record);
    assert.equal(await consumeCodeRunCapability(issued.capability, 'runner-a'), null);
});

test('expired CodeRun capabilities fail closed', async () => {
    const issued = await issueCodeRunCapability({runnerId: 'runner-a', userId: 7});
    issued.record.expires_at = Date.now() - 1;

    assert.equal(await consumeCodeRunCapability(issued.capability, 'runner-a'), null);
});
