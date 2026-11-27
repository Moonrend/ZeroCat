import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';

const moduleUrl = path => new URL(path, import.meta.url).href;
const state = {};

mock.module('node:dns/promises', { defaultExport: {
    async lookup(hostname) {
        state.lookups.push(hostname);
        const result = state.dns.get(hostname);
        if (result instanceof Error) throw result;
        return result || [];
    },
} });
mock.module('axios', { defaultExport: {
    async request(config) {
        state.requests.push(config);
        const response = state.responses.shift();
        if (!response) throw new Error('Unexpected HTTP request');
        return response;
    },
} });
mock.module(moduleUrl('./federationConfig.js'), { namedExports: {
    async isInstanceAllowed(host) {
        state.policyChecks.push(host);
        return state.allowed;
    },
} });

const {
    createPinnedLookup,
    federationGet,
    isPublicFederationAddress,
    publicNetworkGet,
    validateFederationDestination,
} = await import('./federationHttp.js');

beforeEach(() => Object.assign(state, {
    allowed: true,
    dns: new Map(),
    lookups: [],
    policyChecks: [],
    requests: [],
    responses: [],
}));

test('address classification rejects protected IPv4, mapped IPv6, and transition aliases', () => {
    for (const address of [
        '127.0.0.1',
        '10.1.2.3',
        '169.254.169.254',
        '::1',
        'fd00:ec2::254',
        '::ffff:169.254.169.254',
        '64:ff9b::a9fe:a9fe',
        '2002:7f00:1::',
    ]) {
        assert.equal(isPublicFederationAddress(address), false, address);
    }
    assert.equal(isPublicFederationAddress('93.184.216.34'), true);
    assert.equal(isPublicFederationAddress('2606:4700:4700::1111'), true);
    assert.equal(isPublicFederationAddress('64:ff9b::5db8:d822'), true);
});

test('URL validation rejects credentials and unsafe ports while preserving public custom HTTP ports', async () => {
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const allow = async () => true;

    await assert.rejects(
        validateFederationDestination('https://user:secret@public.example/users/a', {
            lookup: publicLookup,
            instanceAllowed: allow,
        }),
        error => error.code === 'URL_CREDENTIALS',
    );
    await assert.rejects(
        validateFederationDestination('https://public.example:22/users/a', {
            lookup: publicLookup,
            instanceAllowed: allow,
        }),
        error => error.code === 'UNSAFE_PORT',
    );
    const destination = await validateFederationDestination('https://public.example:8443/users/a', {
        lookup: publicLookup,
        instanceAllowed: allow,
    });
    assert.equal(destination.url, 'https://public.example:8443/users/a');
});

test('URL parser aliases cannot disguise loopback destinations or unsupported protocols', async () => {
    const allow = async () => true;
    for (const disguisedLoopback of [
        'http://2130706433/actor',
        'http://0x7f000001/actor',
        'http://0177.0.0.1/actor',
        'http://[::ffff:127.0.0.1]/actor',
    ]) {
        await assert.rejects(
            validateFederationDestination(disguisedLoopback, { instanceAllowed: allow }),
            error => error.code === 'UNSAFE_ADDRESS',
        );
    }
    await assert.rejects(
        validateFederationDestination('file:///etc/passwd', { instanceAllowed: allow }),
        error => error.code === 'UNSAFE_PROTOCOL',
    );
});

test('instance policy runs before DNS and mixed public-private answers are rejected', async () => {
    let lookupCalled = false;
    await assert.rejects(
        validateFederationDestination('https://blocked.example/actor', {
            instanceAllowed: async () => false,
            lookup: async () => {
                lookupCalled = true;
                return [{ address: '93.184.216.34', family: 4 }];
            },
        }),
        error => error.code === 'INSTANCE_BLOCKED',
    );
    assert.equal(lookupCalled, false);

    await assert.rejects(
        validateFederationDestination('https://mixed.example/actor', {
            instanceAllowed: async () => true,
            lookup: async () => [
                { address: '93.184.216.34', family: 4 },
                { address: '10.0.0.8', family: 4 },
            ],
        }),
        error => error.code === 'UNSAFE_ADDRESS',
    );
});

test('pinned lookup returns only validated addresses and rejects hostname substitution', async () => {
    const lookup = createPinnedLookup('public.example', [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const resolve = (hostname, options) => new Promise((fulfil, reject) => {
        lookup(hostname, options, (error, address, family) =>
            error ? reject(error) : fulfil({ address, family }));
    });

    assert.deepEqual(await resolve('public.example', { family: 4 }), {
        address: '93.184.216.34',
        family: 4,
    });
    await assert.rejects(resolve('attacker.example', { family: 4 }), error => error.code === 'DNS_REBINDING');
});

test('redirects are revalidated and cannot move a public request to metadata services', async () => {
    state.dns.set('public.example', [{ address: '93.184.216.34', family: 4 }]);
    state.responses.push({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        data: '',
    });

    await assert.rejects(
        federationGet('https://public.example/actor'),
        error => error.code === 'UNSAFE_ADDRESS',
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].maxRedirects, 0);
    assert.equal(state.requests[0].proxy, false);
});

test('ordinary public redirects and successful ActivityPub responses remain supported', async () => {
    state.dns.set('public.example', [{ address: '93.184.216.34', family: 4 }]);
    state.dns.set('cdn.example', [{ address: '93.184.216.35', family: 4 }]);
    state.responses.push(
        { status: 302, headers: { location: 'https://cdn.example/actor' }, data: '' },
        { status: 200, headers: { 'content-type': 'application/activity+json' }, data: { id: 'https://cdn.example/actor' } },
    );

    const response = await federationGet('https://public.example/users/alice');
    assert.equal(response.status, 200);
    assert.equal(response.data.id, 'https://cdn.example/actor');
    assert.deepEqual(state.lookups, ['public.example', 'cdn.example']);
    assert.deepEqual(state.policyChecks, ['public.example', 'cdn.example']);
    assert.equal(state.requests.length, 2);
});

test('non-federation media keeps public-network protection without applying instance policy', async () => {
    state.allowed = false;
    state.dns.set('avatars.example', [{ address: '93.184.216.34', family: 4 }]);
    state.responses.push({ status: 200, headers: {}, data: 'image bytes' });

    const response = await publicNetworkGet('https://avatars.example/alice.png');
    assert.equal(response.status, 200);
    assert.deepEqual(state.policyChecks, []);
    await assert.rejects(
        publicNetworkGet('http://127.0.0.1/avatar.png'),
        error => error.code === 'UNSAFE_ADDRESS',
    );
});

test('remote resolver routes require authentication and rate limiting before federation work', () => {
    const source = readFileSync(new URL('../../routes/router_activitypub.js', import.meta.url), 'utf8');
    assert.match(source, /router\.get\('\/remote\/users\/search', needLogin, remoteResolutionRateLimit, requireFederation,/);
    assert.match(source, /router\.post\('\/remote\/users\/resolve', needLogin, remoteResolutionRateLimit, requireFederation,/);
});

test('all ActivityPub egress sinks use the shared federation boundary', () => {
    const expectations = new Map([
        ['./federation.js', /federationGet\(/],
        ['./objects.js', /federationGet\(/],
        ['./remotePosts.js', /federationGet\(/],
        ['./remoteMedia.js', /federationGet/],
        ['./delivery.js', /federationRequest\(/],
    ]);

    for (const [path, expectedCall] of expectations) {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8');
        assert.match(source, expectedCall, path);
        assert.doesNotMatch(source, /axios\.(?:get|post|request)\s*\(/, path);
        assert.doesNotMatch(source, /\bfetch\s*\(/, path);
    }
});

test('OAuth avatar reuse selects public-network checks without federation policy', () => {
    const source = readFileSync(new URL('../../controllers/oauth.js', import.meta.url), 'utf8');
    assert.match(source, /cacheRemoteImage\(remoteAvatarUrl, \{[\s\S]*?source: 'oauth',[\s\S]*?enforceFederationPolicy: false,/);
});
