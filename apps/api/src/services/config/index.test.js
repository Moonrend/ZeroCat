import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const state = { reads: 0, fail: false, gate: null };
mock.module(new URL('../prisma.js', import.meta.url).href, { namedExports: { prisma: {
    ow_config: { async findMany() {
        state.reads++;
        if (state.gate) await state.gate;
        if (state.fail) throw new Error('database unavailable');
        return [{ key: 'site.name', value: 'Test Site' }];
    } },
} } });
mock.module(new URL('./configTypes.js', import.meta.url).href, { namedExports: {
    updateDynamicConfigTypes() {}, validateConfig(_key, value) { return value; },
} });
const { configService } = await import('./index.js');

test('concurrent cold config readers share one load and failed initialization can retry', async () => {
    let release;
    state.gate = new Promise(resolve => { release = resolve; });
    const reads = Array.from({ length: 20 }, () => configService.get('site.name'));
    assert.equal(state.reads, 1);
    release();
    assert.deepEqual(await Promise.all(reads), Array(20).fill('Test Site'));
    assert.equal(await configService.get('site.name'), 'Test Site');
    assert.equal(state.reads, 1);

    state.gate = null;
    state.fail = true;
    const errors = mock.method(console, 'error', () => {});
    await assert.rejects(configService.reload(), /database unavailable/);
    errors.mock.restore();
    state.fail = false;
    assert.equal(await configService.get('site.name'), 'Test Site');
    assert.equal(state.reads, 3);
});
