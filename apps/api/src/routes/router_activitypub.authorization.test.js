import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const routes = [];
const router = { use() {} };
for (const method of ['get', 'post', 'patch', 'delete']) {
    router[method] = (path, ...handlers) => {
        routes.push({ method, path, handlers });
        return router;
    };
}

const noop = () => {};
const needAdmin = function needAdmin(_req, _res, next) { next(); };
const requireSudo = function requireSudo(_req, _res, next) { next(); };
mock.module('express', {
    namedExports: { Router: () => router },
    defaultExport: { json: () => noop },
});
mock.module('../services/logger.js', { defaultExport: { error: noop } });
mock.module('../services/prisma.js', { namedExports: { prisma: {} } });
mock.module('../services/config/zcconfig.js', { defaultExport: {} });
mock.module('../middleware/auth.js', { namedExports: { needAdmin } });
mock.module('../middleware/sudo.js', { namedExports: { requireSudo } });
mock.module('../services/moderation/visibility.js', { namedExports: {
    visibleWhere: noop,
    canViewContent: noop,
} });
mock.module('../services/activitypub/index.js', { namedExports: Object.fromEntries([
    'AP_CONTENT_TYPE', 'AP_CONTEXT',
    'getInstanceDomain', 'getInstanceBaseUrl', 'getApEndpointBaseUrl', 'getStaticUrl',
    'isFederationEnabled', 'isApRequest', 'buildActorObject', 'getLocalUserByUsername',
    'verifyInboxRequest', 'buildUserOutbox', 'countRemoteFollowers', 'getRemoteFollowers',
    'buildOrderedCollection', 'buildOrderedCollectionPage', 'getNoteId', 'getNoteUrl',
    'postToNote', 'getCardUrl', 'buildCreateActivity', 'getActorUrl', 'ensureProxyUser',
    'resolveAndEnsureProxyUser', 'findProxyUserByActorUrl', 'listProxyUsers',
    'searchProxyUsers', 'isRemoteProxyUser', 'getRemoteUserInfo', 'getProxyUserActorUrl',
    'REMOTE_USER_TYPE', 'getFederationConfig', 'setInstancePolicy', 'setAllowedInstances',
    'setBlockedInstances', 'addAllowedInstance', 'removeAllowedInstance',
    'addBlockedInstance', 'removeBlockedInstance', 'isInstanceAllowed',
    'isRemoteSearchAllowed', 'fetchRemoteUserPosts', 'getRemoteUserLocalPosts',
    'federatedUserSearch', 'parseFediAddress', 'getOutboundFollows',
].map(name => [name, noop])) });

await import('./router_activitypub.js');

const adminRoutes = routes.filter(route => route.path.startsWith('/admin/'));

test('every ActivityPub admin route uses the central admin authorization boundary', () => {
    assert.equal(adminRoutes.length, 21);
    for (const route of adminRoutes) {
        assert.equal(route.handlers[0], needAdmin, `${route.method.toUpperCase()} ${route.path}`);
        assert.equal(typeof route.handlers.at(-1), 'function');
    }
});

test('critical ActivityPub configuration requires an interactive sudo session', () => {
    for (const [method, path] of [['post', '/admin/setup'], ['patch', '/admin/federation']]) {
        const route = routes.find(candidate => candidate.method === method && candidate.path === path);
        assert.deepEqual(route.handlers.slice(0, -1), [needAdmin, requireSudo]);
    }
});
