/**
 * ActivityPub outbound HTTP boundary.
 *
 * Every peer-controlled federation URL must pass through this module so the
 * instance policy, destination-address checks, DNS pinning, and redirect
 * validation cannot drift between individual call sites.
 */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import axios from 'axios';
import { isInstanceAllowed } from './federationConfig.js';

const DEFAULT_REDIRECT_LIMIT = 5;
const MAX_REDIRECT_LIMIT = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_PRIVILEGED_PORTS = new Set([80, 443]);
const UNSAFE_HIGH_PORTS = new Set([
    1080, 1099, 1433, 1521, 1723, 2049, 2375, 2376, 3306, 3389,
    5432, 5900, 5984, 6379, 9200, 11211, 27017,
]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const PRIVATE_IPV4_RANGES = [
    [0x00000000, 8],   // current network and unspecified addresses
    [0x0a000000, 8],   // private-use
    [0x64400000, 10],  // shared address space
    [0x7f000000, 8],   // loopback
    [0xa9fe0000, 16],  // link-local, including cloud metadata services
    [0xac100000, 12],  // private-use
    [0xc0000000, 24],  // IETF protocol assignments
    [0xc0000200, 24],  // documentation
    [0xc0a80000, 16],  // private-use
    [0xc6120000, 15],  // benchmarking
    [0xc6336400, 24],  // documentation
    [0xcb007100, 24],  // documentation
    [0xe0000000, 4],   // multicast
    [0xf0000000, 4],   // reserved and limited broadcast
];

const NON_PUBLIC_IPV6_RANGES = [
    ['2001::', 32],       // Teredo transition addresses
    ['2001:2::', 48],     // benchmarking
    ['2001:10::', 28],    // deprecated ORCHID
    ['2001:20::', 28],    // ORCHIDv2
    ['2001:db8::', 32],   // documentation
    ['3fff::', 20],       // documentation
];

export class FederationRequestError extends Error {
    constructor(message, code, response = null) {
        super(message);
        this.name = 'FederationRequestError';
        this.code = code;
        this.response = response;
    }
}

function normalizeHostname(hostname) {
    const value = String(hostname || '').trim().toLowerCase();
    const unbracketed = value.startsWith('[') && value.endsWith(']')
        ? value.slice(1, -1)
        : value;
    return unbracketed.replace(/\.+$/, '');
}

function parseIpv4(address) {
    if (net.isIP(address) !== 4) return null;
    const octets = address.split('.').map(Number);
    const value = (
        octets[0] * 0x1000000
        + octets[1] * 0x10000
        + octets[2] * 0x100
        + octets[3]
    );
    return { octets, value };
}

function isIpv4InRange(value, network, prefixLength) {
    const size = 2 ** (32 - prefixLength);
    return value >= network && value < network + size;
}

function isPublicIpv4(address) {
    const parsed = parseIpv4(address);
    if (!parsed) return false;
    return !PRIVATE_IPV4_RANGES.some(([network, prefixLength]) =>
        isIpv4InRange(parsed.value, network, prefixLength));
}

function parseIpv6Words(address) {
    if (net.isIP(address) !== 6 || address.includes('%')) return null;

    const halves = address.toLowerCase().split('::');
    if (halves.length > 2) return null;

    const parseHalf = (half) => {
        if (!half) return [];
        const words = [];
        for (const part of half.split(':')) {
            if (part.includes('.')) {
                const ipv4 = parseIpv4(part);
                if (!ipv4) return null;
                words.push(
                    (ipv4.octets[0] << 8) | ipv4.octets[1],
                    (ipv4.octets[2] << 8) | ipv4.octets[3],
                );
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
            words.push(parseInt(part, 16));
        }
        return words;
    };

    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] || '');
    if (!left || !right) return null;

    const omittedWords = 8 - left.length - right.length;
    if ((halves.length === 1 && omittedWords !== 0) || (halves.length === 2 && omittedWords < 1)) {
        return null;
    }

    return [...left, ...Array(omittedWords).fill(0), ...right];
}

function ipv6WordsToBigInt(words) {
    return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function isIpv6InRange(value, networkAddress, prefixLength) {
    const networkWords = parseIpv6Words(networkAddress);
    if (!networkWords) return false;
    const shift = 128n - BigInt(prefixLength);
    return (value >> shift) === (ipv6WordsToBigInt(networkWords) >> shift);
}

function ipv4FromWords(high, low) {
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isPublicIpv6(address) {
    const words = parseIpv6Words(address);
    if (!words) return false;

    // IPv4-mapped addresses must be classified by their embedded IPv4 value.
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
        return isPublicIpv4(ipv4FromWords(words[6], words[7]));
    }

    // Preserve IPv6-only federation through the well-known DNS64 prefix while
    // classifying the synthesized destination by its embedded IPv4 address.
    if (words[0] === 0x0064 && words[1] === 0xff9b
        && words.slice(2, 6).every(word => word === 0)) {
        return isPublicIpv4(ipv4FromWords(words[6], words[7]));
    }

    // Only globally routable unicast space is eligible for federation.
    if (words[0] < 0x2000 || words[0] > 0x3fff) return false;

    // 6to4 embeds an IPv4 endpoint; reject it when that endpoint is protected.
    if (words[0] === 0x2002 && !isPublicIpv4(ipv4FromWords(words[1], words[2]))) {
        return false;
    }

    const value = ipv6WordsToBigInt(words);
    return !NON_PUBLIC_IPV6_RANGES.some(([network, prefixLength]) =>
        isIpv6InRange(value, network, prefixLength));
}

export function isPublicFederationAddress(address) {
    const normalized = normalizeHostname(address);
    const family = net.isIP(normalized);
    if (family === 4) return isPublicIpv4(normalized);
    if (family === 6) return isPublicIpv6(normalized);
    return false;
}

function parseFederationUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        throw new FederationRequestError('Federation URL is required', 'INVALID_URL');
    }

    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new FederationRequestError('Federation URL is invalid', 'INVALID_URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new FederationRequestError('Federation URL must use HTTP or HTTPS', 'UNSAFE_PROTOCOL');
    }
    if (parsed.username || parsed.password) {
        throw new FederationRequestError('Federation URL credentials are not allowed', 'URL_CREDENTIALS');
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname || hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
        throw new FederationRequestError('Federation hostname is not public', 'UNSAFE_HOST');
    }

    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535
        || (port < 1024 && !SAFE_PRIVILEGED_PORTS.has(port))
        || UNSAFE_HIGH_PORTS.has(port)) {
        throw new FederationRequestError('Federation URL uses an unsafe port', 'UNSAFE_PORT');
    }

    parsed.hostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    parsed.hash = '';
    return { parsed, hostname };
}

/**
 * Validate policy and resolve every address before a request is created.
 * The optional dependencies are test seams for deterministic direct assertions.
 * Production federation requests always use the production resolver and policy.
 */
export async function validateFederationDestination(rawUrl, {
    lookup = dns.lookup,
    instanceAllowed = isInstanceAllowed,
} = {}) {
    const { parsed, hostname } = parseFederationUrl(rawUrl);

    // Apply the administrator's federation policy before performing DNS I/O.
    if (!await instanceAllowed(hostname)) {
        throw new FederationRequestError('Federation instance is blocked by policy', 'INSTANCE_BLOCKED');
    }

    const literalFamily = net.isIP(hostname);
    let resolved = literalFamily
        ? [{ address: hostname, family: literalFamily }]
        : await lookup(hostname, { all: true, verbatim: true });

    if (!Array.isArray(resolved)) resolved = resolved ? [resolved] : [];
    if (resolved.length === 0) {
        throw new FederationRequestError('Federation hostname did not resolve', 'DNS_LOOKUP_FAILED');
    }

    const addresses = [];
    for (const result of resolved) {
        const address = normalizeHostname(result?.address);
        const family = net.isIP(address);
        if (!family || !isPublicFederationAddress(address)) {
            throw new FederationRequestError('Federation destination resolved to a protected address', 'UNSAFE_ADDRESS');
        }
        if (!addresses.some(item => item.address === address && item.family === family)) {
            addresses.push({ address, family });
        }
    }

    return {
        url: parsed.toString(),
        hostname,
        addresses,
    };
}

/**
 * Build a lookup callback that can return only the already-vetted addresses.
 * This closes the validation-to-connection DNS rebinding window.
 */
export function createPinnedLookup(expectedHostname, addresses) {
    const expected = normalizeHostname(expectedHostname);
    const pinned = addresses.map(item => ({ address: item.address, family: item.family }));

    return (hostname, options, callback) => {
        let lookupOptions = options;
        let done = callback;
        if (typeof options === 'function') {
            done = options;
            lookupOptions = {};
        } else if (typeof options === 'number') {
            lookupOptions = { family: options };
        }

        if (normalizeHostname(hostname) !== expected) {
            return done(new FederationRequestError('Unexpected hostname during pinned lookup', 'DNS_REBINDING'));
        }

        const requestedFamily = Number(lookupOptions?.family || 0);
        const candidates = requestedFamily === 4 || requestedFamily === 6
            ? pinned.filter(item => item.family === requestedFamily)
            : pinned;
        if (candidates.length === 0) {
            return done(new FederationRequestError('No validated address matches the requested family', 'DNS_FAMILY_MISMATCH'));
        }

        if (lookupOptions?.all) return done(null, candidates);
        return done(null, candidates[0].address, candidates[0].family);
    };
}

function redirectLimit(value) {
    const parsed = Number.isInteger(value) ? value : DEFAULT_REDIRECT_LIMIT;
    return Math.min(Math.max(parsed, 0), MAX_REDIRECT_LIMIT);
}

function responseStatusAllowed(validateStatus, status) {
    if (typeof validateStatus === 'function') return validateStatus(status);
    return status >= 200 && status < 300;
}

async function requestPublicDestination(rawUrl, options, enforceInstancePolicy) {
    const {
        followRedirects = true,
        maxRedirects,
        validateStatus,
        // These Axios escape hatches are deliberately owned by this boundary.
        adapter: _adapter,
        transport: _transport,
        socketPath: _socketPath,
        proxy: _proxy,
        httpAgent: _httpAgent,
        httpsAgent: _httpsAgent,
        beforeRedirect: _beforeRedirect,
        ...requestConfig
    } = options;
    const method = String(requestConfig.method || 'GET').toUpperCase();
    const allowedRedirects = redirectLimit(maxRedirects);
    const visited = new Set();
    let currentUrl = rawUrl;
    let redirects = 0;

    while (true) {
        const destination = await validateFederationDestination(currentUrl, enforceInstancePolicy
            ? undefined
            : { instanceAllowed: async () => true });
        if (visited.has(destination.url)) {
            throw new FederationRequestError('Federation redirect loop detected', 'REDIRECT_LOOP');
        }
        visited.add(destination.url);

        const lookup = createPinnedLookup(destination.hostname, destination.addresses);
        const response = await axios.request({
            ...requestConfig,
            method,
            url: destination.url,
            maxRedirects: 0,
            proxy: false,
            httpAgent: new http.Agent({ keepAlive: false, lookup }),
            httpsAgent: new https.Agent({ keepAlive: false, lookup }),
            validateStatus: () => true,
        });

        const location = response.headers?.location;
        if (REDIRECT_STATUSES.has(response.status) && location) {
            if (!followRedirects) {
                if (responseStatusAllowed(validateStatus, response.status)) return response;
                throw new FederationRequestError(`Federation request returned HTTP ${response.status}`, 'HTTP_STATUS', response);
            }
            response.data?.destroy?.();
            if (method !== 'GET' && method !== 'HEAD') {
                throw new FederationRequestError('Federation write redirects are not allowed', 'UNSAFE_REDIRECT', response);
            }
            if (redirects >= allowedRedirects) {
                throw new FederationRequestError('Federation redirect limit exceeded', 'REDIRECT_LIMIT', response);
            }

            try {
                currentUrl = new URL(location, destination.url).toString();
            } catch {
                throw new FederationRequestError('Federation redirect URL is invalid', 'INVALID_REDIRECT', response);
            }
            redirects += 1;
            continue;
        }

        if (!responseStatusAllowed(validateStatus, response.status)) {
            response.data?.destroy?.();
            throw new FederationRequestError(`Federation request returned HTTP ${response.status}`, 'HTTP_STATUS', response);
        }
        return response;
    }
}

export function federationRequest(rawUrl, options = {}) {
    return requestPublicDestination(rawUrl, options, true);
}

export function federationGet(url, options = {}) {
    return federationRequest(url, { ...options, method: 'GET' });
}

/**
 * Reuse the public-address and DNS-pinning boundary outside ActivityPub without
 * applying an unrelated federation allow/block list.
 */
export function publicNetworkGet(url, options = {}) {
    return requestPublicDestination(url, { ...options, method: 'GET' }, false);
}
