import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const url = path => new URL(path, import.meta.url).href;
const next = (_req, _res, done) => done();
const needAdmin = (_req, _res, done) => done();
mock.module(url('../middleware/auth.js'), { namedExports: { needLogin: next, needAdmin } });
mock.module(url('../middleware/scope.js'), { namedExports: {
    requireScope(required, options = {}) { return Object.assign(() => {}, { required, options }); },
    requireResource(resource, action, selector, options = {}) { return Object.assign(() => {}, { resource, action, selector, options }); },
} });
mock.module(url('../services/logger.js'), { defaultExport: {} });
const adminSends = [];
mock.module(url('../controllers/notifications.js'), { defaultExport: {
    async adminSendUnified(payload) {
        adminSends.push(payload);
        return { successful: [{}], total: 1 };
    },
} });
mock.module(url('../services/prisma.js'), { namedExports: { prisma: {} } });
mock.module(url('../services/pushNotification.js'), { namedExports: {
    registerPushSubscription() {}, unregisterPushSubscription() {}, getUserPushSubscriptions() {},
} });
const { default: router } = await import('./router_notifications.js');
const { default: adminRouter } = await import('./admin/notifications.js');
const guard = (method, path) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[1].handle;

for (const [method, path] of [
    ['post', '/mark-read'], ['put', '/read'], ['put', '/read_all'],
    ['post', '/register-browser'], ['delete', '/register-browser'], ['put', '/settings'], ['put', '/settings/bulk'],
]) {
    test(`${method.toUpperCase()} ${path} permits private state under readonly without losing token checks`, () => {
        const middleware = guard(method, path);
        assert.equal(middleware.options.action, 'private');
        assert.equal(middleware.required || `${middleware.resource}:${middleware.action}`, 'notification:update');
    });
}

test('the self-service notification router exposes no send endpoints', () => {
    for (const path of ['/send', '/send-enhanced']) {
        const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods.post);
        assert.equal(route, undefined);
    }
});

const adminSendRoute = adminRouter.stack.find(layer => layer.route?.path === '/send' && layer.route.methods.post).route;

test('the supported notification sender remains admin guarded', () => {
    assert.equal(adminSendRoute.stack[0].handle, needAdmin);
});

test('the admin notification sender derives its actor from the authenticated administrator', async () => {
    adminSends.length = 0;
    const req = { body: { recipients: 9, title: 'notice', content: 'content', actor_id: 1234 } };
    const res = { locals: { userid: 42 }, json() {}, status() { return this; } };

    await adminSendRoute.stack.at(-1).handle(req, res);

    assert.equal(adminSends.length, 1);
    assert.equal(adminSends[0].adminId, 42);
    assert.equal(adminSends[0].notificationConfig.actorId, 42);
    assert.equal(adminSends[0].notificationConfig.metadata.admin_id, 42);
});
