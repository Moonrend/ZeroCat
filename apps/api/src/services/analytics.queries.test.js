import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const state = {};
mock.module(new URL('./prisma.js', import.meta.url).href, { namedExports: { prisma: {
    ow_analytics_event: { async findMany(query) { state.queries.push(query); return state.events; } },
    ow_target_configs: { async findFirst() { return { value: '12' }; } },
} } });
const { getAnalytics } = await import('./analytics.js');
beforeEach(() => Object.assign(state, { queries: [], events: [] }));

test('one event read supplies all-time counts and inclusive date-window distinct devices', async () => {
    const device = { browser: 'Test', os: 'TestOS', device_type: 'Desktop' };
    state.events = [
        { created_at: new Date('2026-01-02T02:00:00Z'), device_id: 1, device, country: 'CN' },
        { created_at: new Date('2026-01-01T23:59:59Z'), device_id: 2, device, country: 'US' },
        { created_at: new Date('2026-01-02T00:00:00Z'), device_id: 1, device, referrer_domain: 'example.test' },
        { created_at: new Date('2026-01-02T00:30:00Z'), device_id: 3, device: null },
        { created_at: new Date('2026-01-02T03:00:00Z'), device_id: 1, device },
    ];
    const result = await getAnalytics('project', 7, '2026-01-02T00:00:00Z', '2026-01-02T02:00:00Z');
    assert.equal(state.queries.length, 1);
    assert.equal(result.overview.pageviews.value, 17);
    assert.equal(result.overview.visitors.value, 3);
    assert.equal(result.overview.bounces.value, 2);
    assert.deepEqual(result.timeseries.pageviews, [
        { x: '2026-01-02T00:00:00', y: 2 }, { x: '2026-01-02T02:00:00', y: 1 },
    ]);
    assert.deepEqual(result.timeseries.sessions.map(row => row.y), [2, 1]);
    assert.deepEqual(result.browsers, [{ x: 'Test', y: 4 }]);
});

test('empty analytics retains zero counters and empty series', async () => {
    const result = await getAnalytics('user', 7, '2026-01-01', '2026-01-02');
    assert.equal(result.overview.pageviews.value, 0);
    assert.deepEqual(result.timeseries, { pageviews: [], sessions: [] });
    assert.equal(state.queries.length, 1);
});
