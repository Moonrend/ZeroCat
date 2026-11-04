import {prisma} from "../services/prisma.js";
import logger from '../services/logger.js';
import zcconfig from "../services/config/zcconfig.js";
import {sanitizeUsername} from "../services/global.js";
import crypto from 'crypto';
import { Agent } from '@atproto/api';
import {
    consumeAtprotoAuthCallback,
    createAtprotoAuthAuthorizeUrl,
    saveUserAtprotoAuthDid,
} from '../services/social/atprotoAuthOAuth.js';

import base32Encode from 'base32-encode';
import memoryCache from '../services/memoryCache.js';
import gorseService from '../services/gorse.js';
import { cacheRemoteImage } from '../services/activitypub/remoteMedia.js';
import {
    checkAssetExists,
    createAssetRecord,
    generateMD5,
    processImage,
    uploadToS3,
} from '../services/assets.js';
import {assignDefaultRolesToUser} from '../services/auth/policyEngine.js';

const USER_TARGET_TYPE = 'user';
const TWITTER_OAUTH1_REQUEST_TOKEN_KEY_PREFIX = 'twitter_oauth1_req:';

const DEFAULT_AVATAR_HASHES = new Set([
    // schema.prisma 默认值
    '870582712ab041107f1571285bc95a83',
    // ActivityPub 远程代理用户默认值
    'fcd939e653195bb6d057e8c2519f5cc7',
]);

function pickHttpUrl(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    return null;
}

function buildLinuxdoAvatarUrl(data) {
    const template = data?.avatar_template;
    if (!template) return null;

    const replaced = String(template).replace(/\{size\}/g, '512');
    const direct = pickHttpUrl(replaced);
    if (direct) return direct;
    if (replaced.startsWith('/')) {
        return `https://connect.linux.do${replaced}`;
    }
    return null;
}

function build40codeAvatarUrl(data) {
    // 40Code OAuth 用户信息接口：https://api.abc.520gxx.com/oauth/user
    // 头像字段：优先使用 head（兼容旧字段 avatar）
    const raw = String(data?.head || data?.avatar || '').trim();
    if (!raw) return null;

    const asUrl = pickHttpUrl(raw);
    if (asUrl) return asUrl;

    const origin = 'https://abc.520gxx.com';
    if (raw.startsWith('/')) {
        return `${origin}${raw}`;
    }

    // raw 为素材标识时，按 40Code 资源路由拼接
    return `${origin}/static/internalapi/asset/${raw}`;
}

async function cacheOAuthAvatarBuffer({
    buffer,
    userId,
    provider,
    source,
    contentType,
} = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('empty avatar buffer');
    }

    const processed = await processImage(buffer, {
        width: 512,
        height: 512,
        format: 'webp',
        quality: 95,
        sanitize: true,
        maxFileSize: 500 * 1024,
    });

    const md5 = generateMD5(processed.buffer);

    const existing = await checkAssetExists(md5);
    if (!existing) {
        const s3Key = `assets/${md5.substring(0, 2)}/${md5.substring(2, 4)}/${md5}.webp`;
        await uploadToS3(processed.buffer, s3Key, 'image/webp');
        await createAssetRecord({
            md5,
            filename: `${provider}_avatar.webp`,
            extension: 'webp',
            mimeType: 'image/webp',
            fileSize: processed.buffer.length,
            uploaderId: userId || null,
            uploaderIp: 'oauth-sync',
            uploaderUa: 'ZeroCat-OAuth/1.0',
            metadata: {
                source: 'oauth',
                provider,
                avatarSource: source || null,
                upstreamContentType: contentType || null,
                imageProcessing: {
                    originalSize: buffer.length,
                    processedSize: processed.size,
                    dimensions: { width: processed.width, height: processed.height },
                    compressionRatio: processed.compressionRatio,
                },
            },
            tags: 'oauth-sync',
            category: 'avatars',
        });
    }

    return md5;
}

async function syncMicrosoftOAuthAvatarIfNeeded({
    user,
    oauthContact,
    accessToken,
} = {}) {
    const userId = user?.id;
    if (!userId) return;
    if (!accessToken) return;

    const currentAvatar = String(user?.avatar || '').trim().toLowerCase();
    const isDefaultAvatar = !currentAvatar || DEFAULT_AVATAR_HASHES.has(currentAvatar);
    if (!isDefaultAvatar) return;

    const meta = normalizeContactMetadata(oauthContact?.metadata);
    if (meta?.avatar_source === 'microsoft_graph_photo' && meta?.avatar_md5 === currentAvatar) {
        return;
    }

    const response = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'image/*',
        },
    });

    if (!response.ok) {
        // 常见原因：未设置头像、或 Graph 权限不足
        const text = await response.text().catch(() => '');
        throw new Error(`Microsoft photo HTTP ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('content-type') || null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const md5 = await cacheOAuthAvatarBuffer({
        buffer,
        userId,
        provider: 'microsoft',
        source: 'microsoft_graph:/me/photo/$value',
        contentType,
    });

    if (md5 && md5 !== currentAvatar) {
        await prisma.ow_users.update({
            where: { id: userId },
            data: { avatar: md5 },
        });
        user.avatar = md5;
    }

    if (oauthContact?.contact_id) {
        const nextMeta = {
            ...(meta && typeof meta === 'object' ? meta : {}),
            avatar_source: 'microsoft_graph_photo',
            avatar_md5: md5,
        };
        await prisma.ow_users_contacts.update({
            where: { contact_id: oauthContact.contact_id },
            data: {
                metadata: nextMeta,
                updated_at: new Date(),
            },
        });
    }
}

function normalizeContactMetadata(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return null;
    }
}

async function syncOAuthAvatarIfNeeded({
    user,
    oauthContact,
    provider,
    userInfo,
} = {}) {
    const userId = user?.id;
    if (!userId) return;

    const remoteAvatarUrl = String(userInfo?.avatar || '').trim();
    if (!remoteAvatarUrl) return;

    const currentAvatar = String(user?.avatar || '').trim();
    const meta = normalizeContactMetadata(oauthContact?.metadata);

    // 如果之前已缓存过且一致，则无需重复下载
    if (
        meta &&
        meta.avatar &&
        meta.avatar_md5 &&
        String(meta.avatar).trim() === remoteAvatarUrl &&
        String(meta.avatar_md5).trim() === currentAvatar
    ) {
        return;
    }

    // 避免覆盖用户自己上传的头像：仅在默认头像时同步
    const isDefaultAvatar = !currentAvatar || DEFAULT_AVATAR_HASHES.has(currentAvatar);
    if (!isDefaultAvatar) {
        return;
    }

    const actorUrl = userInfo?.profile_url || userInfo?.url || `oauth:${provider}:${userInfo?.id || ''}`;

    const cachedMd5 = await cacheRemoteImage(remoteAvatarUrl, {
        purpose: 'avatar',
        proxyUserId: userId,
        actorUrl,
        source: 'oauth',
        tags: 'oauth-sync',
        uploaderIp: 'oauth-sync',
        uploaderUa: 'ZeroCat-OAuth/1.0',
        extraMetadata: {
            provider,
            providerUserId: userInfo?.id || null,
            providerUsername: userInfo?.username || userInfo?.handle || null,
        },
    });

    const normalizedMd5 = String(cachedMd5 || '').trim().toLowerCase();
    const isValidMd5 = /^[0-9a-f]{32}$/.test(normalizedMd5);
    const isFallback = !isValidMd5 || DEFAULT_AVATAR_HASHES.has(normalizedMd5);

    if (!isFallback && normalizedMd5 !== currentAvatar) {
        await prisma.ow_users.update({
            where: { id: userId },
            data: { avatar: normalizedMd5 },
        });
        user.avatar = normalizedMd5;
    }

    if (oauthContact?.contact_id) {
        const nextMeta = {
            ...(meta && typeof meta === 'object' ? meta : {}),
            ...(userInfo && typeof userInfo === 'object' ? userInfo : {}),
            avatar: remoteAvatarUrl,
            ...(!isFallback ? { avatar_md5: normalizedMd5 } : {}),
        };

        await prisma.ow_users_contacts.update({
            where: { contact_id: oauthContact.contact_id },
            data: {
                metadata: nextMeta,
                updated_at: new Date(),
            },
        });
    }
}

function createPkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

function base64urlEncode(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function buildSignedJwtES256({ header, payload, privateKeyPem }) {
    const encodedHeader = base64urlEncode(JSON.stringify(header));
    const encodedPayload = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
        key: privateKeyPem,
        dsaEncoding: 'ieee-p1363',
    });

    return `${signingInput}.${base64urlEncode(signature)}`;
}

function createDpopKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    return { publicJwk, privateKeyPem };
}

function normalizeUrlForDpop(url) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
}

function buildDpopProof({ method, url, privateKeyPem, publicJwk, nonce }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        jti: crypto.randomUUID(),
        htm: String(method || 'POST').toUpperCase(),
        htu: normalizeUrlForDpop(url),
        iat: now,
        exp: now + 60,
        ...(nonce ? { nonce } : {}),
    };

    const header = {
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: {
            kty: publicJwk.kty,
            crv: publicJwk.crv,
            x: publicJwk.x,
            y: publicJwk.y,
        },
    };

    return buildSignedJwtES256({ header, payload, privateKeyPem });
}

function getHeaderValue(headers, name) {
    if (!headers) return null;
    const lower = name.toLowerCase();
    return headers[name] || headers[lower] || null;
}

function isBlueskyClientId(value) {
    const clientId = String(value || '').trim();
    return clientId.startsWith('https://') || clientId.startsWith('did:');
}

function normalizeUrlBase(input, fallback = null) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const finalInput = raw || fallback;
    if (!finalInput) {
        throw new Error('缺少有效URL配置');
    }
    const parsed = new URL(finalInput);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function normalizeOidcIssuer(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function buildOidcEndpoints(issuer) {
    const normalizedIssuer = normalizeOidcIssuer(issuer);
    return {
        issuer: normalizedIssuer,
        authUrl: `${normalizedIssuer}/auth`,
        tokenUrl: `${normalizedIssuer}/token`,
        userInfoUrl: `${normalizedIssuer}/me`,
    };
}

function buildDidWebDocumentUrl(did) {
    const methodSpecific = String(did || '').slice('did:web:'.length);
    const segments = methodSpecific
        .split(':')
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .filter(Boolean);

    const host = segments[0];
    if (!host) return null;

    if (segments.length === 1) {
        return `https://${host}/.well-known/did.json`;
    }

    return `https://${host}/${segments.slice(1).join('/')}/did.json`;
}

function pickPdsFromDidDocument(document) {
    const services = Array.isArray(document?.service) ? document.service : [];
    for (const service of services) {
        const types = Array.isArray(service?.type) ? service.type : [service?.type];
        const isAtprotoPds = types.some(
            (item) => String(item || '').toLowerCase() === 'atprotopersonaldataserver'
        );
        const serviceId = String(service?.id || '').toLowerCase();
        const isLegacyPdsId = serviceId.endsWith('#atproto_pds');

        if (!isAtprotoPds && !isLegacyPdsId) continue;

        const endpoint = typeof service?.serviceEndpoint === 'string'
            ? service.serviceEndpoint
            : service?.serviceEndpoint?.uri;
        if (!endpoint) continue;

        try {
            return normalizeUrlBase(endpoint);
        } catch {
            // ignore invalid endpoint and continue
        }
    }
    return null;
}

async function resolveBlueskyPdsByDid(did) {
    const normalizedDid = String(did || '').trim();
    if (!normalizedDid.startsWith('did:')) return null;

    let didDocumentUrl = null;
    if (normalizedDid.startsWith('did:plc:')) {
        didDocumentUrl = `https://plc.directory/${normalizedDid}`;
    } else if (normalizedDid.startsWith('did:web:')) {
        didDocumentUrl = buildDidWebDocumentUrl(normalizedDid);
    }

    if (!didDocumentUrl) return null;

    logger.debug(`[oauth] resolveBlueskyPdsByDid: fetching ${didDocumentUrl}`);
    const response = await fetch(didDocumentUrl, {
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn(`[oauth] resolveBlueskyPdsByDid failed: HTTP ${response.status} ${text}`);
        throw new Error(`resolve did document failed (${response.status})`);
    }

    const didDocument = await response.json();
    return pickPdsFromDidDocument(didDocument);
}

function safeExpiresAt(tokenData) {
    const expiresIn = Number(tokenData?.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        return null;
    }
    return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function formatOAuthError(error) {
    if (!error) return 'unknown error';
    const messages = [];

    if (error.message) {
        messages.push(error.message);
    }

    if (Array.isArray(error?.errors)) {
        for (const inner of error.errors) {
            if (inner?.message) {
                messages.push(inner.message);
            }
        }
    }

    const code = error?.code ? String(error.code) : '';
    if (code) {
        messages.push(`code=${code}`);
    }

    const deduped = [...new Set(messages.filter(Boolean))];
    return deduped.join(' | ') || 'unknown error';
}

function oauth1PercentEncode(value) {
    return encodeURIComponent(String(value ?? ''))
        .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuth1Signature({ method, url, params, consumerSecret, tokenSecret = '' }) {
    const normalizedParams = Object.keys(params)
        .sort()
        .map((key) => `${oauth1PercentEncode(key)}=${oauth1PercentEncode(params[key])}`)
        .join('&');

    const baseString = [
        String(method || 'GET').toUpperCase(),
        oauth1PercentEncode(url),
        oauth1PercentEncode(normalizedParams),
    ].join('&');

    const signingKey = `${oauth1PercentEncode(consumerSecret)}&${oauth1PercentEncode(tokenSecret)}`;
    return crypto
        .createHmac('sha1', signingKey)
        .update(baseString)
        .digest('base64');
}

function buildOAuth1AuthHeader(params) {
    const pairs = Object.keys(params)
        .sort()
        .map((key) => `${oauth1PercentEncode(key)}="${oauth1PercentEncode(params[key])}"`);
    return `OAuth ${pairs.join(', ')}`;
}

function parseOAuth1FormBody(text) {
    const body = String(text || '').trim();
    const parsed = new URLSearchParams(body);
    const result = {};
    for (const [key, value] of parsed.entries()) {
        result[key] = value;
    }
    return result;
}

function maskClientId(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'unknown';
    return `${raw.slice(0, 5)}***`;
}

async function requestTwitterOAuth1Token({ url, consumerKey, consumerSecret, callback, token, tokenSecret, verifier }) {
    const method = 'POST';
    const oauthParams = {
        oauth_consumer_key: String(consumerKey || '').trim(),
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_version: '1.0',
        ...(callback ? { oauth_callback: callback } : {}),
        ...(token ? { oauth_token: token } : {}),
        ...(verifier ? { oauth_verifier: verifier } : {}),
    };

    oauthParams.oauth_signature = buildOAuth1Signature({
        method,
        url,
        params: oauthParams,
        consumerSecret,
        tokenSecret,
    });

    const response = await fetch(url, {
        method,
        headers: {
            Authorization: buildOAuth1AuthHeader(oauthParams),
            Accept: 'application/x-www-form-urlencoded',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return parseOAuth1FormBody(text);
}

async function getTwitterUserInfoV1(config, tokenData) {
    const userInfoUrl = String(config?.userInfoUrl || '').trim();
    const consumerKey = String(config?.clientId || '').trim();
    const consumerSecret = String(config?.clientSecret || '').trim();
    const oauthToken = String(tokenData?.oauth_token || tokenData?.access_token || '').trim();
    const oauthTokenSecret = String(tokenData?.oauth_token_secret || '').trim();

    if (!consumerKey || !consumerSecret) {
        throw new Error('Twitter OAuth 配置不完整（缺少 client_id 或 client_secret）');
    }
    if (!oauthToken || !oauthTokenSecret) {
        throw new Error('Twitter OAuth1 令牌不完整（缺少 oauth_token 或 oauth_token_secret）');
    }

    const parsed = new URL(userInfoUrl);
    const baseUrl = `${parsed.origin}${parsed.pathname}`;
    const queryParams = {};
    for (const [key, value] of parsed.searchParams.entries()) {
        queryParams[key] = value;
    }

    const oauthParams = {
        oauth_consumer_key: consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_token: oauthToken,
        oauth_version: '1.0',
    };

    const signatureParams = { ...queryParams, ...oauthParams };
    oauthParams.oauth_signature = buildOAuth1Signature({
        method: 'GET',
        url: baseUrl,
        params: signatureParams,
        consumerSecret,
        tokenSecret: oauthTokenSecret,
    });

    logger.info(`[oauth] getUserInfo: provider=twitter(v1.1), url=${baseUrl}, clientId=${maskClientId(consumerKey)}`);

    const response = await fetch(userInfoUrl, {
        headers: {
            Authorization: buildOAuth1AuthHeader(oauthParams),
            Accept: 'application/json',
        },
    });

    const responseText = await response.text();
    logger.debug(`[oauth] getUserInfo response: provider=twitter(v1.1), status=${response.status}, body=${responseText.substring(0, 500)}`);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    const data = JSON.parse(responseText);
    return config.mapUserInfo(data);
}

function buildTwitterOAuthCallbackUrl(redirectUri, state) {
    const callbackUrl = new URL(String(redirectUri || '').trim());
    callbackUrl.searchParams.set('state', String(state || '').trim());
    return callbackUrl.toString();
}

export function resolveTwitterOAuthStateByRequestToken(oauthToken) {
    const key = `${TWITTER_OAUTH1_REQUEST_TOKEN_KEY_PREFIX}${String(oauthToken || '').trim()}`;
    const context = memoryCache.get(key);
    return context?.state || null;
}

async function saveOAuthTokens(userId, provider, tokenData, extra = {}) {
    if (!userId || !provider || !tokenData?.access_token) return;

    const requestedPurpose = extra?.tokenPurpose === 'sync' ? 'sync' : 'auth';
    const tokenPurpose = provider === 'bluesky' ? 'sync' : requestedPurpose;
    const storageKey = `social.${provider}.${tokenPurpose}.tokens`;

    let existingPayload = null;
    try {
        const existing = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: USER_TARGET_TYPE,
                    target_id: String(userId),
                    key: storageKey,
                },
            },
            select: { value: true },
        });
        existingPayload = existing?.value ? JSON.parse(existing.value) : null;
    } catch (error) {
        logger.warn(`[oauth] 读取旧令牌配置失败，将按新值覆盖: provider=${provider}, purpose=${tokenPurpose}, userId=${userId}, err=${error.message}`);
    }

    const normalizedExtra = Object.fromEntries(
        Object.entries(extra || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );

    const payload = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || existingPayload?.refresh_token || null,
        token_type: tokenData.token_type || 'Bearer',
        scope: tokenData.scope || null,
        expires_in: tokenData.expires_in || null,
        expires_at: safeExpiresAt(tokenData),
        updated_at: new Date().toISOString(),
        ...normalizedExtra,
    };

    if (provider === 'bluesky') {
        payload.provider_user_id = payload.provider_user_id || existingPayload?.provider_user_id || existingPayload?.did || null;
        payload.provider_username = payload.provider_username || existingPayload?.provider_username || null;
        payload.pds = payload.pds || existingPayload?.pds || null;
        payload.did = payload.did || payload.provider_user_id || existingPayload?.did || null;
    }

    delete payload.tokenPurpose;

    await prisma.ow_target_configs.upsert({
        where: {
            target_type_target_id_key: {
                target_type: USER_TARGET_TYPE,
                target_id: String(userId),
                key: storageKey,
            },
        },
        update: {
            value: JSON.stringify(payload),
        },
        create: {
            target_type: USER_TARGET_TYPE,
            target_id: String(userId),
            key: storageKey,
            value: JSON.stringify(payload),
        },
    });
}

// Generate a Base32 hash for TOTP
const generateContactHash = () => {
    // 生成16字节的随机数据
    const buffer = crypto.randomBytes(16);
    // 使用 base32-encode 库将随机字节转换为 Base32 格式
    return base32Encode(buffer, 'RFC4648', {padding: false});
};
// OAuth 提供商基础配置
export const OAUTH_PROVIDERS = {
    google: {
        id: 'google',
        name: 'Google',
        type: 'oauth_google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
        scope: 'openid email profile',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // 头像字段：Google OIDC userinfo 的 picture
        mapUserInfo: (data) => ({
            id: data.sub,
            email: data.email,
            name: data.name,
            avatar: data.picture || null,
            username: null,
            profile_url: null,
        })
    },
    houlang: {
        id: 'houlang',
        name: '厚浪',
        type: 'oauth_houlang',
        issuer: 'https://oauth.houlang.cloud/oidc',
        ...buildOidcEndpoints('https://oauth.houlang.cloud/oidc'),
        scope: 'openid profile email',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // Houlang 使用 Logto OIDC，用户信息来自 /oidc/me。
        mapUserInfo: (data) => ({
            id: data.sub || data.id,
            email: data.email || null,
            name: data.name || data.username || data.preferred_username || data.nickname || data.email || data.sub,
            avatar: data.picture || data.avatar || data.avatar_url || null,
            username: data.username || data.preferred_username || data.nickname || null,
            profile_url: data.website || data.profile || data.profile_url || null,
        })
    },

    dynamic : {
        id: 'dynamic',
        name: 'Dynamic',
        type: 'oauth_dynamic',
        issuer: 'https://auth.yun/oidc',
        ...buildOidcEndpoints('https://auth.yun/oidc'),
        scope: 'openid profile email',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        mapUserInfo: (data) => ({
            id: data.sub || data.id,
            email: data.email || null,
            name: data.name || data.username || data.preferred_username || data.nickname || data.email || data.sub,
            avatar: data.picture || data.avatar || data.avatar_url || null,
            username: data.username || data.preferred_username || data.nickname || null,
            profile_url: data.website || data.profile || data.profile_url || null,
        })
    },
    microsoft: {
        id: 'microsoft',
        name: 'Microsoft',
        type: 'oauth_microsoft',
        authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        scope: 'openid email profile User.Read',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // 头像接口：Microsoft Graph /me/photo/$value（单独在登录/绑定后同步）
        mapUserInfo: (data) => ({
            id: data.id,
            email: data.mail || data.userPrincipalName,
            name: data.displayName,
            username: data.userPrincipalName || null,
            avatar: null,
            profile_url: null,
        })
    },
    github: {
        id: 'github',
        name: 'GitHub',
        type: 'oauth_github',
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scope: 'read:user user:email',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // GitHub 用户信息需要并行请求 user + emails；头像字段来自 user.avatar_url
        getUserInfo: async (accessToken) => getGitHubUserInfo(accessToken),
        mapUserInfo: (data) => ({
            id: data?.id ? String(data.id) : null,
            email: null,
            name: data?.name || data?.login || null,
            username: data?.login || null,
            avatar: data?.avatar_url || null,
            profile_url: data?.html_url || null,
        }),
    },
    "40code": {
        id: '40code',
        name: '40Code',
        type: 'oauth_40code',
        authUrl: 'https://www.40code.com/#page=oauth_authorize',
        tokenUrl: 'https://api.abc.520gxx.com/oauth/token',
        refreshUrl: 'https://api.abc.520gxx.com/oauth/refresh',
        userInfoUrl: 'https://api.abc.520gxx.com/oauth/user',
        scope: 'basic',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // 头像字段：40Code OAuth user 接口返回的 head（兼容 avatar）
        mapUserInfo: (data) => ({
            id: data.id.toString(),
            email: data.email,
            name: data.nickname,
            username: data.username || null,
            avatar: build40codeAvatarUrl(data),
            profile_url: null,
        })
    },
    linuxdo: {
        id: 'linuxdo',
        name: 'Linux.do',
        type: 'oauth_linuxdo',
        authUrl: 'https://connect.linux.do/oauth2/authorize',
        tokenUrl: 'https://connect.linux.do/oauth2/token',
        userInfoUrl: 'https://connect.linux.do/api/user',
        scope: '',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        // 头像字段：Linux.do user API 的 avatar_template
        mapUserInfo: (data) => ({
            id: data.id.toString(),
            email: data.email,
            name: data.name || data.username,
            username: data.username || null,
            avatar: buildLinuxdoAvatarUrl(data),
            profile_url: null,
        })
    },
    twitter: {
        id: 'twitter',
        name: 'Twitter',
        type: 'oauth_twitter',
        authUrl: 'https://api.twitter.com/oauth/authenticate',
        requestTokenUrl: 'https://api.twitter.com/oauth/request_token',
        tokenUrl: 'https://api.twitter.com/oauth/access_token',
        userInfoUrl: 'https://api.twitter.com/1.1/account/verify_credentials.json?include_email=true&skip_status=true',
        scope: '',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        mapUserInfo: (data) => {
            const user = data || {};
            return {
                id: user.id_str || (user.id ? String(user.id) : null),
                email: null,
                name: user.name || user.screen_name,
                username: user.screen_name || null,
                avatar: user.profile_image_url_https || user.profile_image_url || null,
                profile_url: user.screen_name ? `https://twitter.com/${user.screen_name}` : null,
            };
        },
    },
    bluesky: {
        id: 'bluesky',
        name: 'Bluesky',
        type: 'oauth_bluesky',
        authUrl: 'https://bsky.social/oauth/authorize',
        tokenUrl: 'https://bsky.social/oauth/token',
        userInfoUrl: 'https://bsky.social/xrpc/com.atproto.server.getSession',
        scope: 'atproto',
        enabled: false,
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        defaultPds: 'https://bsky.social',
        mapUserInfo: (data) => ({
            id: data.did || data.handle,
            email: data.email || null,
            name: data.handle || data.did,
            handle: data.handle || null,
            did: data.did || null,
            avatar: data.avatar || null,
        }),
    }
};

// 初始化 OAuth 配置
export async function initializeOAuthProviders() {
    try {
        // 从数据库读取所有 OAuth 相关配置
        for (const provider of Object.values(OAUTH_PROVIDERS)) {
            const enabled = await zcconfig.get(`oauth.${provider.id}.enabled`);
            const clientId = await zcconfig.get(`oauth.${provider.id}.client_id`);
            const clientSecret = await zcconfig.get(`oauth.${provider.id}.client_secret`);
            const baseUrl = await zcconfig.get('urls.backend');
            provider.enabled = enabled;
            provider.clientId = clientId;
            provider.clientSecret = clientSecret;
            provider.redirectUri = `${baseUrl}/account/oauth/${provider.id}/callback`;

            if (provider.id === 'houlang') {
                const issuer = 'https://oauth.houlang.cloud/oidc'
                const scope = "openid profile email"
                Object.assign(provider, buildOidcEndpoints(issuer));
                provider.scope = String(scope || provider.scope || 'openid profile email').trim();
            }

            if (provider.id === 'bluesky') {
                const defaultPds = await zcconfig.get('oauth.bluesky.default_pds');
                provider.defaultPds = defaultPds || provider.defaultPds;
                provider.clientId = `${baseUrl}/account/oauth/bluesky/client-metadata.json`;
            }

            logger.debug(`OAuth 提供商 ${provider.name} 加载完成, 启用状态: ${provider.enabled}`);
        }
    } catch (error) {
        logger.error('[oauth] 初始化OAuth提供商失败:', error);
    }
}

function getBlueskyEndpoints(config, options = {}) {
    const pds = normalizeUrlBase(options.pds, config.defaultPds || 'https://bsky.social');
    return {
        pds,
        authUrl: `${pds}/oauth/authorize`,
        tokenUrl: `${pds}/oauth/token`,
        userInfoUrl: `${pds}/xrpc/com.atproto.server.getSession`,
    };
}

// 生成 OAuth 授权 URL
export async function generateAuthUrl(provider, state, options = {}) {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) throw new Error('[oauth] 不支持的 OAuth 提供商');
    if (!config.enabled) throw new Error('[oauth] 此 OAuth 提供商未启用');

    const isBluesky = provider === 'bluesky';
    const authUrl = config.authUrl;

    if (isBluesky) {
        const identifier = options?.identifier || options?.account || options?.domain || options?.pds || '';
        return createAtprotoAuthAuthorizeUrl({
            loginHint: identifier,
            state,
            scope: options?.scope || config.scope || 'atproto',
        });
    }

    if (provider === '40code') {
        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            scope: config.scope,
            state: state
        });
        return `${authUrl}&${params.toString()}`;
    }

    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: options?.scope || config.scope,
        state: state
    });

    if (provider === 'twitter') {
        const callbackUrl = buildTwitterOAuthCallbackUrl(config.redirectUri, state);
        const requestTokenData = await requestTwitterOAuth1Token({
            url: config.requestTokenUrl,
            consumerKey: config.clientId,
            consumerSecret: config.clientSecret,
            callback: callbackUrl,
        });

        const oauthToken = String(requestTokenData?.oauth_token || '').trim();
        const oauthTokenSecret = String(requestTokenData?.oauth_token_secret || '').trim();
        if (!oauthToken || !oauthTokenSecret) {
            throw new Error('Twitter OAuth1 获取 request token 失败');
        }

        memoryCache.set(`${TWITTER_OAUTH1_REQUEST_TOKEN_KEY_PREFIX}${oauthToken}`, {
            oauthTokenSecret,
            state: String(state || '').trim(),
        }, 600);

        const finalUrl = `${config.authUrl}?oauth_token=${encodeURIComponent(oauthToken)}`;
        logger.info(`[oauth] generateAuthUrl: provider=twitter(oauth1.0a), redirectUri=${config.redirectUri}, clientId=${maskClientId(config.clientId)}`);
        return finalUrl;
    }

    const finalUrl = `${authUrl}?${params.toString()}`;
    logger.info(`[oauth] generateAuthUrl: provider=${provider}, redirectUri=${config.redirectUri}, authUrl=${authUrl}`);
    return finalUrl;
}

// 获取 OAuth 访问令牌
async function getAccessToken(provider, code, options = {}) {
    if (provider === 'bluesky') {
        throw new Error('Bluesky OAuth 已切换为官方 @atproto/oauth-client-node，请使用 atproto 回调消费流程');
    }

    const config = OAUTH_PROVIDERS[provider];
    const tokenUrl = config.tokenUrl;
    const effectiveClientId = String(config.clientId || '');

    if (provider === 'twitter') {
        const oauthToken = String(options?.oauthToken || '').trim();
        const oauthVerifier = String(code || '').trim();
        if (!oauthToken || !oauthVerifier) {
            throw new Error('Twitter OAuth 回调缺少 oauth_token 或 oauth_verifier');
        }

        const requestContextKey = `${TWITTER_OAUTH1_REQUEST_TOKEN_KEY_PREFIX}${oauthToken}`;
        const requestContext = memoryCache.get(requestContextKey);
        if (!requestContext?.oauthTokenSecret) {
            throw new Error('Twitter OAuth 请求状态已失效，请重新授权');
        }

        const maskedClientId = maskClientId(effectiveClientId);
        logger.info(`[oauth] Twitter access token exchange(oauth1.0a): clientId=${maskedClientId}`);

        const tokenData = await requestTwitterOAuth1Token({
            url: tokenUrl,
            consumerKey: config.clientId,
            consumerSecret: config.clientSecret,
            token: oauthToken,
            tokenSecret: requestContext.oauthTokenSecret,
            verifier: oauthVerifier,
        });

        memoryCache.delete(requestContextKey);

        const accessToken = String(tokenData?.oauth_token || '').trim();
        const accessTokenSecret = String(tokenData?.oauth_token_secret || '').trim();
        if (!accessToken || !accessTokenSecret) {
            throw new Error('Twitter OAuth1 未返回有效的访问令牌');
        }

        return {
            access_token: accessToken,
            token_type: 'OAuth1.0a',
            oauth_token: accessToken,
            oauth_token_secret: accessTokenSecret,
            provider_user_id: tokenData?.user_id ? String(tokenData.user_id) : null,
            provider_username: tokenData?.screen_name ? String(tokenData.screen_name) : null,
            scope: null,
            expires_in: null,
        };
    }

    const params = new URLSearchParams();
    params.set('client_id', effectiveClientId);
    params.set('code', code);
    params.set('redirect_uri', options?.redirectUri || config.redirectUri);
    params.set('grant_type', 'authorization_code');

    params.set('client_secret', config.clientSecret);

    try {
        const requestHeaders = {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        };

        logger.info(`[oauth] getAccessToken: provider=${provider}, tokenUrl=${tokenUrl}, params=${[...params.keys()].join(',')}`);

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: params.toString()
        });

        const responseText = await response.text();
        logger.debug(`[oauth] getAccessToken response: provider=${provider}, status=${response.status}, body=${responseText.substring(0, 500)}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${responseText}`);
        }

        return JSON.parse(responseText);
    } catch (error) {
        const errorMsg = formatOAuthError(error);
        logger.error(`[oauth] 获取${provider}访问令牌失败: ${errorMsg}`, error);
        throw error;
    }
}

// 获取 GitHub 用户信息（需要并行请求 user + emails）
async function getGitHubUserInfo(accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
    };

    logger.debug(`[oauth] getGitHubUserInfo: fetching user + emails`);
    const [userResponse, emailsResponse] = await Promise.all([
        fetch(OAUTH_PROVIDERS.github.userInfoUrl, { headers }),
        fetch('https://api.github.com/user/emails', { headers })
    ]);

    if (!userResponse.ok) {
        const text = await userResponse.text();
        throw new Error(`GitHub user API HTTP ${userResponse.status}: ${text}`);
    }
    if (!emailsResponse.ok) {
        const text = await emailsResponse.text();
        throw new Error(`GitHub emails API HTTP ${emailsResponse.status}: ${text}`);
    }

    const userData = await userResponse.json();
    const emailsData = await emailsResponse.json();
    const primaryEmail = emailsData.find(email => email.primary)?.email || emailsData[0]?.email;

    return {
        id: userData.id.toString(),
        email: primaryEmail,
        name: userData.name || userData.login,
        username: userData.login || null,
        avatar: userData.avatar_url || null,
        profile_url: userData.html_url || null,
    };
}

// 通过 DPoP 调用 Bluesky getSession 端点，尝试获取邮箱等用户信息
async function getBlueskyUserInfoFromApi(accessToken, userInfoUrl, options = {}) {
    const makeHeaders = (nonce) => {
        const h = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
        if (options?.dpopPrivateKeyPem && options?.dpopPublicJwk) {
            h.DPoP = buildDpopProof({
                method: 'GET',
                url: userInfoUrl,
                privateKeyPem: options.dpopPrivateKeyPem,
                publicJwk: options.dpopPublicJwk,
                ...(nonce ? { nonce } : {}),
            });
        }
        return h;
    };

    logger.debug(`[oauth] getBlueskyUserInfoFromApi: fetching ${userInfoUrl}`);
    let response = await fetch(userInfoUrl, { headers: makeHeaders() });

    // DPoP nonce 重试
    if (!response.ok && options?.dpopPrivateKeyPem) {
        const nonce = getHeaderValue(response.headers, 'dpop-nonce');
        if (nonce) {
            logger.debug(`[oauth] getBlueskyUserInfoFromApi: retrying with DPoP nonce`);
            response = await fetch(userInfoUrl, { headers: makeHeaders(nonce) });
        }
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Bluesky getSession HTTP ${response.status}: ${text}`);
    }

    const data = await response.json();
    return {
        id: data.did || data.handle,
        email: data.email || null,
        name: data.handle || data.did,
        handle: data.handle || null,
        did: data.did || null,
    };
}

// 通用获取用户信息函数
async function getUserInfo(provider, accessToken, options = {}, tokenData = null) {
    if (provider === 'bluesky') {
        throw new Error('Bluesky 用户信息获取已切换为官方 @atproto/api + @atproto/oauth-client-node');
    }

    const config = OAUTH_PROVIDERS[provider];
    const userInfoUrl = config.userInfoUrl;

    if (provider === 'twitter') {
        return getTwitterUserInfoV1(config, tokenData);
    }

    // 支持 provider 自定义用户信息获取流程（用于 GitHub 等需要额外请求的场景）
    if (typeof config.getUserInfo === 'function') {
        return config.getUserInfo(accessToken, options, tokenData);
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [500, 1500, 3000]; // ms
    const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.info(`[oauth] getUserInfo: provider=${provider}, url=${userInfoUrl}, attempt=${attempt + 1}/${MAX_RETRIES + 1}`);

            const response = await fetch(userInfoUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                }
            });

            const responseText = await response.text();
            logger.debug(`[oauth] getUserInfo response: provider=${provider}, status=${response.status}, body=${responseText.substring(0, 500)}`);

            if (!response.ok) {
                if (attempt < MAX_RETRIES && RETRYABLE_STATUS.has(response.status)) {
                    logger.warn(`[oauth] getUserInfo ${provider} HTTP ${response.status}, retrying in ${RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }

                throw new Error(`HTTP ${response.status}: ${responseText}`);
            }

            const data = JSON.parse(responseText);
            const mapped = config.mapUserInfo(data);
            logger.info(`[oauth] getUserInfo success: provider=${provider}, userId=${mapped?.id}`);
            return mapped;
        } catch (error) {
            if (attempt < MAX_RETRIES && !(error.message && error.message.startsWith('HTTP '))) {
                logger.warn(`[oauth] getUserInfo ${provider} network error, retrying in ${RETRY_DELAYS[attempt]}ms: ${error.message}`);
                await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                continue;
            }
            logger.error(`[oauth] 获取${provider}用户信息失败 (final):`, error);
            throw error;
        }
    }
}

// 生成唯一用户名
async function generateUniqueUsername(baseName) {
    // 清理用户名，合并连续下划线，只保留小写字母数字和单个下划线
    let cleanName = sanitizeUsername(baseName);
    if (!cleanName) cleanName = 'user';
    // 限制长度
    if (cleanName.length > 20) cleanName = cleanName.substring(0, 20).replace(/_+$/g, '');

    // 检查清理后的用户名是否可用
    const existing = await prisma.ow_users.findUnique({
        where: {username: cleanName}
    });

    if (!existing) return cleanName;

    // 有重复则直接生成16位随机大小写字母数字
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let username;
    while (true) {
        username = Array.from({length: 16}, () =>
            chars.charAt(Math.floor(Math.random() * chars.length))
        ).join('');

        const conflict = await prisma.ow_users.findUnique({
            where: {username}
        });
        if (!conflict) break;
    }

    return username;
}

export async function handleOAuthCallback(provider, code, userIdToBind = null, options = {}) {
    logger.info(`[oauth] handleOAuthCallback: ${provider}, code: ${code.substring(0, 10)}..., userIdToBind: ${userIdToBind}`);
    try {
        const tokenPurpose = options?.tokenPurpose === 'sync' ? 'sync' : 'auth';

        // 获取访问令牌与用户信息
        let tokenData;
        let userInfo;

        if (provider === 'bluesky') {
            const callbackQuery = options?.callbackQuery || {
                code,
                state: options?.state,
                ...(options?.iss ? { iss: options.iss } : {}),
            };

            const { session } = await consumeAtprotoAuthCallback(callbackQuery);

            const did = String(session?.did || '').trim();
            if (!did) {
                throw new Error('Bluesky OAuth 回调未返回有效 DID');
            }

            const agent = new Agent(session);

            let profile = null;
            try {
                const profileResp = await agent.getProfile({ actor: did });
                profile = profileResp?.data || null;
            } catch (error) {
                logger.warn(`[oauth] 读取Bluesky资料失败，将使用DID回退: ${error.message}`);
            }

            // 通过 getSession 获取邮箱（需要 transition:email scope）
            let email = null;
            try {
                const sessionResp = await agent.com.atproto.server.getSession();
                email = sessionResp?.data?.email || null;
                if (email) {
                    logger.debug(`[oauth] Bluesky getSession 获取到邮箱: ${email}`);
                }
            } catch (error) {
                logger.warn(`[oauth] 读取Bluesky邮箱失败（可能未授予 transition:email scope）: ${error.message}`);
            }

            tokenData = {
                access_token: `atproto:${did}`,
                scope: options?.scope || OAUTH_PROVIDERS.bluesky.scope,
                sub: did,
            };

            userInfo = {
                id: did,
                email,
                name: profile?.displayName || profile?.handle || did,
                handle: profile?.handle || null,
                did,
                avatar: profile?.avatar ? String(profile.avatar) : null,
            };
        } else {
            try {
                tokenData = await getAccessToken(provider, code, options);
            } catch (error) {
                const detail = formatOAuthError(error);
                logger.error(`[oauth] 获取${provider}的访问令牌失败: ${detail}`);
                throw new Error(`获取${provider}访问令牌失败: ${detail}`);
            }

            if (!tokenData.access_token) {
                logger.error(`[oauth] ${provider}未返回access_token`, tokenData);
                throw new Error(`${provider}未返回有效的访问令牌`);
            }

            const accessToken = tokenData.access_token;
            try {
                userInfo = await getUserInfo(provider, accessToken, options, tokenData);
            } catch (error) {
                logger.error(`[oauth] 获取${provider}用户信息失败:`, error.message);
                throw new Error(`获取${provider}用户信息失败: ${error.message}`);
            }
        }

        if (!userInfo || !userInfo.id) {
            logger.error(`[oauth] 无法获取${provider}用户ID`, userInfo);
            throw new Error(`无法获取${provider}的有效用户信息`);
        }

        logger.debug(`[oauth] ${provider}用户信息:`, {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name
        });

        if (userIdToBind) {
            // 绑定操作
            logger.info(`[oauth] 处理OAuth绑定操作: provider=${provider}, targetUserId=${userIdToBind}`);

            const user = await prisma.ow_users.findUnique({
                where: {id: userIdToBind}
            });

            if (!user) {
                logger.error(`[oauth] 绑定目标用户不存在: ${userIdToBind}`);
                return {success: false, message: "[oauth] 绑定的用户不存在"};
            }

            // 检查该 OAuth 账号是否已被其他用户绑定
            const providerContacts = await prisma.ow_users_contacts.findMany({
                where: {
                    contact_type: "oauth_" + provider,
                    OR: [{ contact_value: userInfo.id }, { user_id: user.id }],
                },
            });
            const existingOAuthContact = providerContacts.find(contact => contact.contact_value === userInfo.id);
            const existingUserProviderContact = providerContacts.find(contact => contact.user_id === user.id);

            if (existingOAuthContact && existingOAuthContact.user_id !== userIdToBind) {
                logger.warn(`[oauth] OAuth账号已被其他用户绑定: provider=${provider}, oauthId=${userInfo.id}, existingUserId=${existingOAuthContact.user_id}`);
                return {success: false, message: "[oauth] 该OAuth账号已被其他用户绑定"};
            }

            // 绑定 OAuth 账号到指定用户
            let boundOAuthContact = existingUserProviderContact || existingOAuthContact || null;
            try {
                if (existingUserProviderContact && existingUserProviderContact.contact_value !== userInfo.id) {
                    boundOAuthContact = await prisma.ow_users_contacts.update({
                        where: { contact_id: existingUserProviderContact.contact_id },
                        data: {
                            contact_value: userInfo.id,
                            contact_info: generateContactHash(),
                            verified: true,
                            metadata: userInfo,
                            updated_at: new Date(),
                        },
                    });
                    logger.info(`[oauth] 重绑OAuth账号并覆盖联系方式: userId=${user.id}, provider=${provider}, oauthId=${userInfo.id}`);
                } else if (!existingUserProviderContact && !existingOAuthContact) {
                    boundOAuthContact = await prisma.ow_users_contacts.create({
                        data: {
                            user_id: user.id,
                            contact_value: userInfo.id,
                            contact_info: generateContactHash(),
                            contact_type: "oauth_" + provider,
                            verified: true,
                            metadata: userInfo
                        }
                    });
                    logger.info(`[oauth] 成功绑定OAuth账号: userId=${user.id}, provider=${provider}`);
                } else {
                    boundOAuthContact = await prisma.ow_users_contacts.update({
                        where: { contact_id: (existingUserProviderContact || existingOAuthContact).contact_id },
                        data: {
                            verified: true,
                            metadata: userInfo,
                            updated_at: new Date(),
                        },
                    });
                    logger.info(`[oauth] OAuth账号已存在，刷新绑定信息: userId=${user.id}, provider=${provider}`);
                }

                await saveOAuthTokens(user.id, provider, tokenData, {
                    tokenPurpose: provider === 'bluesky' ? 'sync' : tokenPurpose,
                    provider_user_id: userInfo.id,
                    provider_username: userInfo.username || userInfo.handle || null,
                    pds: options?.pds || null,
                });

                if (provider === 'bluesky' && userInfo?.did) {
                    await saveUserAtprotoAuthDid(user.id, userInfo.did);
                }
            } catch (error) {
                logger.error(`[oauth] 绑定OAuth账号失败:`, error);
                return {success: false, message: "[oauth] 绑定OAuth账号失败: " + error.message};
            }

            // 同步头像（仅默认头像时），避免覆盖用户自定义头像
            try {
                await syncOAuthAvatarIfNeeded({
                    user,
                    oauthContact: boundOAuthContact,
                    provider,
                    userInfo,
                });

                if (provider === 'microsoft') {
                    await syncMicrosoftOAuthAvatarIfNeeded({
                        user,
                        oauthContact: boundOAuthContact,
                        accessToken: tokenData?.access_token,
                    });
                }
            } catch (error) {
                logger.warn(`[oauth] OAuth绑定后同步头像失败（不阻断绑定）: userId=${user.id}, provider=${provider}, err=${error.message}`);
            }

            // 添加邮箱联系方式（如果邮箱不存在）
            if (userInfo.email) {
                try {
                    const emailContact = await prisma.ow_users_contacts.findFirst({
                        where: {
                            user_id: user.id,
                            contact_value: userInfo.email,
                            contact_type: 'email'
                        }
                    });

                    if (!emailContact) {
                        await prisma.ow_users_contacts.create({
                            data: {
                                user_id: user.id,
                                contact_value: userInfo.email,
                                contact_info: generateContactHash(),
                                contact_type: 'email',
                                is_primary: false,
                                verified: false
                            }
                        });
                        logger.debug(`[oauth] 为绑定用户添加邮箱: userId=${user.id}, email=${userInfo.email}`);
                    }
                } catch (error) {
                    logger.warn(`[oauth] 添加邮箱联系方式失败（不中断绑定操作）:`, error);
                }
            }

            return {success: true, message: "OAuth账号绑定成功"};
        } else {
            // 登录/注册操作
            logger.info(`[oauth] 处理OAuth登录/注册: provider=${provider}, oauthId=${userInfo.id}, email=${userInfo.email}`);

            let contact = await prisma.ow_users_contacts.findFirst({
                where: {
                    contact_value: userInfo.id,
                    contact_type: "oauth_" + provider
                }
            });

            const existingOAuthContact = contact;

            if (!contact) {
                logger.debug(`[oauth] OAuth账号未绑定，开始注册/关联用户: provider=${provider}, email=${userInfo.email}`);

                let userId;

                if (userInfo.email) {
                    // 有邮箱时：先查是否已有同邮箱用户
                    const emailContact = await prisma.ow_users_contacts.findFirst({
                        where: {
                            contact_value: userInfo.email,
                            contact_type: 'email'
                        }
                    });

                    if (emailContact) {
                        // 邮箱已存在，关联该用户
                        userId = emailContact.user_id;
                        logger.info(`[oauth] OAuth邮箱已关联现有用户: userId=${userId}, provider=${provider}`);
                    } else {
                        // 创建新用户（有邮箱）
                        logger.info(`[oauth] 创建新用户(有邮箱): provider=${provider}`);
                        const username = await generateUniqueUsername(userInfo.name || 'user');
                        try {
                            const newUser = await prisma.ow_users.create({
                                data: {
                                    username,
                                    password: null,
                                    display_name: userInfo.name || username,
                                    type: 'user',
                                    regTime: new Date(),
                                    createdAt: new Date()
                                }
                            });
                            userId = newUser.id;
                            logger.info(`[oauth] 成功创建新用户: userId=${userId}, username=${username}, provider=${provider}`);

                            // 同步新用户到 Gorse
                            gorseService.upsertUser(newUser.id, { username }).catch(e => {
                                logger.debug('[gorse] oauth user sync failed:', e.message);
                            });
                        } catch (error) {
                            logger.error(`[oauth] 创建新用户失败:`, error);
                            throw new Error(`创建新用户失败: ${error.message}`);
                        }

                        // 创建 email 联系方式
                        try {
                            await prisma.ow_users_contacts.create({
                                data: {
                                    user_id: userId,
                                    contact_value: userInfo.email,
                                    contact_info: generateContactHash(),
                                    contact_type: 'email',
                                    is_primary: true,
                                    verified: true
                                }
                            });
                            logger.debug(`[oauth] 为新用户添加邮箱: userId=${userId}, email=${userInfo.email}`);
                        } catch (error) {
                            logger.error(`[oauth] 为新用户添加邮箱失败，尝试删除用户:`, error);
                            try {
                                await prisma.ow_users.delete({ where: { id: userId } });
                                logger.info(`[oauth] 已删除创建失败的用户: userId=${userId}`);
                            } catch (deleteError) {
                                logger.error(`[oauth] 删除用户失败:`, deleteError);
                            }
                            throw new Error(`添加用户邮箱失败: ${error.message}`);
                        }
                    }
                } else {
                    // 无邮箱（如 Bluesky 未开放邮箱）：直接创建新用户，不添加邮箱联系方式
                    logger.info(`[oauth] 创建新用户(无邮箱): provider=${provider}, oauthId=${userInfo.id}`);
                    const baseName = userInfo.handle || userInfo.name || 'user';
                    const username = await generateUniqueUsername(baseName);
                    try {
                        const newUser = await prisma.ow_users.create({
                            data: {
                                username,
                                password: null,
                                display_name: userInfo.name || username,
                                type: 'user',
                                regTime: new Date(),
                                createdAt: new Date()
                            }
                        });
                        userId = newUser.id;
                        logger.info(`[oauth] 成功创建无邮箱新用户: userId=${userId}, username=${username}, provider=${provider}`);

                        // 同步新用户到 Gorse
                        gorseService.upsertUser(newUser.id, { username }).catch(e => {
                            logger.debug('[gorse] oauth user (no email) sync failed:', e.message);
                        });
                    } catch (error) {
                        logger.error(`[oauth] 创建无邮箱新用户失败:`, error);
                        throw new Error(`创建新用户失败: ${error.message}`);
                    }
                }

                // 创建 OAuth 联系方式
                try {
                    contact = await prisma.ow_users_contacts.create({
                        data: {
                            user_id: userId,
                            contact_value: userInfo.id,
                            contact_info: generateContactHash(),
                            contact_type: "oauth_" + provider,
                            verified: true,
                            metadata: userInfo
                        }
                    });
                    logger.info(`[oauth] 成功创建OAuth联系方式: userId=${userId}, provider=${provider}`);
                    await assignDefaultRolesToUser(userId);
                } catch (error) {
                    logger.error(`[oauth] 创建OAuth联系方式失败:`, error);
                    throw new Error(`创建OAuth联系方式失败: ${error.message}`);
                }
            }

            // 已存在 OAuth 联系方式时，刷新 metadata（不阻断登录）
            if (existingOAuthContact && existingOAuthContact.contact_id) {
                try {
                    contact = await prisma.ow_users_contacts.update({
                        where: { contact_id: existingOAuthContact.contact_id },
                        data: {
                            metadata: userInfo,
                            updated_at: new Date(),
                        },
                    });
                } catch (error) {
                    logger.warn(`[oauth] 刷新OAuth联系方式metadata失败（不阻断登录）: provider=${provider}, contactId=${existingOAuthContact.contact_id}, err=${error.message}`);
                }
            }

            // 获取用户信息
            const user = await prisma.ow_users.findUnique({
                where: {id: contact.user_id}
            });

            if (!user) {
                logger.error(`[oauth] 用户不存在: userId=${contact.user_id}`);
                throw new Error('[oauth] 用户不存在');
            }

            // 获取用户主邮箱
            const primaryEmail = await prisma.ow_users_contacts.findFirst({
                where: {
                    user_id: user.id,
                    contact_type: 'email',
                    is_primary: true
                }
            });

            logger.info(`[oauth] OAuth登录成功: userId=${user.id}, username=${user.username}, provider=${provider}`);

            // 同步头像（仅默认头像时），避免覆盖用户自定义头像
            try {
                await syncOAuthAvatarIfNeeded({
                    user,
                    oauthContact: contact,
                    provider,
                    userInfo,
                });

                if (provider === 'microsoft') {
                    await syncMicrosoftOAuthAvatarIfNeeded({
                        user,
                        oauthContact: contact,
                        accessToken: tokenData?.access_token,
                    });
                }
            } catch (error) {
                logger.warn(`[oauth] OAuth登录后同步头像失败（不阻断登录）: userId=${user.id}, provider=${provider}, err=${error.message}`);
            }

            // 持久化 OAuth 令牌（包括 refresh_token），以便后续刷新和 API 调用
            try {
                await saveOAuthTokens(user.id, provider, tokenData, {
                    tokenPurpose: provider === 'bluesky' ? 'sync' : tokenPurpose,
                    provider_user_id: userInfo.id,
                    provider_username: userInfo.username || userInfo.handle || null,
                    pds: options?.pds || null,
                });
                logger.debug(`[oauth] OAuth登录令牌已持久化: userId=${user.id}, provider=${provider}`);

                if (provider === 'bluesky' && userInfo?.did) {
                    await saveUserAtprotoAuthDid(user.id, userInfo.did);
                }
            } catch (tokenSaveError) {
                // 令牌保存失败不应阻止登录流程
                logger.warn(`[oauth] OAuth登录令牌持久化失败（不阻断登录）: userId=${user.id}, provider=${provider}, err=${tokenSaveError.message}`);
            }

            return {
                user,
                contact: primaryEmail || contact  // 优先返回主邮箱联系方式
            };
        }
    } catch (error) {
        logger.error('[oauth] OAuth callback 发生错误:', error);
        throw error;
    }
}

/**
 * 仅获取访问令牌并以 sync 用途保存，不创建/修改任何 oauth 联系方式记录。
 * 专用于帖文同步（Bluesky/Twitter sync）的授权绑定流程。
 */
export async function handleOAuthSyncBind(provider, code, userId, options = {}) {
    logger.info(`[oauth] handleOAuthSyncBind: ${provider}, userId: ${userId}`);
    try {
        if (provider === 'bluesky') {
            return {
                success: false,
                message: 'Bluesky 同步OAuth已迁移到 /social/bluesky/sync/* 专用流程',
            };
        }

        let tokenData;
        try {
            tokenData = await getAccessToken(provider, code, options);
        } catch (error) {
            const detail = formatOAuthError(error);
            logger.error(`[oauth] 获取${provider}的访问令牌失败(sync): ${detail}`);
            throw new Error(`获取${provider}访问令牌失败: ${detail}`);
        }

        if (!tokenData.access_token) {
            throw new Error(`${provider}未返回有效的访问令牌`);
        }

        let userInfo = null;
        try {
            userInfo = await getUserInfo(provider, tokenData.access_token, options, tokenData);
        } catch (error) {
            logger.warn(`[oauth] 获取${provider}用户信息失败(sync)，令牌仍将保存: ${error.message}`);
        }

        let resolvedPds = options?.pds || null;
        if (provider === 'bluesky') {
            const did = String(userInfo?.did || userInfo?.id || tokenData?.sub || '').trim();
            if (did) {
                try {
                    const didResolvedPds = await resolveBlueskyPdsByDid(did);
                    if (didResolvedPds) {
                        resolvedPds = didResolvedPds;
                        logger.info(`[oauth] Bluesky DID解析PDS成功: did=${did}, pds=${didResolvedPds}`);
                    } else {
                        logger.warn(`[oauth] Bluesky DID未解析到PDS，回退配置值: did=${did}`);
                    }
                } catch (error) {
                    logger.warn(`[oauth] Bluesky DID解析PDS失败，回退配置值: did=${did}, err=${error.message}`);
                }
            }
        }

        await saveOAuthTokens(userId, provider, tokenData, {
            tokenPurpose: 'sync',
            provider_user_id: userInfo?.id || null,
            provider_username: userInfo?.username || userInfo?.handle || null,
            pds: resolvedPds,
            dpopPrivateKeyPem: options?.dpopPrivateKeyPem || null,
            dpopPublicJwk: options?.dpopPublicJwk || null,
        });

        logger.info(`[oauth] Sync令牌保存成功: userId=${userId}, provider=${provider}`);
        return { success: true };
    } catch (error) {
        logger.error('[oauth] handleOAuthSyncBind 发生错误:', error);
        return { success: false, message: error.message };
    }
}

export { createPkcePair };
