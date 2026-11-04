import { RichText } from '@atproto/api';
import { Client as TwitterClient, auth as twitterAuth } from 'twitter-api-sdk';
import { prisma } from '../prisma.js';
import zcconfig from '../config/zcconfig.js';
import logger from '../logger.js';
import { visibleWhere, assertCanWrite } from '../moderation/visibility.js';
import { getUserAtprotoSyncDid, restoreAtprotoSyncAgent } from './atprotoSyncOAuth.js';

const USER_TARGET_TYPE = 'user';
const POST_TARGET_TYPE = 'post';
const TWITTER_SYNC_REQUIRED_SCOPES = [
    'tweet.read',
    'tweet.write',
    'tweet.moderate.write',
    'users.read',
    'follows.read',
    'follows.write',
    'offline.access',
    'space.read',
    'mute.read',
    'mute.write',
    'like.read',
    'like.write',
    'list.read',
    'list.write',
    'block.read',
    'block.write',
    'bookmark.read',
    'bookmark.write',
];
const TWITTER_SYNC_DEFAULT_SCOPE = TWITTER_SYNC_REQUIRED_SCOPES.join(' ');

function getTargetConfigModel() {
    return prisma.ow_target_configs || prisma.c;
}

export const SOCIAL_KEYS = {
    SYNC_SETTINGS: 'social.sync.settings',
    TWITTER_SYNC_APP: 'social.twitter.sync.app',
    TWITTER_SYNC_TOKENS: 'social.twitter.sync.tokens',
    BLUESKY_SYNC_TOKENS: 'social.bluesky.sync.tokens',
    BLUESKY_PDS: 'social.bluesky.pds',
};

export const SOCIAL_EVENT_TYPES = {
    POST_CREATE: 'create',
    POST_REPLY: 'reply',
    POST_QUOTE: 'quote',
    POST_DELETE: 'delete',
    POST_LIKE: 'like',
    POST_UNLIKE: 'unlike',
    POST_BOOKMARK: 'bookmark',
    POST_UNBOOKMARK: 'unbookmark',
};

const ACTION_REF_PREFIX = 'social.post.action';

function normalizeUrlBase(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

async function getTargetConfig(targetType, targetId, key) {
    const targetConfig = getTargetConfigModel();
    const record = await targetConfig.findUnique({
        where: {
            target_type_target_id_key: {
                target_type: targetType,
                target_id: String(targetId),
                key,
            },
        },
    });
    return record?.value || null;
}

async function upsertTargetConfig(targetType, targetId, key, value) {
    const finalValue = typeof value === 'string' ? value : JSON.stringify(value);
    const targetConfig = getTargetConfigModel();
    await targetConfig.upsert({
        where: {
            target_type_target_id_key: {
                target_type: targetType,
                target_id: String(targetId),
                key,
            },
        },
        update: { value: finalValue },
        create: {
            target_type: targetType,
            target_id: String(targetId),
            key,
            value: finalValue,
        },
    });
}

async function deleteTargetConfig(targetType, targetId, key) {
    const targetConfig = getTargetConfigModel();
    await targetConfig.deleteMany({
        where: {
            target_type: targetType,
            target_id: String(targetId),
            key,
        },
    });
}

function parseJson(raw, fallback = null) {
    if (!raw || typeof raw !== 'string') return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export async function getUserSocialSyncSettings(userId) {
    const raw = await getTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.SYNC_SETTINGS);
    const parsed = parseJson(raw, {});
    return {
        twitter: Boolean(parsed?.twitter),
        bluesky: Boolean(parsed?.bluesky),
    };
}

export async function setUserSocialSyncSettings(userId, patch) {
    const current = await getUserSocialSyncSettings(userId);
    const next = {
        ...current,
        ...(patch?.twitter !== undefined ? { twitter: Boolean(patch.twitter) } : {}),
        ...(patch?.bluesky !== undefined ? { bluesky: Boolean(patch.bluesky) } : {}),
    };

    await upsertTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.SYNC_SETTINGS, next);
    return next;
}

function maskSecret(value) {
    if (!value || typeof value !== 'string') return '';
    if (value.length <= 8) return '*'.repeat(value.length);
    return `${value.slice(0, 4)}${'*'.repeat(Math.max(value.length - 8, 1))}${value.slice(-4)}`;
}

export async function getTwitterSyncAppConfig(userId, { masked = true } = {}) {
    const raw = await getTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_APP);
    const parsed = parseJson(raw, null);
    if (!parsed) return null;

    if (!masked) return parsed;

    return {
        appId: parsed.clientId || '',
        clientId: parsed.clientId || '',
        clientSecret: maskSecret(parsed.clientSecret || ''),
        redirectUri: parsed.redirectUri || '',
        scope: parsed.scope || TWITTER_SYNC_DEFAULT_SCOPE,
    };
}

export async function setTwitterSyncAppConfig(userId, data) {
    const clientId = String(data?.clientId || data?.appId || '').trim();
    const clientSecret = String(data?.clientSecret || '').trim();
    const redirectUriRaw = String(data?.redirectUri || '').trim();
    const scope = String(data?.scope || TWITTER_SYNC_DEFAULT_SCOPE).trim();

    if (!clientId || !clientSecret) {
        throw new Error('clientId 和 clientSecret 不能为空');
    }

    const backendUrl = await zcconfig.get('urls.backend');
    const defaultRedirect = `${normalizeUrlBase(backendUrl)}/social/twitter/sync/oauth/callback`;

    const payload = {
        clientId,
        clientSecret,
        redirectUri: redirectUriRaw ? normalizeUrlBase(redirectUriRaw) : defaultRedirect,
        scope,
        updatedAt: new Date().toISOString(),
    };

    await upsertTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_APP, payload);
    return getTwitterSyncAppConfig(userId, { masked: true });
}

export async function removeTwitterSyncAppConfig(userId) {
    await deleteTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_APP);
    await deleteTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_TOKENS);
}

export async function setUserBlueskyPds(userId, pds) {
    const normalized = normalizeUrlBase(String(pds || '').trim());
    await upsertTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.BLUESKY_PDS, normalized);
    return normalized;
}

export async function getUserBlueskyPds(userId) {
    const raw = await getTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.BLUESKY_PDS);
    if (raw) return raw;
    const fromConfig = await zcconfig.get('oauth.bluesky.default_pds');
    return fromConfig || 'https://bsky.social';
}

export async function getOAuthBindingStatus(userId) {
    const contacts = await prisma.ow_users_contacts.findMany({
        where: {
            user_id: userId,
            contact_type: { in: ['oauth_twitter', 'oauth_bluesky'] },
            verified: true,
        },
        select: { contact_type: true },
    });

    const map = {
        twitter: contacts.some((item) => item.contact_type === 'oauth_twitter'),
        bluesky: contacts.some((item) => item.contact_type === 'oauth_bluesky'),
    };

    return map;
}

export async function saveTwitterSyncTokens(userId, tokenData) {
    const payload = {
        ...tokenData,
        expires_at: Number(tokenData?.expires_in) > 0
            ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
            : null,
        updated_at: new Date().toISOString(),
    };
    await upsertTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_TOKENS, payload);
}

export async function saveBlueskySyncTokensFromDid(userId, { did, scope, handle }) {
    if (!userId || !did) {
        throw new Error('保存Bluesky同步令牌失败：缺少userId或did');
    }

    await upsertTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.BLUESKY_SYNC_TOKENS, {
        access_token: `atproto:${did}`,
        provider_user_id: did,
        did,
        provider_username: handle || null,
        scope: scope || null,
        updated_at: new Date().toISOString(),
    });
}

async function getTwitterSyncTokens(userId) {
    const raw = await getTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.TWITTER_SYNC_TOKENS);
    return parseJson(raw, null);
}

async function getBlueskySyncTokens(userId) {
    const raw = await getTargetConfig(USER_TARGET_TYPE, userId, SOCIAL_KEYS.BLUESKY_SYNC_TOKENS);
    return parseJson(raw, null);
}

function normalizeTwitterScopes(input) {
    const value = String(input || TWITTER_SYNC_DEFAULT_SCOPE).trim();
    const current = value.split(/\s+/).filter(Boolean);
    const set = new Set(current);
    for (const requiredScope of TWITTER_SYNC_REQUIRED_SCOPES) {
        set.add(requiredScope);
    }
    return Array.from(set);
}

function normalizeTokenScopeSet(scopeInput) {
    return new Set(String(scopeInput || '').split(/\s+/).map((item) => item.trim()).filter(Boolean));
}

function ensureTwitterTokenScopes(tokens, requiredScopes, actionName) {
    const scopeSet = normalizeTokenScopeSet(tokens?.scope);
    const missing = requiredScopes.filter((scope) => !scopeSet.has(scope));
    if (missing.length === 0) return;

    throw new Error(`Twitter 授权缺少权限(${missing.join(', ')})，请在同步应用配置中包含这些 scope 并重新授权后再执行 ${actionName}`);
}

function toTwitterSdkToken(tokens) {
    if (!tokens?.access_token) return undefined;
    const expiresAtMs = tokens?.expires_at ? new Date(tokens.expires_at).getTime() : null;
    return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        token_type: tokens.token_type || undefined,
        scope: tokens.scope || undefined,
        ...(Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? { expires_at: expiresAtMs } : {}),
    };
}

function normalizeExpiresInFromSdkToken(token) {
    const expiresAt = Number(token?.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
    return Math.max(Math.floor((expiresAt - Date.now()) / 1000), 0);
}

function formatTwitterSdkError(error, fallback = 'Twitter API 调用失败') {
    const status = Number(error?.status || error?.statusCode || 0);
    const details = [];

    const pushDetail = (value) => {
        const text = String(value ?? '').trim();
        if (text) details.push(text);
    };

    pushDetail(error?.data?.detail);
    pushDetail(error?.data?.title);
    pushDetail(error?.error?.detail);
    pushDetail(error?.error?.title);
    if (Array.isArray(error?.error?.errors)) {
        for (const item of error.error.errors) {
            pushDetail(item?.detail);
            pushDetail(item?.message);
            pushDetail(item?.title);
        }
    }
    pushDetail(error?.detail);
    if (String(error?.message || '').trim().toLowerCase() !== 'error') {
        pushDetail(error?.message);
    }
    pushDetail(error?.error_description);
    if (typeof error?.error === 'string') {
        pushDetail(error.error);
    }

    const message = [...new Set(details)][0] || String(fallback || 'Twitter API 调用失败').trim() || 'Twitter API 调用失败';
    return status > 0 ? `${message} (${status})` : message;
}

function extractStatusCode(error) {
    const candidates = [
        error?.status,
        error?.statusCode,
        error?.code,
    ];

    for (const value of candidates) {
        const numberValue = Number(value);
        if (Number.isFinite(numberValue) && numberValue > 0) return numberValue;
    }

    const message = String(error?.message || '').trim();
    const match = message.match(/\((\d{3})\)$/) || message.match(/\b(\d{3})\b/);
    if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) return parsed;
    }

    return 0;
}

function isRetryableSocialError(error) {
    if (!error) return false;
    if (error?.isRetryable === true) return true;

    const status = extractStatusCode(error);
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;

    const message = String(error?.message || error || '').toLowerCase();
    if (!message) return false;

    const retryableHints = [
        'too many requests',
        'rate limit',
        'temporarily unavailable',
        'timeout',
        'timed out',
        'econnreset',
        'etimedout',
        'eai_again',
        'socket hang up',
    ];
    return retryableHints.some((hint) => message.includes(hint));
}

function wrapSocialError(error, fallbackMessage) {
    const message = String(error?.message || fallbackMessage || 'social sync failed').trim() || 'social sync failed';
    const wrapped = new Error(message);
    wrapped.isRetryable = isRetryableSocialError(error);
    wrapped.statusCode = extractStatusCode(error);
    wrapped.cause = error;
    return wrapped;
}

async function withTwitterSdkClient(actorUserId, action) {
    const [tokens, appConfig] = await Promise.all([
        getTwitterSyncTokens(actorUserId),
        getTwitterSyncAppConfig(actorUserId, { masked: false }),
    ]);

    if (!tokens?.access_token) {
        throw new Error('未配置 Twitter 同步令牌');
    }
    if (!appConfig?.clientId || !appConfig?.clientSecret || !appConfig?.redirectUri) {
        throw new Error('未配置 Twitter 同步应用信息');
    }

    const oauthClient = new twitterAuth.OAuth2User({
        client_id: String(appConfig.clientId),
        client_secret: String(appConfig.clientSecret),
        callback: String(appConfig.redirectUri),
        scopes: normalizeTwitterScopes(appConfig.scope),
        token: toTwitterSdkToken(tokens),
    });
    const twitterClient = new TwitterClient(oauthClient);

    const result = await action({
        client: twitterClient,
        oauthClient,
        tokens,
    });

    const latestToken = oauthClient.token;
    if (latestToken?.access_token) {
        const changed = latestToken.access_token !== tokens.access_token
            || (latestToken.refresh_token || null) !== (tokens.refresh_token || null)
            || (latestToken.token_type || null) !== (tokens.token_type || null)
            || (latestToken.scope || null) !== (tokens.scope || null)
            || normalizeExpiresInFromSdkToken(latestToken) !== (Number.isFinite(Number(tokens?.expires_in)) ? Number(tokens.expires_in) : null);

        if (changed) {
            await saveTwitterSyncTokens(actorUserId, {
                ...tokens,
                access_token: latestToken.access_token,
                refresh_token: latestToken.refresh_token || null,
                token_type: latestToken.token_type || 'Bearer',
                scope: latestToken.scope || null,
                expires_in: normalizeExpiresInFromSdkToken(latestToken),
            });
        }
    }

    return result;
}

async function resolveTwitterActorId({ client, tokens, actorUserId }) {
    const current = String(tokens?.provider_user_id || '').trim();
    if (current) return current;

    const meResp = await client.users.findMyUser({
        'user.fields': ['profile_image_url'],
    });
    const me = meResp?.data || null;
    if (!me?.id) {
        throw new Error('Twitter 账号信息缺失，无法执行用户动作');
    }

    await saveTwitterSyncTokens(actorUserId, {
        ...tokens,
        provider_user_id: String(me.id),
        provider_username: me?.username ? String(me.username) : null,
        provider_name: me?.name ? String(me.name) : null,
        provider_avatar: me?.profile_image_url ? String(me.profile_image_url) : null,
    });

    return String(me.id);
}

function pickPostText(post) {
    if (!post?.content) return '';
    const text = String(post.content).trim();
    if (!text) return '';
    if (text.length <= 300) return text;
    return `${text.slice(0, 297)}...`;
}

function normalizePlatformRefs(refs) {
    if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {};
    return refs;
}

async function getPostForEvent(postId, { includeHidden = false } = {}) {
    return prisma.ow_posts.findFirst({
        where: { id: Number(postId), ...(includeHidden ? {} : { AND: [await visibleWhere('post')] }) },
        select: {
            id: true,
            author_id: true,
            post_type: true,
            content: true,
            embed: true,
            in_reply_to_id: true,
            thread_root_id: true,
            quoted_post_id: true,
            retweet_post_id: true,
            is_deleted: true,
            platform_refs: true,
            post_media: {
                select: {
                    order: true,
                    asset: {
                        select: {
                            md5: true,
                            extension: true,
                            mime_type: true,
                        },
                    },
                },
                orderBy: { order: 'asc' },
            },
        },
    });
}

async function setPostPlatformRef(postId, platform, refData) {
    const current = await prisma.ow_posts.findUnique({
        where: { id: Number(postId) },
        select: { platform_refs: true },
    });

    const refs = normalizePlatformRefs(current?.platform_refs);
    refs[platform] = refData;

    await prisma.ow_posts.update({
        where: { id: Number(postId) },
        data: { platform_refs: refs },
    });
}

function buildActionRefKey(platform, action, userId) {
    return `${ACTION_REF_PREFIX}.${platform}.${action}.${Number(userId)}`;
}

async function saveActionRef(postId, platform, action, userId, value) {
    await upsertTargetConfig(POST_TARGET_TYPE, postId, buildActionRefKey(platform, action, userId), value);
}

async function readActionRef(postId, platform, action, userId) {
    const raw = await getTargetConfig(POST_TARGET_TYPE, postId, buildActionRefKey(platform, action, userId));
    return parseJson(raw, null);
}

async function removeActionRef(postId, platform, action, userId) {
    await deleteTargetConfig(POST_TARGET_TYPE, postId, buildActionRefKey(platform, action, userId));
}

async function buildPostOutboundText(post) {
    const base = pickPostText(post);
    const frontend = normalizeUrlBase(await zcconfig.get('urls.frontend'));
    const links = [];

    const embed = post?.embed;
    if (embed?.type === 'url' && embed?.url) links.push(String(embed.url));

    const mediaUrls = await getPostMediaUrls(post);
    for (const media of mediaUrls) {
        if (media?.url) links.push(media.url);
    }

    return [base, ...links].filter(Boolean).join('\n');
}

function buildFrontendEmbedUrl(frontend, embed) {
    if (!embed || typeof embed !== 'object') return null;
    if (embed.type === 'post' && embed.id) return `${frontend}/posts/${embed.id}`;
    if (embed.type === 'url' && embed.url) return String(embed.url);
    return null;
}

function shortText(value, max = 280) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function buildAssetUrl(staticBase, value, { defaultExt = '' } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const p1 = raw.substring(0, 2);
    const p2 = raw.substring(2, 4);
    const hasExt = /\.[a-z0-9]{2,6}$/i.test(raw);
    const filename = hasExt ? raw : `${raw}${defaultExt ? `.${defaultExt}` : ''}`;
    return `${staticBase}/assets/${p1}/${p2}/${filename}`;
}

async function uploadImageBlobFromUrl(agent, imageUrl) {
    const target = String(imageUrl || '').trim();
    if (!target) return null;

    try {
        const resp = await fetch(target);
        if (!resp.ok) return null;

        const contentType = String(resp.headers.get('content-type') || '').trim().toLowerCase();
        if (!contentType.startsWith('image/')) return null;

        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (!bytes.length) return null;

        const uploaded = await agent.uploadBlob(bytes, {
            encoding: contentType || 'image/jpeg',
        });
        return uploaded?.data?.blob || uploaded?.blob || null;
    } catch {
        return null;
    }
}

async function resolveExternalFromOriginalEmbed(embed, frontend) {
    if (!embed || typeof embed !== 'object') return null;
    const staticBase = await getStaticBaseUrl();

    if (embed.type === 'user' && embed.id) {
        const user = await prisma.ow_users.findFirst({
            where: { id: Number(embed.id), AND: [await visibleWhere('profile')] },
            select: {
                username: true,
                display_name: true,
                bio: true,
                avatar: true,
            },
        });
        if (!user?.username) return null;
        return {
            uri: `${frontend}/${encodeURIComponent(user.username)}`,
            title: shortText(user.display_name || user.username, 100),
            description: shortText(`@${user.username}${user.bio ? `\n${user.bio}` : ''}`, 300),
            thumbUrl: buildAssetUrl(staticBase, user.avatar, { defaultExt: 'webp' }),
        };
    }

    if (embed.type === 'project' && embed.id) {
        const project = await prisma.ow_projects.findFirst({
            where: { id: Number(embed.id), state: 'public', AND: [await visibleWhere('project')] },
            select: {
                id: true,
                name: true,
                title: true,
                description: true,
                thumbnail: true,
                author: {
                    select: {
                        username: true,
                        display_name: true,
                        bio: true,
                        avatar: true,
                    },
                },
            },
        });
        if (!project?.author?.username || !project?.name) return null;
        return {
            uri: `${frontend}/${encodeURIComponent(project.author.username)}/${encodeURIComponent(project.name)}`,
            title: shortText(project.title || project.name, 100),
            description: shortText(`作者: @${project.author.username}${project.description ? `\n${project.description}` : ''}`, 300),
            thumbUrl: buildAssetUrl(staticBase, project.thumbnail),
        };
    }

    if (embed.type === 'list' && embed.id) {
        const list = await prisma.ow_projects_lists.findFirst({
            where: { id: Number(embed.id), state: 'public', AND: [await visibleWhere('list')] },
            select: {
                id: true,
                title: true,
                description: true,
                author: {
                    select: { username: true, display_name: true, avatar: true },
                },
            },
        });
        if (!list) return null;
        const listUri = list.author?.username
            ? `${frontend}/${encodeURIComponent(list.author.username)}/lists/${list.id}`
            : `${frontend}/lists/${list.id}`;
        return {
            uri: listUri,
            title: shortText(list.title || `列表 #${list.id}`, 100),
            description: shortText(`${list.author?.username ? `作者: @${list.author.username}\n` : ''}${list.description || ''}`, 300),
            thumbUrl: buildAssetUrl(staticBase, list.author?.avatar, { defaultExt: 'webp' }),
        };
    }

    if (embed.type === 'post' && embed.id) {
        const refPost = await prisma.ow_posts.findFirst({
            where: { id: Number(embed.id), AND: [await visibleWhere('post')] },
            select: {
                id: true,
                content: true,
                author: { select: { username: true, display_name: true } },
            },
        });
        return {
            uri: `${frontend}/app/posts/${Number(embed.id)}`,
            title: shortText('ZeroCat 帖子', 100),
            description: shortText(`${refPost?.author?.username ? `作者: @${refPost.author.username}\n` : ''}${refPost?.content || ''}`, 300),
        };
    }

    if (embed.type === 'url' && embed.url) {
        return {
            uri: String(embed.url),
            title: shortText(String(embed.title || embed.url), 100),
            description: shortText(String(embed.description || ''), 300),
            thumbUrl: String(embed.thumbnail || '').trim() || null,
        };
    }

    return null;
}

async function buildBlueskyExternalEmbed(agent, post) {
    const frontend = normalizeUrlBase(await zcconfig.get('urls.frontend'));
    const resolved = await resolveExternalFromOriginalEmbed(post?.embed, frontend);
    if (!resolved?.uri) return null;
    const thumb = await uploadImageBlobFromUrl(agent, resolved.thumbUrl);

    return {
        $type: 'app.bsky.embed.external',
        external: {
            uri: resolved.uri,
            title: resolved.title || 'ZeroCat',
            description: resolved.description || '',
            ...(thumb ? { thumb } : {}),
        },
    };
}

let cachedStaticBaseUrl = null;
async function getStaticBaseUrl() {
    if (cachedStaticBaseUrl) return cachedStaticBaseUrl;
    const raw = await zcconfig.get('s3.staticurl');
    const parsed = new URL(String(raw || '').trim());
    cachedStaticBaseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    return cachedStaticBaseUrl;
}

async function getPostMediaUrls(post) {
    const staticBase = await getStaticBaseUrl();
    const medias = Array.isArray(post?.post_media) ? post.post_media : [];
    return medias
        .map((item) => {
            const asset = item?.asset;
            if (!asset?.md5) return null;
            const ext = asset.extension || asset.mime_type?.split('/')[1] || 'webp';
            const p1 = asset.md5.substring(0, 2);
            const p2 = asset.md5.substring(2, 4);
            return {
                url: `${staticBase}/assets/${p1}/${p2}/${asset.md5}.${ext}`,
                mime: asset.mime_type || null,
            };
        })
        .filter(Boolean);
}

async function buildBlueskyImagesEmbed(agent, post) {
    const mediaUrls = await getPostMediaUrls(post);
    const images = [];

    for (const media of mediaUrls.slice(0, 4)) {
        if (!media.mime?.startsWith('image/')) continue;
        const resp = await fetch(media.url);
        if (!resp.ok) continue;
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const uploaded = await agent.uploadBlob(bytes, {
            encoding: media.mime || 'image/jpeg',
        });
        const blob = uploaded?.data?.blob || uploaded?.blob;
        if (!blob) continue;
        images.push({ image: blob, alt: '' });
    }

    if (images.length === 0) return null;
    return {
        $type: 'app.bsky.embed.images',
        images,
    };
}

async function createTwitterPost(actorUserId, post) {
    return withTwitterSdkClient(actorUserId, async ({ client, tokens }) => {
        try {
            if (post.post_type === 'retweet' && post.retweet_post_id) {
                const target = await getPostForEvent(post.retweet_post_id);
                const targetRef = normalizePlatformRefs(target?.platform_refs)?.twitter;
                if (!targetRef?.id) {
                    return { skipped: true, reason: 'missing_retweet_target_ref' };
                }

                const userId = await resolveTwitterActorId({ client, tokens, actorUserId });
                const rtResp = await client.tweets.usersIdRetweets(userId, {
                    tweet_id: String(targetRef.id),
                });

                return {
                    kind: 'retweet',
                    target_id: targetRef.id,
                    raw: rtResp,
                };
            }

            const text = await buildPostOutboundText(post);
            const body = { text };

            if (post.post_type === 'reply' && post.in_reply_to_id) {
                const parent = await getPostForEvent(post.in_reply_to_id);
                const parentRef = normalizePlatformRefs(parent?.platform_refs)?.twitter;
                if (!parentRef?.id) {
                    return { skipped: true, reason: 'missing_reply_target_ref' };
                }
                body.reply = { in_reply_to_tweet_id: String(parentRef.id) };
            }

            if (post.post_type === 'quote' && post.quoted_post_id) {
                const quoted = await getPostForEvent(post.quoted_post_id);
                const quotedRef = normalizePlatformRefs(quoted?.platform_refs)?.twitter;
                if (quotedRef?.id) {
                    body.quote_tweet_id = String(quotedRef.id);
                }
            }

            const payload = await client.tweets.createTweet(body);
            return {
                id: payload?.data?.id || null,
                raw: payload,
            };
        } catch (error) {
            throw wrapSocialError(error, formatTwitterSdkError(error, 'Twitter 发布失败'));
        }
    });
}

async function deleteTwitterPost(actorUserId, postRef) {
    if (!postRef?.id && !(postRef?.kind === 'retweet' && postRef?.target_id)) {
        return { skipped: true, reason: 'missing_ref' };
    }

    return withTwitterSdkClient(actorUserId, async ({ client, tokens }) => {
        try {
            if (postRef?.kind === 'retweet' && postRef?.target_id) {
                const userId = await resolveTwitterActorId({ client, tokens, actorUserId });
                return client.tweets.usersIdUnretweets(userId, String(postRef.target_id));
            }

            return client.tweets.deleteTweetById(String(postRef.id));
        } catch (error) {
            throw wrapSocialError(error, formatTwitterSdkError(error, 'Twitter 删除失败'));
        }
    });
}

async function sendTwitterEngagement(actorUserId, action, postRef) {
    if (!postRef?.id) return { skipped: true, reason: 'missing_ref' };

    return withTwitterSdkClient(actorUserId, async ({ client, tokens }) => {
        try {
            const requiredByAction = {
                like: ['like.write'],
                unlike: ['like.write'],
                bookmark: ['bookmark.write'],
                unbookmark: ['bookmark.write'],
            };

            const requiredScopes = requiredByAction[action] || [];
            if (requiredScopes.length > 0) {
                ensureTwitterTokenScopes(tokens, requiredScopes, action);
            }

            const userId = await resolveTwitterActorId({ client, tokens, actorUserId });

            if (action === 'like') {
                return client.tweets.usersIdLike(userId, { tweet_id: String(postRef.id) });
            }
            if (action === 'unlike') {
                return client.tweets.usersIdUnlike(userId, String(postRef.id));
            }
            if (action === 'bookmark') {
                return client.bookmarks.postUsersIdBookmarks(userId, { tweet_id: String(postRef.id) });
            }
            if (action === 'unbookmark') {
                return client.bookmarks.usersIdBookmarksDelete(userId, String(postRef.id));
            }
            return { skipped: true, reason: 'unsupported_action' };
        } catch (error) {
            throw wrapSocialError(error, formatTwitterSdkError(error, `Twitter ${action} 失败`));
        }
    });
}

async function getBlueskyAgent(actorUserId) {
    const tokens = await getBlueskySyncTokens(actorUserId);
    const did = await getUserAtprotoSyncDid(actorUserId) || tokens?.provider_user_id || tokens?.did;
    if (!did) throw new Error('未配置 Bluesky 同步 OAuth 令牌，请重新绑定');

    return restoreAtprotoSyncAgent({
        did,
        scope: 'atproto repo:* blob:*/* transition:generic account:* identity:*',
    });
}

async function createBlueskyPost(actorUserId, post) {
    const agent = await getBlueskyAgent(actorUserId);

    if (post.post_type === 'retweet' && post.retweet_post_id) {
        const target = await getPostForEvent(post.retweet_post_id);
        const targetRef = normalizePlatformRefs(target?.platform_refs)?.bluesky;
        if (!targetRef?.uri || !targetRef?.cid) {
            return { skipped: true, reason: 'missing_retweet_target_ref' };
        }
        return agent.repost(targetRef.uri, targetRef.cid);
    }

    const text = pickPostText(post);
    const richText = new RichText({ text });
    await richText.detectFacets(agent);
    const imageEmbed = await buildBlueskyImagesEmbed(agent, post);
    const externalEmbed = await buildBlueskyExternalEmbed(agent, post);

    const record = {
        text: richText.text,
        ...(Array.isArray(richText.facets) && richText.facets.length > 0 ? { facets: richText.facets } : {}),
        createdAt: new Date().toISOString(),
    };

    if (post.post_type === 'reply' && post.in_reply_to_id) {
        const parent = await getPostForEvent(post.in_reply_to_id);
        const parentRef = normalizePlatformRefs(parent?.platform_refs)?.bluesky;

        const rootPostId = post.thread_root_id || post.in_reply_to_id;
        const rootPost = await getPostForEvent(rootPostId);
        const rootRef = normalizePlatformRefs(rootPost?.platform_refs)?.bluesky || parentRef;

        if (!parentRef?.uri || !parentRef?.cid || !rootRef?.uri || !rootRef?.cid) {
            return { skipped: true, reason: 'missing_reply_target_ref' };
        }

        record.reply = {
            root: { uri: rootRef.uri, cid: rootRef.cid },
            parent: { uri: parentRef.uri, cid: parentRef.cid },
        };
    }

    if (post.post_type === 'quote' && post.quoted_post_id) {
        const quoted = await getPostForEvent(post.quoted_post_id);
        const quotedRef = normalizePlatformRefs(quoted?.platform_refs)?.bluesky;
        if (quotedRef?.uri && quotedRef?.cid) {
            const mediaEmbed = externalEmbed || imageEmbed || null;
            if (mediaEmbed) {
                record.embed = {
                    $type: 'app.bsky.embed.recordWithMedia',
                    record: {
                        record: {
                            uri: quotedRef.uri,
                            cid: quotedRef.cid,
                        },
                    },
                    media: mediaEmbed,
                };
            } else {
                record.embed = {
                    $type: 'app.bsky.embed.record',
                    record: {
                        uri: quotedRef.uri,
                        cid: quotedRef.cid,
                    },
                };
            }
        }
    } else if (externalEmbed) {
        record.embed = externalEmbed;
    } else if (imageEmbed) {
        record.embed = imageEmbed;
    }

    return agent.post(record);
}

async function deleteBlueskyPost(actorUserId, postRef) {
    if (!postRef?.uri) return { skipped: true, reason: 'missing_ref' };
    const agent = await getBlueskyAgent(actorUserId);
    if (postRef?.kind === 'repost') {
        await agent.deleteRepost(postRef.uri);
    } else {
        await agent.deletePost(postRef.uri);
    }
    return { ok: true };
}

async function likeBlueskyPost(actorUserId, postRef) {
    const agent = await getBlueskyAgent(actorUserId);
    const uri = String(postRef?.uri || '').trim();
    if (!uri) return { skipped: true, reason: 'missing_ref' };

    let cid = String(postRef?.cid || '').trim();
    if (!cid) {
        try {
            const getPostsResp = await agent.getPosts({ uris: [uri] });
            const first = Array.isArray(getPostsResp?.data?.posts) ? getPostsResp.data.posts[0] : null;
            cid = String(first?.cid || '').trim();
        } catch {
            cid = '';
        }
    }

    if (!cid) return { skipped: true, reason: 'missing_bluesky_ref' };
    return agent.like(uri, cid);
}

async function resolveBlueskyStrongRef(agent, postRef) {
    const uri = String(postRef?.uri || '').trim();
    if (!uri) return null;

    let cid = String(postRef?.cid || '').trim();
    if (!cid) {
        try {
            const getPostsResp = await agent.getPosts({ uris: [uri] });
            const first = Array.isArray(getPostsResp?.data?.posts) ? getPostsResp.data.posts[0] : null;
            cid = String(first?.cid || '').trim();
        } catch {
            cid = '';
        }
    }

    if (!cid) return null;
    return { uri, cid };
}

async function bookmarkBlueskyPost(actorUserId, postRef) {
    const agent = await getBlueskyAgent(actorUserId);
    const strongRef = await resolveBlueskyStrongRef(agent, postRef);
    if (!strongRef) return { skipped: true, reason: 'missing_bluesky_ref' };

    await agent.app.bsky.bookmark.createBookmark({
        uri: strongRef.uri,
        cid: strongRef.cid,
    });

    return {
        kind: 'bookmark',
        uri: strongRef.uri,
        cid: strongRef.cid,
    };
}

async function unbookmarkBlueskyPost(actorUserId, bookmarkRef) {
    const uri = String(bookmarkRef?.uri || '').trim();
    if (!uri) return { skipped: true, reason: 'missing_ref' };

    const agent = await getBlueskyAgent(actorUserId);
    await agent.app.bsky.bookmark.deleteBookmark({ uri });
    return { ok: true, kind: 'unbookmark', uri };
}

async function unlikeBlueskyPost(actorUserId, likeRef) {
    if (!likeRef?.uri) return { skipped: true, reason: 'missing_ref' };
    const agent = await getBlueskyAgent(actorUserId);
    await agent.deleteLike(likeRef.uri);
    return { ok: true };
}

async function handlePlatformCreate(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    if (refs?.[platform]) {
        return { skipped: true, reason: 'already_synced', ref: refs[platform] };
    }

    if (platform === 'twitter') {
        const ref = await createTwitterPost(actorUserId, post);
        if (ref?.id) await setPostPlatformRef(post.id, 'twitter', ref);
        if (ref?.kind === 'retweet' && ref?.target_id) await setPostPlatformRef(post.id, 'twitter', ref);
        return ref;
    }

    if (platform === 'bluesky') {
        const ref = await createBlueskyPost(actorUserId, post);
        if (ref?.uri) await setPostPlatformRef(post.id, 'bluesky', { uri: ref.uri, cid: ref.cid });
        if (ref?.uri && post.post_type === 'retweet') {
            await setPostPlatformRef(post.id, 'bluesky', { uri: ref.uri, cid: ref.cid || null, kind: 'repost' });
        }
        return ref;
    }

    return { skipped: true, reason: 'unknown_platform' };
}

async function handlePlatformDelete(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    const postRef = refs?.[platform];
    if (!postRef) return { skipped: true, reason: 'missing_ref' };

    if (platform === 'twitter') return deleteTwitterPost(actorUserId, postRef);
    if (platform === 'bluesky') return deleteBlueskyPost(actorUserId, postRef);
    return { skipped: true, reason: 'unknown_platform' };
}

async function handlePlatformLike(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    const postRef = refs?.[platform];
    if (!postRef) return { skipped: true, reason: 'missing_ref' };

    if (platform === 'twitter') {
        return sendTwitterEngagement(actorUserId, 'like', postRef);
    }

    if (platform === 'bluesky') {
        const likeRef = await likeBlueskyPost(actorUserId, postRef);
        if (likeRef?.skipped) return likeRef;
        await saveActionRef(post.id, 'bluesky', 'like', actorUserId, { uri: likeRef?.uri, cid: likeRef?.cid || null });
        return likeRef;
    }

    return { skipped: true, reason: 'unknown_platform' };
}

async function handlePlatformUnlike(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    const postRef = refs?.[platform];
    if (!postRef) return { skipped: true, reason: 'missing_ref' };

    if (platform === 'twitter') {
        return sendTwitterEngagement(actorUserId, 'unlike', postRef);
    }

    if (platform === 'bluesky') {
        const likeRef = await readActionRef(post.id, 'bluesky', 'like', actorUserId);
        const result = await unlikeBlueskyPost(actorUserId, likeRef);
        await removeActionRef(post.id, 'bluesky', 'like', actorUserId);
        return result;
    }

    return { skipped: true, reason: 'unknown_platform' };
}

async function handlePlatformBookmark(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    const postRef = refs?.[platform];
    if (!postRef) return { skipped: true, reason: 'missing_ref' };

    if (platform === 'twitter') {
        return sendTwitterEngagement(actorUserId, 'bookmark', postRef);
    }

    if (platform === 'bluesky') {
        const bookmarkRef = await bookmarkBlueskyPost(actorUserId, postRef);
        if (bookmarkRef?.skipped) return bookmarkRef;
        await saveActionRef(post.id, 'bluesky', 'bookmark', actorUserId, {
            uri: bookmarkRef?.uri,
            cid: bookmarkRef?.cid || null,
        });
        return bookmarkRef;
    }

    return { skipped: true, reason: 'unknown_platform' };
}

async function handlePlatformUnbookmark(platform, actorUserId, post) {
    const refs = normalizePlatformRefs(post?.platform_refs);
    const postRef = refs?.[platform];
    if (!postRef) return { skipped: true, reason: 'missing_ref' };

    if (platform === 'twitter') {
        return sendTwitterEngagement(actorUserId, 'unbookmark', postRef);
    }

    if (platform === 'bluesky') {
        const bookmarkRef = await readActionRef(post.id, 'bluesky', 'bookmark', actorUserId);
        const result = await unbookmarkBlueskyPost(actorUserId, bookmarkRef || postRef);
        await removeActionRef(post.id, 'bluesky', 'bookmark', actorUserId);
        return result;
    }

    return { skipped: true, reason: 'unknown_platform' };
}

function toEventType(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (Object.values(SOCIAL_EVENT_TYPES).includes(raw)) return raw;
    if (raw === 'manual' || !raw) return SOCIAL_EVENT_TYPES.POST_CREATE;
    return raw;
}

function ensureEnabledPlatforms(settings) {
    const platforms = [];
    if (settings?.twitter) platforms.push('twitter');
    if (settings?.bluesky) platforms.push('bluesky');
    return platforms;
}

export async function syncSocialEvent({ actorUserId, postId, eventType }) {
    const uid = Number(actorUserId);
    const pid = Number(postId);
    const type = toEventType(eventType);

    if (!uid || !pid) {
        return { skipped: true, reason: 'invalid_event_payload' };
    }

    try {
        await assertCanWrite(uid, 'posts', 'sync');
    } catch (error) {
        if (error.statusCode === 403 || error.status === 403) return { skipped: true, reason: 'actor_restricted' };
        throw error;
    }
    if (type !== SOCIAL_EVENT_TYPES.POST_DELETE) {
        const current = await prisma.ow_posts.findFirst({ where: { id: pid, AND: [await visibleWhere('post')] } });
        if (!current) return { skipped: true, reason: 'post_unavailable' };
        if ([SOCIAL_EVENT_TYPES.POST_CREATE, SOCIAL_EVENT_TYPES.POST_REPLY, SOCIAL_EVENT_TYPES.POST_QUOTE].includes(type) && current.author_id !== uid) {
            return { skipped: true, reason: 'actor_mismatch' };
        }
    }

    // ActivityPub 联邦同步（独立于平台同步设置）
    try {
        const { syncPostToActivityPub } = await import('../activitypub/outbox.js');
        await syncPostToActivityPub({ actorUserId: uid, postId: pid, eventType: type });
    } catch (apErr) {
        logger.error(`[social-sync] ActivityPub 同步错误 post=${pid}: ${apErr.message}`);
    }

    const settings = await getUserSocialSyncSettings(uid);
    const platforms = ensureEnabledPlatforms(settings);
    if (platforms.length === 0) {
        return { skipped: true, reason: 'sync_disabled' };
    }

    const post = await getPostForEvent(pid, { includeHidden: type === SOCIAL_EVENT_TYPES.POST_DELETE });
    if (!post) {
        return { skipped: true, reason: 'post_not_found' };
    }

    const results = {};
    const retryableErrors = [];

    for (const platform of platforms) {
        try {
            if ([SOCIAL_EVENT_TYPES.POST_CREATE, SOCIAL_EVENT_TYPES.POST_REPLY, SOCIAL_EVENT_TYPES.POST_QUOTE].includes(type)) {
                if (post.is_deleted) {
                    results[platform] = { skipped: true, reason: 'post_deleted' };
                } else {
                    results[platform] = await handlePlatformCreate(platform, uid, post);
                }
            } else if (type === SOCIAL_EVENT_TYPES.POST_DELETE) {
                results[platform] = await handlePlatformDelete(platform, uid, post);
            } else if (type === SOCIAL_EVENT_TYPES.POST_LIKE) {
                results[platform] = await handlePlatformLike(platform, uid, post);
            } else if (type === SOCIAL_EVENT_TYPES.POST_UNLIKE) {
                results[platform] = await handlePlatformUnlike(platform, uid, post);
            } else if (type === SOCIAL_EVENT_TYPES.POST_BOOKMARK) {
                results[platform] = await handlePlatformBookmark(platform, uid, post);
            } else if (type === SOCIAL_EVENT_TYPES.POST_UNBOOKMARK) {
                results[platform] = await handlePlatformUnbookmark(platform, uid, post);
            } else {
                results[platform] = { skipped: true, reason: 'unsupported_event' };
            }
        } catch (error) {
            const reason = platform === 'twitter'
                ? formatTwitterSdkError(error, 'Twitter 同步失败')
                : (String(error?.message || error || 'unknown_error').trim() || 'unknown_error');
            results[`${platform}_error`] = reason;
            logger.error(`[social-sync] ${platform} failed event=${type} post=${pid} user=${uid}: ${reason}`);

            if (isRetryableSocialError(error)) {
                retryableErrors.push({ platform, reason });
            }
        }
    }

    if (retryableErrors.length > 0) {
        const summary = retryableErrors.map((item) => `${item.platform}:${item.reason}`).join(' | ');
        throw wrapSocialError(
            { message: `retryable social sync error: ${summary}` },
            `retryable social sync error: ${summary}`
        );
    }

    await upsertTargetConfig(POST_TARGET_TYPE, pid, 'social.sync.last_event', {
        eventType: type,
        actorUserId: uid,
        results,
        synced_at: new Date().toISOString(),
    });

    return {
        actorUserId: uid,
        postId: pid,
        eventType: type,
        results,
    };
}

export async function syncPostToEnabledPlatforms({ userId, postId, trigger = 'create' }) {
    return syncSocialEvent({
        actorUserId: userId,
        postId,
        eventType: trigger,
    });
}

export async function getSocialIntegrationOverview(userId) {
    const [syncSettings, bindings, twitterAppConfig, twitterSyncTokens, blueskySyncTokens, blueskyPds, blueskyDid] = await Promise.all([
        getUserSocialSyncSettings(userId),
        getOAuthBindingStatus(userId),
        getTwitterSyncAppConfig(userId, { masked: true }),
        getTwitterSyncTokens(userId),
        getBlueskySyncTokens(userId),
        getUserBlueskyPds(userId),
        getUserAtprotoSyncDid(userId),
    ]);

    return {
        bindings,
        sync: syncSettings,
        twitter: {
            hasSyncAppConfig: Boolean(twitterAppConfig),
            hasSyncToken: Boolean(twitterSyncTokens?.access_token),
            appConfig: twitterAppConfig,
        },
        bluesky: {
            pds: blueskyPds,
            did: blueskyDid || null,
            hasSyncToken: Boolean(blueskyDid || blueskySyncTokens?.access_token),
        },
    };
}
