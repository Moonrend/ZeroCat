import { createHash, createDecipheriv } from 'crypto';
import axios from 'axios';
import { prisma } from '../prisma.js';
import { saveProjectFile } from '../projectFileStorage.js';
import zcconfig from '../config/zcconfig.js';
import logger from '../logger.js';
import { uploadFile, uploadToS3 } from '../assets.js';

const TARGET_TYPE_USER = 'mirror40_user';
const TARGET_TYPE_PROJECT = 'mirror40_project';
const TARGET_KEY_LOCAL_USER_ID = 'local_user_id';
const TARGET_KEY_LOCAL_PROJECT_ID = 'local_project_id';
const TARGET_KEY_LOCAL_PROFILE_PROJECT_ID = 'local_profile_project_id';
const TARGET_KEY_LAST_SYNC_AT = 'last_sync_at';
const TARGET_KEY_LAST_SYNC_STATUS = 'last_sync_status';
const TARGET_KEY_LAST_SYNC_DETAIL = 'last_sync_detail';
const TARGET_KEY_SYNC_DISABLED = 'sync_disabled';
const TARGET_KEY_SYNC_DISABLED_REASON = 'sync_disabled_reason';
const LOCAL_TARGET_TYPE_USER = 'user';
const LOCAL_TARGET_TYPE_PROJECT = 'project';
const REMOTE_TYPE_40CODE = '40code';
const REMOTE_META_KEY_TYPE = 'mirror.remote_type';
const REMOTE_META_KEY_ID = 'mirror.remote_id';
const REMOTE_META_KEY_UPDATED_AT = 'mirror.remote_updated_at';
const REMOTE_META_KEY_LAST_SYNC_AT = 'mirror.last_sync_at';
const REMOTE_META_KEY_VIEW_COUNT = 'mirror.remote_view_count';
const LEGACY_REMOTE_META_KEY_VIEW_COUNT = 'mirror40.remote_view_count';
const USER_SYNC_INTERVAL_DAYS_WITHOUT_REMOTE_TS = 7;
const MAX_AVATAR_DOWNLOAD_SIZE = 10 * 1024 * 1024;
const MAX_PROJECT_ASSET_DOWNLOAD_SIZE = 20 * 1024 * 1024;
const MIRROR40_PROJECT_ASSET_BASE_URL = 'https://abc.520gxx.com/static/internalapi/asset';
const MIRROR40_DECRYPT_KEY = '9609274736591562';
const MIRROR40_DECRYPT_IV = '4312549111852919';

const USER_SEARCH_PAYLOAD = {
    name: '',
    author: '',
    type: 1,
    s: 1,
    sid: '',
    fl: 0,
    fan: 0,
    follow: 0,
    page: '1',
    folder: 0,
};

const PROJECT_SEARCH_PAYLOAD = {
    name: '',
    author: '',
    type: '0',
    s: 2,
    sid: '',
    fl: 0,
    fan: 0,
    follow: 0,
    page: '1',
    folder: 0,
};

function toDateFromUnixSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n * 1000);
}

function toUnixSeconds(value) {
    if (!value) return 0;
    const date = value instanceof Date ? value : new Date(value);
    const ms = date.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.floor(ms / 1000);
}

function normalizeRemoteUpdateSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 9999999999) {
        return Math.floor(n / 1000);
    }
    return Math.floor(n);
}

function parseNonNegativeInteger(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

function pickRemoteViewCount(remoteProject) {
    const parsed = parseNonNegativeInteger(remoteProject?.look);
    return parsed ?? 0;
}

function sanitizeDisplayName(name, fallback) {
    const finalName = String(name || fallback || '').trim();
    if (!finalName) return fallback;
    return finalName.slice(0, 64);
}

function truncateText(value, maxLen) {
    const raw = String(value || '');
    if (raw.length <= maxLen) return raw;
    return raw.slice(0, maxLen);
}

function hashSource(source) {
    return createHash('sha256').update(source).digest('hex');
}

function buildCommitId(payload) {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stringifySource(source) {
    if (typeof source === 'string') return source;
    if (source === null || source === undefined) return '';
    return JSON.stringify(source);
}

function pickFirstArray(...candidates) {
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
}

function extractProjectList(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const data = payload.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
        return pickFirstArray(data.work, data.works, data.project, data.projects, data.list, data.data);
    }
    return [];
}

function sanitizeUrlForLog(url) {
    try {
        const u = new URL(url);
        if (u.searchParams.has('token')) {
            const token = u.searchParams.get('token') || '';
            const masked = token.length > 12
                ? `${token.slice(0, 6)}...${token.slice(-4)}`
                : '***';
            u.searchParams.set('token', masked);
        }
        return u.toString();
    } catch {
        return String(url).replace(/token=[^&]+/g, 'token=***');
    }
}

function truncateForLog(value, maxLen = 1500) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...(truncated)` : text;
}

function buildAvatarFilename(avatarValue) {
    const raw = String(avatarValue || '').trim();
    if (!raw) return 'avatar';
    const withoutQuery = raw.split('?')[0].split('#')[0];
    const name = withoutQuery.split('/').pop() || 'avatar';
    return truncateText(name, 120) || 'avatar';
}

function buildAssetFileName(assetValue, fallback = 'asset') {
    const raw = String(assetValue || '').trim();
    if (!raw) return fallback;
    const withoutQuery = raw.split('?')[0].split('#')[0];
    const name = withoutQuery.split('/').pop() || fallback;
    return truncateText(name, 120) || fallback;
}

function buildAvatarUrlCandidates(baseUrl, remoteUser) {
    const baseOrigin = (() => {
        try {
            return new URL(baseUrl).origin;
        } catch {
            return '';
        }
    })();

    const assetOrigins = (() => {
        const ordered = [];
        const pushUnique = (value) => {
            if (!value) return;
            if (!ordered.includes(value)) ordered.push(value);
        };

        pushUnique('https://abc.520gxx.com');

        if (baseOrigin) {
            const nonApiOrigin = baseOrigin.replace(/^(https?:\/\/)api\./i, '$1');
            const fromApiAbc = baseOrigin.replace(/^(https?:\/\/)api\.abc\./i, '$1abc.');

            pushUnique(nonApiOrigin);
            pushUnique(fromApiAbc);
            pushUnique(baseOrigin);
        }

        return ordered;
    })();

    const rawValues = [
        remoteUser?.head,
        remoteUser?.avatar,
        remoteUser?.image,
        remoteUser?.icon,
    ];

    const normalized = [];
    for (const raw of rawValues) {
        const value = String(raw || '').trim();
        if (!value) continue;

        if (/^\/\//.test(value)) {
            normalized.push(`https:${value}`);
            continue;
        }

        if (/^https?:\/\//i.test(value)) continue;

        if (value.startsWith('/')) {
            for (const origin of assetOrigins) {
                normalized.push(`${origin}${value}`);
            }
        } else {
            for (const origin of assetOrigins) {
                normalized.push(`${origin}/static/internalapi/asset/${value}`);
            }
        }
    }

    return Array.from(new Set(normalized));
}

function buildProjectCoverUrlCandidates(baseUrl, remoteProject) {
    const image = String(remoteProject?.image || '').trim();
    if (!image) return [];

    const baseOrigin = (() => {
        try {
            return new URL(baseUrl).origin;
        } catch {
            return '';
        }
    })();

    const assetOrigins = (() => {
        const ordered = [];
        const pushUnique = (value) => {
            if (!value) return;
            if (!ordered.includes(value)) ordered.push(value);
        };

        pushUnique('https://abc.520gxx.com');

        if (baseOrigin) {
            const nonApiOrigin = baseOrigin.replace(/^(https?:\/\/)api\./i, '$1');
            const fromApiAbc = baseOrigin.replace(/^(https?:\/\/)api\.abc\./i, '$1abc.');

            pushUnique(nonApiOrigin);
            pushUnique(fromApiAbc);
            pushUnique(baseOrigin);
        }

        return ordered;
    })();

    const candidates = [];

    if (/^\/\//.test(image)) {
        candidates.push(`https:${image}`);
        return Array.from(new Set(candidates));
    }

    if (/^https?:\/\//i.test(image)) {
        candidates.push(image);
        return Array.from(new Set(candidates));
    }

    if (image.startsWith('/')) {
        for (const origin of assetOrigins) {
            candidates.push(`${origin}${image}`);
            candidates.push(`${origin}/static/internalapi/asset${image}`);
        }
    } else {
        for (const origin of assetOrigins) {
            candidates.push(`${origin}/${image}`);
            candidates.push(`${origin}/static/internalapi/asset/${image}`);
            candidates.push(`${origin}/upload/${image}`);
            candidates.push(`${origin}/tx/${image}`);
        }
    }

    return Array.from(new Set(candidates));
}

function normalizeMd5Ext(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const withoutQuery = raw.split('?')[0].split('#')[0];
    const filename = withoutQuery.split('/').pop() || '';
    if (!filename || !filename.includes('.')) return null;

    const dotIndex = filename.indexOf('.');
    const md5 = filename.slice(0, dotIndex).toLowerCase();
    const ext = filename.slice(dotIndex + 1).toLowerCase();

    if (!/^[a-f0-9]{32}$/.test(md5)) return null;
    if (!/^[a-z0-9]+$/.test(ext)) return null;

    return `${md5}.${ext}`;
}

function extractProjectAssetMd5ExtList(projectJson) {
    const targets = Array.isArray(projectJson?.targets) ? projectJson.targets : [];
    const values = new Set();

    for (const target of targets) {
        const costumes = Array.isArray(target?.costumes) ? target.costumes : [];
        for (const costume of costumes) {
            const md5ext = normalizeMd5Ext(costume?.md5ext || `${costume?.assetId || ''}.${costume?.dataFormat || ''}`);
            if (md5ext) values.add(md5ext);
        }

        const sounds = Array.isArray(target?.sounds) ? target.sounds : [];
        for (const sound of sounds) {
            const md5ext = normalizeMd5Ext(sound?.md5ext || `${sound?.assetId || ''}.${sound?.dataFormat || ''}`);
            if (md5ext) values.add(md5ext);
        }
    }

    return Array.from(values);
}

function buildProjectAssetUrl(md5ext) {
    const filename = normalizeMd5Ext(md5ext);
    if (!filename) return null;
    return `${MIRROR40_PROJECT_ASSET_BASE_URL}/${filename}`;
}

function isNoSuchKeyError(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const rawBody = String(
        error?.responseData?.raw
        || error?.response?.data?.raw
        || error?.message
        || ''
    );

    return status === 404
        && (/NoSuchKey/i.test(rawBody) || /The specified key does not exist/i.test(rawBody));
}

function isUserAccessBlockedError(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    const body = error?.responseData || error?.response?.data || null;
    const text = String(
        body?.errmsg
        || body?.msg
        || body?.message
        || error?.message
        || ''
    );

    if (status !== 403) return false;
    return /暂停访问|违规|封禁|禁止访问/i.test(text);
}

function isUserNotFoundError(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status === 404) return true;

    const body = error?.responseData || error?.response?.data || null;
    const text = String(
        body?.errmsg
        || body?.msg
        || body?.message
        || error?.message
        || ''
    );

    if (status === 403 && /这个人不存在|用户不存在|not\s*found/i.test(text)) {
        return true;
    }

    return false;
}

function extractWorkSourcePayload(payload) {
    if (payload === null || payload === undefined) return null;

    if (typeof payload === 'string') return payload;

    if (typeof payload?.data?.raw === 'string') return payload.data.raw;
    if (typeof payload?.raw === 'string') return payload.raw;

    if (typeof payload?.data === 'string') return payload.data;

    if (payload?.data?.source !== undefined) return payload.data.source;
    if (payload?.data?.work !== undefined) return payload.data.work;
    if (payload?.data?.project !== undefined) return payload.data.project;

    if (payload?.source !== undefined) return payload.source;
    if (payload?.work !== undefined) return payload.work;

    if (payload?.data !== undefined) return payload.data;
    return payload;
}

function isLikelyHexCipherText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (text.length < 32 || text.length % 2 !== 0) return false;
    return /^[0-9a-fA-F]+$/.test(text);
}

function isLikelyJsonText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (!(text.startsWith('{') || text.startsWith('['))) return false;
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

function tryDecryptMirror40Source(source) {
    const raw = String(source || '').trim();
    if (!isLikelyHexCipherText(raw)) return null;

    try {
        const decipher = createDecipheriv(
            'aes-128-cbc',
            Buffer.from(MIRROR40_DECRYPT_KEY, 'utf8'),
            Buffer.from(MIRROR40_DECRYPT_IV, 'utf8')
        );
        decipher.setAutoPadding(true);

        const encrypted = Buffer.from(raw, 'hex');
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

        if (!decrypted) return null;
        const normalized = decrypted.trim();
        if (!isLikelyJsonText(normalized)) return null;

        return normalized;
    } catch {
        return null;
    }
}

class Mirror40CodeSyncService {
    async getConfig() {
        const enabled = await zcconfig.get('mirror40code.enabled', false);
        const token = await zcconfig.get('mirror40code.token', '');
        const baseUrl = String(await zcconfig.get('mirror40code.base_url', 'https://api.abc.520gxx.com')).replace(/\/+$/, '');
        const timeoutMs = Number(await zcconfig.get('mirror40code.timeout_ms', 15000)) || 15000;
        const listLimit = Number(await zcconfig.get('mirror40code.work_user_l', 20)) || 20;
        const maxPages = Number(await zcconfig.get('mirror40code.max_pages', 50)) || 50;
        const searchPageSize = Math.max(20, Number(await zcconfig.get('mirror40code.search.page_size', 100)) || 100);

        return { enabled, token, baseUrl, timeoutMs, listLimit, maxPages, searchPageSize };
    }

    ensureEnabled(cfg) {
        if (!cfg.enabled) {
            throw new Error('mirror40code 同步未启用，请先设置 mirror40code.enabled=true');
        }
        if (!cfg.token) {
            throw new Error('mirror40code.token 未配置');
        }
    }

    async requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
        const requestPayload = typeof body === 'string' ? (() => {
            try {
                return JSON.parse(body);
            } catch {
                return body;
            }
        })() : body;

        logger.debug(`[mirror-40code] API request ${method.toUpperCase()} ${sanitizeUrlForLog(url)} payload=${truncateForLog(requestPayload, 1000)}`);

        try {
            const response = await axios({
                url,
                method,
                headers,
                data: requestPayload,
                timeout: timeoutMs,
                validateStatus: () => true,
            });

            let parsed = response.data;
            if (typeof parsed === 'string') {
                try {
                    parsed = JSON.parse(parsed);
                } catch {
                    parsed = { raw: parsed };
                }
            }

            logger.debug(`[mirror-40code] API response ${method.toUpperCase()} ${sanitizeUrlForLog(url)} status=${response.status} data=${truncateForLog(parsed, 2000)}`);

            if (response.status < 200 || response.status >= 300) {
                const requestError = new Error(`请求失败 ${response.status}: ${truncateForLog(parsed, 500)}`);
                requestError.status = response.status;
                requestError.responseData = parsed;
                requestError.requestUrl = url;
                requestError.requestMethod = method;
                throw requestError;
            }

            return parsed ?? {};
        } catch (error) {
            if (error?.response) {
                logger.error(`[mirror-40code] API error ${method.toUpperCase()} ${sanitizeUrlForLog(url)} status=${error.response.status} body=${truncateForLog(error.response.data, 1500)}`);
            } else {
                logger.error(`[mirror-40code] API error ${method.toUpperCase()} ${sanitizeUrlForLog(url)} message=${error.message}`);
            }
            throw error;
        }
    }

    async downloadImageBuffer(url, timeoutMs, purpose = '图片') {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            maxContentLength: MAX_AVATAR_DOWNLOAD_SIZE,
            validateStatus: () => true,
            headers: {
                Accept: 'image/*,*/*;q=0.8',
                'User-Agent': 'ZeroCat-Mirror40Code/1.0',
            },
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`${purpose}下载失败: HTTP ${response.status}`);
        }

        const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
        const buffer = Buffer.from(response.data || '');

        if (!buffer || buffer.length === 0) {
            throw new Error(`${purpose}下载失败: 空内容`);
        }

        if (buffer.length > MAX_AVATAR_DOWNLOAD_SIZE) {
            throw new Error(`${purpose}下载失败: 大小超过限制 ${MAX_AVATAR_DOWNLOAD_SIZE}`);
        }

        return { buffer, contentType };
    }

    async downloadBinaryBuffer(url, timeoutMs, purpose = '素材') {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            maxContentLength: MAX_PROJECT_ASSET_DOWNLOAD_SIZE,
            validateStatus: () => true,
            headers: {
                Accept: '*/*',
                'User-Agent': 'ZeroCat-Mirror40Code/1.0',
            },
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`${purpose}下载失败: HTTP ${response.status}`);
        }

        const buffer = Buffer.from(response.data || '');
        if (!buffer || buffer.length === 0) {
            throw new Error(`${purpose}下载失败: 空内容`);
        }

        if (buffer.length > MAX_PROJECT_ASSET_DOWNLOAD_SIZE) {
            throw new Error(`${purpose}下载失败: 大小超过限制 ${MAX_PROJECT_ASSET_DOWNLOAD_SIZE}`);
        }

        return {
            buffer,
            contentType: String(response.headers?.['content-type'] || '').toLowerCase(),
        };
    }

    async syncSingleProjectAsset(cfg, remoteProjectId, md5ext) {
        const normalized = normalizeMd5Ext(md5ext);
        if (!normalized) {
            return { status: 'skipped', md5ext, reason: 'invalid_md5ext' };
        }

        const [md5] = normalized.split('.');
        const s3Key = `assets/${md5.slice(0, 2)}/${md5.slice(2, 4)}/${normalized}`;
        const assetUrl = buildProjectAssetUrl(normalized);
        if (!assetUrl) {
            return { status: 'skipped', md5ext, reason: 'invalid_asset_url' };
        }

        try {
            const { buffer, contentType } = await this.downloadBinaryBuffer(assetUrl, cfg.timeoutMs, '项目素材');
            await uploadToS3(buffer, s3Key, contentType || 'application/octet-stream');
            return {
                status: 'uploaded',
                md5ext: normalized,
                s3Key,
                sourceUrl: assetUrl,
            };
        } catch (error) {
            logger.warn(`[mirror-40code] 项目素材同步失败 remoteProject=${remoteProjectId} asset=${normalized} url=${sanitizeUrlForLog(assetUrl)} error=${error.message}`);
            return {
                status: 'failed',
                md5ext: normalized,
                reason: error?.message || 'unknown',
            };
        }
    }

    async syncProxyUserAvatar(cfg, remoteUser, localUser) {
        const candidates = buildAvatarUrlCandidates(cfg.baseUrl, remoteUser);
        if (candidates.length === 0) {
            return { updated: false, reason: 'avatar_missing' };
        }

        let lastError = null;
        for (const avatarUrl of candidates) {
            try {
                const { buffer, contentType } = await this.downloadImageBuffer(avatarUrl, cfg.timeoutMs, '头像');
                const file = {
                    buffer,
                    originalname: buildAvatarFilename(remoteUser?.head || remoteUser?.avatar || avatarUrl),
                    mimetype: contentType || 'application/octet-stream',
                };

                const fakeRes = { locals: { userid: localUser.id } };
                const uploadResult = await uploadFile(
                    file,
                    {
                        purpose: 'avatar',
                        category: 'avatars',
                        tags: 'mirror40code-avatar',
                    },
                    fakeRes,
                    'mirror40code-sync',
                    'ZeroCat-Mirror40Code/1.0'
                );

                const avatarMd5 = String(uploadResult?.asset?.md5 || '');
                if (!avatarMd5) {
                    throw new Error('头像上传后未返回MD5');
                }

                if (localUser.avatar === avatarMd5 && localUser.images === avatarMd5) {
                    return {
                        updated: false,
                        avatar: avatarMd5,
                        sourceUrl: avatarUrl,
                    };
                }

                await prisma.ow_users.update({
                    where: { id: localUser.id },
                    data: {
                        avatar: avatarMd5,
                        images: avatarMd5,
                    },
                });

                localUser.avatar = avatarMd5;
                localUser.images = avatarMd5;

                logger.info(`[mirror-40code] 用户头像同步成功 remoteUser=${remoteUser?.id} localUser=${localUser.id} avatar=${avatarMd5} url=${avatarUrl}`);
                return {
                    updated: true,
                    avatar: avatarMd5,
                    sourceUrl: avatarUrl,
                };
            } catch (error) {
                lastError = error;
                logger.warn(`[mirror-40code] 用户头像同步候选失败 remoteUser=${remoteUser?.id} localUser=${localUser.id} url=${sanitizeUrlForLog(avatarUrl)} error=${error.message}`);
            }
        }

        logger.warn(`[mirror-40code] 用户头像同步失败 remoteUser=${remoteUser?.id} localUser=${localUser.id} candidates=${candidates.length} lastError=${lastError?.message || 'unknown'}`);
        return {
            updated: false,
            reason: 'avatar_sync_failed',
            error: lastError?.message || 'unknown',
        };
    }

    async syncProjectThumbnail(cfg, remoteProject, localProject, localAuthorId) {
        const candidates = buildProjectCoverUrlCandidates(cfg.baseUrl, remoteProject);
        if (candidates.length === 0) {
            return { updated: false, reason: 'thumbnail_missing' };
        }

        let lastError = null;
        for (const coverUrl of candidates) {
            try {
                const { buffer, contentType } = await this.downloadImageBuffer(coverUrl, cfg.timeoutMs, '封面');
                const file = {
                    buffer,
                    originalname: buildAssetFileName(remoteProject?.image || coverUrl, 'thumbnail'),
                    mimetype: contentType || 'application/octet-stream',
                };

                const fakeRes = { locals: { userid: localAuthorId || null } };
                const uploadResult = await uploadFile(
                    file,
                    {
                        purpose: 'general',
                        category: 'images',
                        tags: 'mirror40code-thumbnail',
                        imageOptions: {
                            quality: 90,
                            maxWidth: 1024,
                            maxHeight: 1024,
                        },
                    },
                    fakeRes,
                    'mirror40code-sync',
                    'ZeroCat-Mirror40Code/1.0'
                );

                const md5 = String(uploadResult?.asset?.md5 || '');
                const extension = String(uploadResult?.asset?.extension || 'webp');
                if (!md5) {
                    throw new Error('封面上传后未返回MD5');
                }

                const thumbnailFilename = `${md5}.${extension}`;
                if (String(localProject?.thumbnail || '') === thumbnailFilename) {
                    return {
                        updated: false,
                        thumbnail: thumbnailFilename,
                        sourceUrl: coverUrl,
                    };
                }

                await prisma.ow_projects.update({
                    where: { id: localProject.id },
                    data: { thumbnail: thumbnailFilename },
                });
                localProject.thumbnail = thumbnailFilename;

                logger.info(`[mirror-40code] 项目封面同步成功 remoteProject=${remoteProject?.id} localProject=${localProject.id} thumbnail=${thumbnailFilename} url=${coverUrl}`);
                return {
                    updated: true,
                    thumbnail: thumbnailFilename,
                    sourceUrl: coverUrl,
                };
            } catch (error) {
                lastError = error;
                logger.warn(`[mirror-40code] 项目封面同步候选失败 remoteProject=${remoteProject?.id} localProject=${localProject?.id} url=${sanitizeUrlForLog(coverUrl)} error=${error.message}`);
            }
        }

        logger.warn(`[mirror-40code] 项目封面同步失败 remoteProject=${remoteProject?.id} localProject=${localProject?.id} candidates=${candidates.length} lastError=${lastError?.message || 'unknown'}`);
        return {
            updated: false,
            reason: 'thumbnail_sync_failed',
            error: lastError?.message || 'unknown',
        };
    }

    async fetchUserInfo(cfg, userId) {
        const url = `${cfg.baseUrl}/user/info?id=${encodeURIComponent(String(userId))}&token=${encodeURIComponent(cfg.token)}`;
        const payload = await this.requestJson(url, { timeoutMs: cfg.timeoutMs });
        const user = Array.isArray(payload?.data) ? payload.data[0] : null;
        return { payload, user };
    }

    async fetchUserWorkList(cfg, userId) {
        const url = `${cfg.baseUrl}/work/user?id=${encodeURIComponent(String(userId))}&l=${encodeURIComponent(String(cfg.listLimit))}`;
        const payload = await this.requestJson(url, { timeoutMs: cfg.timeoutMs });
        const list = extractProjectList(payload);
        return { payload, list };
    }

    async fetchSearchProjectsByAuthor(cfg, userId, page) {
        const url = `${cfg.baseUrl}/search/?token=${encodeURIComponent(cfg.token)}`;
        const body = {
            ...PROJECT_SEARCH_PAYLOAD,
            author: String(userId),
            page: String(page),
            l: cfg.searchPageSize,
        };
        logger.debug(`[mirror-40code] search projects by author remoteUser=${userId} page=${page} size=${cfg.searchPageSize}`);
        const payload = await this.requestJson(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            timeoutMs: cfg.timeoutMs,
        });

        const list = extractProjectList(payload);
        return { payload, list };
    }

    async fetchSearchProjectsPage(cfg, page = 1) {
        const url = `${cfg.baseUrl}/search/?token=${encodeURIComponent(cfg.token)}`;
        const pageValue = Number.isFinite(Number(page)) && Number(page) > 0
            ? String(Number(page))
            : '1';

        const body = {
            ...PROJECT_SEARCH_PAYLOAD,
            page: pageValue,
            l: cfg.searchPageSize,
        };

        logger.debug(`[mirror-40code] search projects page=${pageValue} size=${cfg.searchPageSize}`);

        const payload = await this.requestJson(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            timeoutMs: cfg.timeoutMs,
        });

        const code = Number(payload?.code);
        if (Number.isFinite(code) && code !== 1) {
            throw new Error(`/search 项目查询失败 code=${code} msg=${String(payload?.msg || '')}`);
        }
        logger.debug(payload.data.worklist)
        const list = payload.data.worklist;
        return {
            payload,
            list,
            page: Number(pageValue),
        };
    }

    async fetchSearchUsersPage(cfg, page = 1) {
        const url = `${cfg.baseUrl}/search/?token=${encodeURIComponent(cfg.token)}`;
        const pageValue = Number.isFinite(Number(page)) && Number(page) > 0
            ? String(Number(page))
            : '1';

        const body = {
            ...USER_SEARCH_PAYLOAD,
            page: pageValue,
            l: cfg.searchPageSize,
        };

        logger.debug(`[mirror-40code] search users page=${pageValue} size=${cfg.searchPageSize}`);

        const payload = await this.requestJson(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            timeoutMs: cfg.timeoutMs,
        });

        const code = Number(payload?.code);
        if (Number.isFinite(code) && code !== 1) {
            throw new Error(`/search 用户查询失败 code=${code} msg=${String(payload?.msg || '')}`);
        }

        const list = pickFirstArray(
            payload?.data?.user,
            payload?.data?.users,
            payload?.data?.author,
            payload?.data
        );

        return {
            payload,
            list,
            page: Number(pageValue),
        };
    }

    async fetchWorkInfo(cfg, projectId) {
        const url = `${cfg.baseUrl}/work/info?id=${encodeURIComponent(String(projectId))}`;
        const payload = await this.requestJson(url, { timeoutMs: cfg.timeoutMs });
        return { payload, project: payload?.data || null };
    }

    async fetchWorkSource(cfg, projectId) {
        const url = `${cfg.baseUrl}/work/work?id=${encodeURIComponent(String(projectId))}&token=${encodeURIComponent(cfg.token)}&sha=null&etime=null`;
        let payload;
        try {
            payload = await this.requestJson(url, { timeoutMs: cfg.timeoutMs });
        } catch (error) {
            if (isNoSuchKeyError(error)) {
                logger.warn(`[mirror-40code] work source missing project=${projectId} reason=NoSuchKey`);
                return { payload: error?.responseData || null, source: null, missing: true };
            }
            throw error;
        }

        const source = extractWorkSourcePayload(payload);
        let resolvedSource = source;
        let decrypted = false;

        if (typeof source === 'string' && !isLikelyJsonText(source)) {
            const decryptedSource = tryDecryptMirror40Source(source);
            if (decryptedSource) {
                resolvedSource = decryptedSource;
                decrypted = true;
            }
        }

        const sourcePreview = typeof resolvedSource === 'string'
            ? resolvedSource.slice(0, 120)
            : truncateForLog(resolvedSource, 120);
        logger.info(`[mirror-40code] work source extracted project=${projectId} type=${typeof resolvedSource} decrypted=${decrypted} preview=${sourcePreview}`);
        return { payload, source: resolvedSource, missing: false };
    }

    async getMappedLocalUserId(remoteUserId) {
        const record = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_USER,
                    target_id: String(remoteUserId),
                    key: TARGET_KEY_LOCAL_USER_ID,
                },
            },
            select: { value: true },
        });
        const id = Number(record?.value);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    async listMappedRemoteUserIds({ includeSyncDisabled = false } = {}) {
        const records = await prisma.ow_target_configs.findMany({
            where: {
                target_type: TARGET_TYPE_USER,
                key: TARGET_KEY_LOCAL_USER_ID,
            },
            select: { target_id: true },
        });

        const ids = records
            .map((item) => Number(item?.target_id))
            .filter((id) => Number.isFinite(id) && id > 0);

        const uniqueSorted = Array.from(new Set(ids)).sort((a, b) => a - b);
        if (includeSyncDisabled || uniqueSorted.length === 0) {
            return uniqueSorted;
        }

        const disabledRecords = await prisma.ow_target_configs.findMany({
            where: {
                target_type: TARGET_TYPE_USER,
                key: TARGET_KEY_SYNC_DISABLED,
                value: 'true',
            },
            select: { target_id: true },
        });
        const disabled = new Set(
            disabledRecords
                .map((item) => Number(item?.target_id))
                .filter((id) => Number.isFinite(id) && id > 0)
        );

        return uniqueSorted.filter((id) => !disabled.has(id));
    }

    async getLatestMappedRemoteUserId() {
        const ids = await this.listMappedRemoteUserIds({ includeSyncDisabled: true });
        if (!ids.length) return 0;
        return ids[ids.length - 1];
    }

    async probeUserAvailability(cfg, remoteUserId) {
        const parsedId = Number(remoteUserId);
        if (!Number.isFinite(parsedId) || parsedId <= 0) {
            return { notFound: true, blocked: false, user: null };
        }

        try {
            const { user } = await this.fetchUserInfo(cfg, parsedId);
            if (!user) return { notFound: true, blocked: false, user: null };
            return { notFound: false, blocked: false, user };
        } catch (error) {
            if (isUserNotFoundError(error)) {
                return { notFound: true, blocked: false, user: null };
            }
            if (isUserAccessBlockedError(error)) {
                return {
                    notFound: false,
                    blocked: true,
                    user: null,
                    reason: String(error?.responseData?.errmsg || error?.message || 'blocked'),
                };
            }
            throw error;
        }
    }

    async collectDailyUserSyncCandidates(cfg) {
        const maxPages = Math.max(1, Number(await zcconfig.get('mirror40code.daily.user_scan.max_pages', cfg.maxPages || 50)) || (cfg.maxPages || 50));
        const seenUserIds = new Set();
        const userCandidates = [];

        for (let page = 1; page <= maxPages; page++) {
            const result = await this.fetchSearchUsersPage(cfg, page);
            const list = Array.isArray(result?.list) ? result.list : [];
            logger.debug(`[mirror-40code] 每日用户扫描 page=${page} count=${list.length}`);

            if (list.length === 0) {
                logger.info(`[mirror-40code] 每日用户扫描在第 ${page} 页返回空列表，结束`);
                break;
            }

            for (const item of list) {
                const remoteUserId = Number(item?.id || item?.uid || item?.userid);
                if (!Number.isFinite(remoteUserId) || remoteUserId <= 0) continue;
                if (seenUserIds.has(remoteUserId)) continue;
                seenUserIds.add(remoteUserId);
                userCandidates.push({
                    remoteUserId,
                    remoteUpdateTime: normalizeRemoteUpdateSeconds(
                        item?.update_time
                        || item?.time
                        || item?.last_time
                        || item?.publish_time
                    ) || null,
                });
            }
        }

        logger.info(`[mirror-40code] 每日用户扫描完成 candidates=${userCandidates.length} scannedUnique=${seenUserIds.size}`);
        return userCandidates;
    }

    async shouldEnqueueProjectByTimestamp(remoteProjectId, remoteUpdateTimeSeconds) {
        const parsedProjectId = Number(remoteProjectId);
        if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
            return false;
        }

        const mappedLocalProjectId = await this.getMappedLocalProjectId(parsedProjectId);
        if (!mappedLocalProjectId) {
            return true;
        }

        const marker = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: LOCAL_TARGET_TYPE_PROJECT,
                    target_id: String(mappedLocalProjectId),
                    key: REMOTE_META_KEY_ID,
                },
            },
            select: { value: true },
        });

        const legacyMarker = !marker
            ? await prisma.ow_target_configs.findUnique({
                where: {
                    target_type_target_id_key: {
                        target_type: LOCAL_TARGET_TYPE_PROJECT,
                        target_id: String(mappedLocalProjectId),
                        key: 'mirror40.remote_project_id',
                    },
                },
                select: { value: true },
            })
            : null;

        const markerValue = marker?.value ?? legacyMarker?.value;
        if (!markerValue || String(markerValue) !== String(parsedProjectId)) {
            return true;
        }

        const localProject = await prisma.ow_projects.findUnique({
            where: { id: mappedLocalProjectId },
            select: { time: true },
        });

        if (!localProject?.time) {
            return true;
        }

        const remoteTs = normalizeRemoteUpdateSeconds(remoteUpdateTimeSeconds);
        if (!remoteTs) {
            return true;
        }

        const localTs = toUnixSeconds(localProject.time);
        const needSync = remoteTs > localTs;
        logger.debug(`[mirror-40code] 项目入队判定 remoteProject=${parsedProjectId} remoteTs=${remoteTs} localTs=${localTs} needSync=${needSync}`);
        return needSync;
    }

    async shouldEnqueueUserByTimestamp(remoteUserId, remoteUpdateTimeSeconds) {
        const parsedUserId = Number(remoteUserId);
        if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
            return false;
        }

        const mappedLocalUserId = await this.getMappedLocalUserId(parsedUserId);
        if (!mappedLocalUserId) {
            return true;
        }

        const marker = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: LOCAL_TARGET_TYPE_USER,
                    target_id: String(mappedLocalUserId),
                    key: REMOTE_META_KEY_ID,
                },
            },
            select: { value: true },
        });

        const legacyMarker = !marker
            ? await prisma.ow_target_configs.findUnique({
                where: {
                    target_type_target_id_key: {
                        target_type: LOCAL_TARGET_TYPE_USER,
                        target_id: String(mappedLocalUserId),
                        key: 'mirror40.remote_user_id',
                    },
                },
                select: { value: true },
            })
            : null;

        const markerValue = marker?.value ?? legacyMarker?.value;
        if (!markerValue || String(markerValue) !== String(parsedUserId)) {
            return true;
        }

        const remoteTs = normalizeRemoteUpdateSeconds(remoteUpdateTimeSeconds);
        if (!remoteTs) {
            const lastSyncMarker = await prisma.ow_target_configs.findUnique({
                where: {
                    target_type_target_id_key: {
                        target_type: LOCAL_TARGET_TYPE_USER,
                        target_id: String(mappedLocalUserId),
                        key: REMOTE_META_KEY_LAST_SYNC_AT,
                    },
                },
                select: { value: true },
            });

            const legacyLastSyncMarker = !lastSyncMarker
                ? await prisma.ow_target_configs.findUnique({
                    where: {
                        target_type_target_id_key: {
                            target_type: LOCAL_TARGET_TYPE_USER,
                            target_id: String(mappedLocalUserId),
                            key: 'mirror40.last_sync_at',
                        },
                    },
                    select: { value: true },
                })
                : null;

            const lastSyncTs = toUnixSeconds(lastSyncMarker?.value || legacyLastSyncMarker?.value);
            const nowTs = Math.floor(Date.now() / 1000);
            const intervalSeconds = USER_SYNC_INTERVAL_DAYS_WITHOUT_REMOTE_TS * 24 * 60 * 60;
            const ageSeconds = lastSyncTs > 0 ? Math.max(0, nowTs - lastSyncTs) : null;
            const needSync = !lastSyncTs || (nowTs - lastSyncTs) >= intervalSeconds;
            logger.debug(`[mirror-40code] 用户入队判定 remoteUser=${parsedUserId} 无远端更新时间，按间隔判定 lastSyncTs=${lastSyncTs} ageSeconds=${ageSeconds ?? 'none'} thresholdSeconds=${intervalSeconds} needSync=${needSync}`);
            return needSync;
        }

        const updateMarker = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: LOCAL_TARGET_TYPE_USER,
                    target_id: String(mappedLocalUserId),
                    key: REMOTE_META_KEY_UPDATED_AT,
                },
            },
            select: { value: true },
        });

        const localTs = normalizeRemoteUpdateSeconds(updateMarker?.value);
        const needSync = !localTs || remoteTs > localTs;
        logger.debug(`[mirror-40code] 用户入队判定 remoteUser=${parsedUserId} remoteTs=${remoteTs} localTs=${localTs} needSync=${needSync}`);
        return needSync;
    }

    async collectDailyProjectSyncItems() {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);

        const maxPages = Math.max(1, Number(await zcconfig.get('mirror40code.daily.project_scan.max_pages', cfg.maxPages || 50)) || (cfg.maxPages || 50));
        const seenProjectIds = new Set();
        const projectItems = [];
        let stopScan = false;

        for (let page = 1; page <= maxPages; page++) {
            if (stopScan) break;
            const result = await this.fetchSearchProjectsPage(cfg, page);
            const list = Array.isArray(result?.list) ? result.list : [];
            logger.debug(`[mirror-40code] 每日项目扫描 page=${page} count=${list.length}`);

            if (list.length === 0) {
                logger.info(`[mirror-40code] 每日项目扫描在第 ${page} 页返回空列表，结束`);
                break;
            }

            for (const item of list) {
                const remoteProjectId = Number(item?.id);
                if (!Number.isFinite(remoteProjectId) || remoteProjectId <= 0) continue;
                if (seenProjectIds.has(remoteProjectId)) continue;
                seenProjectIds.add(remoteProjectId);

                const remoteUpdateTime = normalizeRemoteUpdateSeconds(item?.update_time || item?.time || item?.publish_time || 0);
                const needSync = await this.shouldEnqueueProjectByTimestamp(remoteProjectId, remoteUpdateTime);
                if (!needSync) {
                    logger.debug(`[mirror-40code] 每日项目扫描提前停止 remoteProject=${remoteProjectId} page=${page} reason=already_synced`);
                    stopScan = true;
                    break;
                }

                const remoteUserId = Number(item?.author);
                projectItems.push({
                    remoteProjectId,
                    remoteUserId: Number.isFinite(remoteUserId) && remoteUserId > 0 ? remoteUserId : null,
                    remoteUpdateTime: Number.isFinite(remoteUpdateTime) && remoteUpdateTime > 0 ? remoteUpdateTime : null,
                });
            }
        }

        logger.info(`[mirror-40code] 每日项目扫描完成 candidates=${projectItems.length} scannedUnique=${seenProjectIds.size}`);
        return projectItems;
    }

    async collectDailySyncCandidates() {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);

        const userCandidates = await this.collectDailyUserSyncCandidates(cfg);
        const projectItems = await this.collectDailyProjectSyncItems();
        logger.debug(`[mirror-40code] 每日候选合并开始 userCandidates=${userCandidates.length} projectCandidates=${projectItems.length}`);

        const userIdSet = new Set(
            userCandidates
                .map((item) => Number(item?.remoteUserId))
                .filter((id) => Number.isFinite(id) && id > 0)
        );

        for (const item of projectItems) {
            const remoteUserId = Number(item?.remoteUserId);
            if (!Number.isFinite(remoteUserId) || remoteUserId <= 0) continue;
            userIdSet.add(remoteUserId);
        }

        const newUserIds = Array.from(userIdSet).sort((a, b) => a - b);

        logger.debug(`[mirror-40code] 每日候选合并完成 users=${newUserIds.length} projects=${projectItems.length}`);

        return {
            newUserIds,
            projectItems,
        };
    }

    async upsertUserMapping(remoteUserId, localUserId) {
        await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_USER,
                    target_id: String(remoteUserId),
                    key: TARGET_KEY_LOCAL_USER_ID,
                },
            },
            update: { value: String(localUserId) },
            create: {
                target_type: TARGET_TYPE_USER,
                target_id: String(remoteUserId),
                key: TARGET_KEY_LOCAL_USER_ID,
                value: String(localUserId),
            },
        });
    }

    async upsertTargetConfig(targetType, targetId, key, value) {
        await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: String(targetType),
                    target_id: String(targetId),
                    key: String(key),
                },
            },
            update: { value: String(value ?? '') },
            create: {
                target_type: String(targetType),
                target_id: String(targetId),
                key: String(key),
                value: String(value ?? ''),
            },
        });
    }

    async upsertLocalRemoteMetadata(localTargetType, localTargetId, {
        remoteType = REMOTE_TYPE_40CODE,
        remoteId = null,
        remoteUpdatedAt = null,
    } = {}) {
        const tasks = [
            this.upsertTargetConfig(localTargetType, String(localTargetId), REMOTE_META_KEY_TYPE, String(remoteType || REMOTE_TYPE_40CODE)),
            this.upsertTargetConfig(localTargetType, String(localTargetId), REMOTE_META_KEY_LAST_SYNC_AT, new Date().toISOString()),
        ];

        if (remoteId !== null && remoteId !== undefined && String(remoteId).length > 0) {
            tasks.push(this.upsertTargetConfig(localTargetType, String(localTargetId), REMOTE_META_KEY_ID, String(remoteId)));
        }

        const normalizedRemoteUpdatedAt = normalizeRemoteUpdateSeconds(remoteUpdatedAt);
        if (normalizedRemoteUpdatedAt > 0) {
            tasks.push(this.upsertTargetConfig(localTargetType, String(localTargetId), REMOTE_META_KEY_UPDATED_AT, String(normalizedRemoteUpdatedAt)));
        }

        await Promise.all(tasks);
    }

    async recordUserSyncState(remoteUserId, {
        status = 'success',
        detail = '',
        localUserId = null,
    } = {}) {
        const targetId = String(remoteUserId);
        const now = new Date().toISOString();
        const tasks = [
            this.upsertTargetConfig(TARGET_TYPE_USER, targetId, TARGET_KEY_LAST_SYNC_AT, now),
            this.upsertTargetConfig(TARGET_TYPE_USER, targetId, TARGET_KEY_LAST_SYNC_STATUS, status),
            this.upsertTargetConfig(TARGET_TYPE_USER, targetId, TARGET_KEY_LAST_SYNC_DETAIL, truncateText(String(detail || ''), 1000)),
        ];

        if (Number.isFinite(Number(localUserId)) && Number(localUserId) > 0) {
            tasks.push(this.upsertTargetConfig(TARGET_TYPE_USER, targetId, TARGET_KEY_LOCAL_USER_ID, String(localUserId)));
        }

        await Promise.all(tasks);
    }

    async markUserSyncDisabled(remoteUserId, reason) {
        await Promise.all([
            this.upsertTargetConfig(TARGET_TYPE_USER, String(remoteUserId), TARGET_KEY_SYNC_DISABLED, 'true'),
            this.upsertTargetConfig(TARGET_TYPE_USER, String(remoteUserId), TARGET_KEY_SYNC_DISABLED_REASON, truncateText(String(reason || ''), 1000)),
        ]);
    }

    async ensureBlockedProxyUser(remoteUserId, reason = '') {
        const remoteId = Number(remoteUserId);
        if (!Number.isFinite(remoteId) || remoteId <= 0) {
            throw new Error(`远程用户ID无效: ${remoteUserId}`);
        }

        const mappedUserId = await this.getMappedLocalUserId(remoteId);
        const username = `${remoteId}@40code.com`;
        const legacyUsername = `m40u_${remoteId}`;
        const email = `${remoteId}@40code.com`;
        const detail = truncateText(String(reason || '此用户主页含违规内容，暂停同步'), 1000);

        let user = null;
        if (mappedUserId) {
            user = await prisma.ow_users.findUnique({ where: { id: mappedUserId } });
        }
        if (!user) {
            user = await prisma.ow_users.findUnique({ where: { username } });
        }
        if (!user) {
            user = await prisma.ow_users.findUnique({ where: { username: legacyUsername } });
        }
        if (!user) {
            user = await prisma.ow_users.findFirst({ where: { email } });
        }

        const data = {
            username,
            email,
            display_name: username,
            status: 'banned',
            type: 'user',
            bio: detail,
            loginTime: new Date(),
        };

        if (!user) {
            user = await prisma.ow_users.create({
                data: {
                    ...data,
                    regTime: new Date(),
                },
            });
        } else {
            user = await prisma.ow_users.update({
                where: { id: user.id },
                data,
            });
        }

        await this.upsertUserMapping(remoteId, user.id);
        await this.markUserSyncDisabled(remoteId, detail);
        return user;
    }

    async recordProjectSyncState(remoteProjectId, {
        status = 'success',
        detail = '',
        localProjectId = null,
    } = {}) {
        const targetId = String(remoteProjectId);
        const now = new Date().toISOString();
        const tasks = [
            this.upsertTargetConfig(TARGET_TYPE_PROJECT, targetId, TARGET_KEY_LAST_SYNC_AT, now),
            this.upsertTargetConfig(TARGET_TYPE_PROJECT, targetId, TARGET_KEY_LAST_SYNC_STATUS, status),
            this.upsertTargetConfig(TARGET_TYPE_PROJECT, targetId, TARGET_KEY_LAST_SYNC_DETAIL, truncateText(String(detail || ''), 1000)),
        ];

        if (Number.isFinite(Number(localProjectId)) && Number(localProjectId) > 0) {
            tasks.push(this.upsertTargetConfig(TARGET_TYPE_PROJECT, targetId, TARGET_KEY_LOCAL_PROJECT_ID, String(localProjectId)));
        }

        await Promise.all(tasks);
    }

    async upsertProjectMapping(remoteProjectId, localProjectId) {
        await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_PROJECT,
                    target_id: String(remoteProjectId),
                    key: TARGET_KEY_LOCAL_PROJECT_ID,
                },
            },
            update: { value: String(localProjectId) },
            create: {
                target_type: TARGET_TYPE_PROJECT,
                target_id: String(remoteProjectId),
                key: TARGET_KEY_LOCAL_PROJECT_ID,
                value: String(localProjectId),
            },
        });
    }

    async upsertProjectSyncMarker(localProjectId, markerKey, markerValue) {
        await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: 'project',
                    target_id: String(localProjectId),
                    key: markerKey,
                },
            },
            update: {
                value: String(markerValue),
            },
            create: {
                target_type: 'project',
                target_id: String(localProjectId),
                key: markerKey,
                value: String(markerValue),
            },
        });
    }

    async markSyncedProject(localProjectId, { remoteProjectId = null, remoteUserId = null, remoteUpdatedAt = null, remoteType = REMOTE_TYPE_40CODE, isProfileArticle = false } = {}) {
        const tasks = [
            this.upsertLocalRemoteMetadata(LOCAL_TARGET_TYPE_PROJECT, String(localProjectId), {
                remoteType,
                remoteId: remoteProjectId,
                remoteUpdatedAt,
            }),
            this.upsertProjectSyncMarker(localProjectId, 'mirror40.synced', 'true'),
            this.upsertProjectSyncMarker(localProjectId, 'mirror40.source', String(remoteType || REMOTE_TYPE_40CODE)),
            this.upsertProjectSyncMarker(localProjectId, 'mirror40.profile_article', isProfileArticle ? 'true' : 'false'),
            this.upsertTargetConfig('project', String(localProjectId), 'mirror40.last_sync_at', new Date().toISOString()),
        ];

        if (Number.isFinite(Number(remoteProjectId)) && Number(remoteProjectId) > 0) {
            tasks.push(this.upsertProjectSyncMarker(localProjectId, 'mirror40.remote_project_id', String(remoteProjectId)));
        }

        if (Number.isFinite(Number(remoteUserId)) && Number(remoteUserId) > 0) {
            tasks.push(this.upsertProjectSyncMarker(localProjectId, 'mirror40.remote_user_id', String(remoteUserId)));
        }

        await Promise.all(tasks);
    }

    async getMappedProfileArticleProjectId(remoteUserId) {
        const record = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_USER,
                    target_id: String(remoteUserId),
                    key: TARGET_KEY_LOCAL_PROFILE_PROJECT_ID,
                },
            },
            select: { value: true },
        });

        const id = Number(record?.value);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    async upsertProfileArticleProjectMapping(remoteUserId, localProjectId) {
        await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_USER,
                    target_id: String(remoteUserId),
                    key: TARGET_KEY_LOCAL_PROFILE_PROJECT_ID,
                },
            },
            update: { value: String(localProjectId) },
            create: {
                target_type: TARGET_TYPE_USER,
                target_id: String(remoteUserId),
                key: TARGET_KEY_LOCAL_PROFILE_PROJECT_ID,
                value: String(localProjectId),
            },
        });
    }

    async ensureProxyUser(remoteUser, cfg) {
        const remoteId = Number(remoteUser?.id);
        if (!Number.isFinite(remoteId) || remoteId <= 0) {
            throw new Error('远程用户ID无效');
        }

        const mappedUserId = await this.getMappedLocalUserId(remoteId);
        const username = `${remoteId}@40code.com`;
        const legacyUsername = `m40u_${remoteId}`;
        const email = `${remoteId}@40code.com`;
        const displayName = sanitizeDisplayName(remoteUser?.nickname, username);
        const remoteBio = truncateText(String(remoteUser?.introduce || ''), 1000);

        const baseData = {
            email,
            display_name: displayName,
            status: 'active',
            type: 'user',
            bio: remoteBio,
        };

        let user = null;

        if (mappedUserId) {
            user = await prisma.ow_users.findUnique({ where: { id: mappedUserId } });
        }

        if (!user) {
            user = await prisma.ow_users.findUnique({ where: { username } });
        }

        if (!user) {
            user = await prisma.ow_users.findUnique({ where: { username: legacyUsername } });
        }

        if (!user) {
            user = await prisma.ow_users.findFirst({ where: { email } });
        }

        if (!user) {
            user = await prisma.ow_users.create({
                data: {
                    username,
                    ...baseData,
                    regTime: new Date(),
                    loginTime: new Date(),
                },
            });
        } else {
            const updateData = { ...baseData };

            if (user.username !== username) {
                const usernameOwner = await prisma.ow_users.findUnique({
                    where: { username },
                    select: { id: true },
                });

                if (!usernameOwner || usernameOwner.id === user.id) {
                    updateData.username = username;
                } else {
                    logger.warn(`[mirror-40code] 用户名迁移冲突 remoteUser=${remoteId} target=${username} owner=${usernameOwner.id}`);
                }
            }

            user = await prisma.ow_users.update({
                where: { id: user.id },
                data: updateData,
            });
        }

        await this.upsertUserMapping(remoteId, user.id);
        await Promise.all([
            this.upsertLocalRemoteMetadata(LOCAL_TARGET_TYPE_USER, String(user.id), {
                remoteType: REMOTE_TYPE_40CODE,
                remoteId,
                remoteUpdatedAt: remoteUser?.update_time,
            }),
            this.upsertTargetConfig('user', String(user.id), 'mirror40.remote_user_id', String(remoteId)),
            this.upsertTargetConfig('user', String(user.id), 'mirror40.last_sync_at', new Date().toISOString()),
            this.upsertTargetConfig('user', String(user.id), 'mirror40.remote_update_time', String(Number(remoteUser?.update_time || 0) || 0)),
        ]);

        if (cfg) {
            await this.syncProxyUserAvatar(cfg, remoteUser, user).catch((error) => {
                logger.warn(`[mirror-40code] 用户头像同步异常 remoteUser=${remoteId} localUser=${user.id} error=${error.message}`);
            });
        }

        return user;
    }

    async ensureProfileArticleProject(remoteUser, localUser) {
        const remoteUserId = Number(remoteUser?.id);
        if (!Number.isFinite(remoteUserId) || remoteUserId <= 0) {
            throw new Error('远程用户ID无效，无法创建简介镜像项目');
        }

        const mappedProjectId = await this.getMappedProfileArticleProjectId(remoteUserId);
        const projectName = `${remoteUserId}@40code.com`;
        const legacyProjectName = `m40u_${remoteUserId}`;
        const projectTitle = truncateText(`${localUser.display_name || projectName} 的40code简介`, 1000);
        const articleDescription = truncateText(`40code用户简介镜像\n远端用户ID: ${remoteUserId}`, 1000);

        let project = null;
        if (mappedProjectId) {
            project = await prisma.ow_projects.findUnique({ where: { id: mappedProjectId } });
        }

        if (!project) {
            project = await prisma.ow_projects.findFirst({
                where: {
                    authorid: localUser.id,
                    name: { in: [projectName, legacyProjectName] },
                    type: { in: ['article', 'readme'] },
                },
            });
        }

        const data = {
            name: projectName,
            title: projectTitle,
            description: articleDescription,
            type: 'readme',
            state: 'public',
            authorid: localUser.id,
            default_branch: 'main',
            history: true,
            time: new Date(),
        };

        if (!project) {
            project = await prisma.ow_projects.create({ data });
        } else {
            project = await prisma.ow_projects.update({
                where: { id: project.id },
                data,
            });
        }

        await this.upsertProfileArticleProjectMapping(remoteUserId, project.id);
        await this.markSyncedProject(project.id, {
            remoteUserId,
            isProfileArticle: true,
        });

        const introSource = String(remoteUser?.introduce ?? '');
        const articleSource = introSource.length > 0 ? introSource : ' ';
        await this.saveProjectSourceAndCommit(project, localUser.id, { id: `user-${remoteUserId}` }, articleSource);

        return project;
    }

    async collectUserProjectSyncItems(cfg, remoteUserId) {
        const items = [];
        const seenProjectIds = new Set();

        for (let page = 1; page <= cfg.maxPages; page++) {
            const result = await this.fetchSearchProjectsByAuthor(cfg, remoteUserId, page);
            const list = Array.isArray(result?.list) ? result.list : [];
            logger.debug(`[mirror-40code] 用户项目扫描 remoteUser=${remoteUserId} page=${page} count=${list.length}`);
            if (list.length === 0) break;

            for (const item of list) {
                const projectId = Number(item?.id);
                if (!Number.isFinite(projectId) || projectId <= 0) continue;
                if (seenProjectIds.has(projectId)) continue;
                seenProjectIds.add(projectId);

                const remoteUpdateTime = normalizeRemoteUpdateSeconds(item?.update_time || item?.time || item?.publish_time || 0);
                const needSync = await this.shouldEnqueueProjectByTimestamp(projectId, remoteUpdateTime);
                if (!needSync) continue;

                items.push({
                    remoteProjectId: projectId,
                    remoteUserId: Number(remoteUserId),
                    remoteUpdateTime: remoteUpdateTime > 0 ? remoteUpdateTime : null,
                });
            }
        }

        logger.debug(`[mirror-40code] 用户项目候选完成 remoteUser=${remoteUserId} candidates=${items.length} scannedUnique=${seenProjectIds.size}`);
        return items;
    }

    async fetchUserCollectionFolders(cfg, remoteUserId) {
        const url = `${cfg.baseUrl}/collections/folders?id=${encodeURIComponent(String(remoteUserId))}&token=${encodeURIComponent(cfg.token)}`;
        const payload = await this.requestJson(url, { timeoutMs: cfg.timeoutMs });

        const folders = pickFirstArray(
            payload?.folders,
            payload?.data?.folders,
            payload?.data,
        );

        return {
            payload,
            folders,
        };
    }

    async fetchSearchProjectsByFolder(cfg, folderId, page = 1) {
        const parsedFolderId = Number(folderId);
        if (!Number.isFinite(parsedFolderId) || parsedFolderId <= 0) {
            throw new Error(`无效收藏夹ID: ${folderId}`);
        }

        const url = `${cfg.baseUrl}/search/?token=${encodeURIComponent(cfg.token)}`;
        const pageValue = Number.isFinite(Number(page)) && Number(page) > 0
            ? String(Number(page))
            : '1';

        const body = {
            ...PROJECT_SEARCH_PAYLOAD,
            s: '4',
            folder: String(parsedFolderId),
            page: pageValue,
            l: cfg.searchPageSize,
        };

        logger.debug(`[mirror-40code] search projects by folder folder=${parsedFolderId} page=${pageValue} size=${cfg.searchPageSize}`);

        const payload = await this.requestJson(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            timeoutMs: cfg.timeoutMs,
        });

        const code = Number(payload?.code);
        if (Number.isFinite(code) && code !== 1) {
            throw new Error(`/search 收藏夹项目查询失败 code=${code} msg=${String(payload?.msg || '')}`);
        }

        const list = pickFirstArray(
            payload?.data?.worklist,
            payload?.data?.work,
            payload?.data?.works,
            payload?.data?.list,
            payload?.data,
        );

        return {
            payload,
            list,
            page: Number(pageValue),
            folderId: parsedFolderId,
        };
    }

    async collectUserCollectionProjectItems(cfg, remoteUserId) {
        const { folders } = await this.fetchUserCollectionFolders(cfg, remoteUserId);

        const effectiveFolders = (Array.isArray(folders) ? folders : [])
            .filter((folder) => {
                const folderId = Number(folder?.id);
                if (!Number.isFinite(folderId) || folderId <= 0) return false;
                if (folder?.delete !== null && folder?.delete !== undefined && Number(folder?.delete) !== 0) return false;
                return true;
            });

        const items = [];
        const seenProjectIds = new Set();

        for (const folder of effectiveFolders) {
            const folderId = Number(folder?.id);
            for (let page = 1; page <= cfg.maxPages; page++) {
                const result = await this.fetchSearchProjectsByFolder(cfg, folderId, page);
                const list = Array.isArray(result?.list) ? result.list : [];

                logger.debug(`[mirror-40code] 收藏夹项目扫描 remoteUser=${remoteUserId} folder=${folderId} page=${page} count=${list.length}`);
                if (list.length === 0) break;

                for (const item of list) {
                    const remoteProjectId = Number(item?.id);
                    if (!Number.isFinite(remoteProjectId) || remoteProjectId <= 0) continue;
                    if (seenProjectIds.has(remoteProjectId)) continue;
                    seenProjectIds.add(remoteProjectId);

                    const remoteAuthorId = Number(item?.author);
                    const remoteUpdateTime = normalizeRemoteUpdateSeconds(item?.update_time || item?.time || item?.publish_time || 0);

                    items.push({
                        remoteProjectId,
                        remoteUserId: Number.isFinite(remoteAuthorId) && remoteAuthorId > 0 ? remoteAuthorId : null,
                        remoteUpdateTime: remoteUpdateTime > 0 ? remoteUpdateTime : null,
                        folderId,
                    });
                }
            }
        }

        logger.debug(`[mirror-40code] 收藏夹项目候选完成 remoteUser=${remoteUserId} folders=${effectiveFolders.length} candidates=${items.length}`);
        return {
            folders: effectiveFolders,
            items,
        };
    }

    async starLocalProjectForUser(localUserId, localProjectId) {
        const parsedUserId = Number(localUserId);
        const parsedProjectId = Number(localProjectId);
        if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
            throw new Error(`无效 localUserId: ${localUserId}`);
        }
        if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
            throw new Error(`无效 localProjectId: ${localProjectId}`);
        }

        const created = await prisma.$transaction(async (tx) => {
            const existing = await tx.ow_projects_stars.findFirst({
                where: {
                    userid: parsedUserId,
                    projectid: parsedProjectId,
                },
                select: { id: true },
            });

            if (existing) {
                return false;
            }

            await tx.ow_projects_stars.create({
                data: {
                    userid: parsedUserId,
                    projectid: parsedProjectId,
                    createTime: new Date(),
                },
            });

            await tx.ow_projects.update({
                where: { id: parsedProjectId },
                data: {
                    star_count: {
                        increment: 1,
                    },
                },
            });

            return true;
        });

        return {
            created,
            localUserId: parsedUserId,
            localProjectId: parsedProjectId,
        };
    }

    async syncAndStarCollectedProjects(cfg, localUserId, projectItems) {
        const items = Array.isArray(projectItems) ? projectItems : [];

        let total = 0;
        let starred = 0;
        let alreadyStarred = 0;
        let skipped = 0;
        let failed = 0;

        for (const item of items) {
            const remoteProjectId = Number(item?.remoteProjectId ?? item?.id);
            if (!Number.isFinite(remoteProjectId) || remoteProjectId <= 0) {
                skipped += 1;
                continue;
            }

            total += 1;

            try {
                let localProjectId = await this.getMappedLocalProjectId(remoteProjectId);
                if (!localProjectId) {
                    const syncResult = await this.syncProject(remoteProjectId, item?.remoteUserId ?? null);
                    if (!syncResult?.skipped && Number.isFinite(Number(syncResult?.localProjectId)) && Number(syncResult?.localProjectId) > 0) {
                        localProjectId = Number(syncResult.localProjectId);
                    } else {
                        skipped += 1;
                        continue;
                    }
                }

                const starResult = await this.starLocalProjectForUser(localUserId, localProjectId);
                if (starResult.created) {
                    starred += 1;
                } else {
                    alreadyStarred += 1;
                }
            } catch (error) {
                failed += 1;
                logger.warn(`[mirror-40code] 收藏项目星标失败 localUser=${localUserId} remoteProject=${remoteProjectId} error=${error.message}`);
            }
        }

        return {
            total,
            starred,
            alreadyStarred,
            skipped,
            failed,
        };
    }

    async syncUser(remoteUserId, options = {}) {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);

        const parsedUserId = Number(remoteUserId);
        if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
            throw new Error(`无效远程用户ID: ${remoteUserId}`);
        }

        try {
            const { user: remoteUser } = await this.fetchUserInfo(cfg, parsedUserId);
            if (!remoteUser) {
                throw new Error(`远程用户不存在或无法获取: ${parsedUserId}`);
            }

            logger.debug(`[mirror-40code] 用户同步执行 remoteUser=${parsedUserId} mode=always-sync`);

            const localUser = await this.ensureProxyUser(remoteUser, cfg);
            const profileArticleProject = await this.ensureProfileArticleProject(remoteUser, localUser);
            const projectItems = await this.collectUserProjectSyncItems(cfg, parsedUserId);
            const collection = await this.collectUserCollectionProjectItems(cfg, parsedUserId).catch((error) => {
                logger.warn(`[mirror-40code] 收藏夹项目拉取失败 remoteUser=${parsedUserId} error=${error.message}`);
                return {
                    folders: [],
                    items: [],
                };
            });
            const collectionStarSync = await this.syncAndStarCollectedProjects(cfg, localUser.id, collection.items);

            await this.recordUserSyncState(parsedUserId, {
                status: 'success',
                detail: `projects_to_enqueue=${projectItems.length};collections=${collection.items.length};starred=${collectionStarSync.starred};already_starred=${collectionStarSync.alreadyStarred};star_failed=${collectionStarSync.failed}`,
                localUserId: localUser.id,
            });

            return {
                remoteUserId: parsedUserId,
                localUserId: localUser.id,
                profileArticleProjectId: profileArticleProject.id,
                projectItems,
                collectionFolders: collection.folders.length,
                collectionProjects: collection.items.length,
                collectionStarSync,
                displayName: localUser.display_name,
            };
        } catch (error) {
            if (isUserAccessBlockedError(error)) {
                const reason = String(
                    error?.responseData?.errmsg
                    || error?.responseData?.msg
                    || error?.message
                    || '此主页含有违规内容，已被暂停访问'
                );
                const localUser = await this.ensureBlockedProxyUser(parsedUserId, reason);
                await this.recordUserSyncState(parsedUserId, {
                    status: 'skipped',
                    detail: `blocked:${reason}`,
                    localUserId: localUser.id,
                }).catch(() => { });

                return {
                    remoteUserId: parsedUserId,
                    localUserId: localUser.id,
                    skipped: true,
                    reason: 'user_blocked',
                    projectItems: [],
                    displayName: localUser.display_name,
                };
            }

            await this.recordUserSyncState(parsedUserId, {
                status: 'failed',
                detail: error.message,
            }).catch(() => { });
            throw error;
        }
    }

    async getMappedLocalProjectId(remoteProjectId) {
        const record = await prisma.ow_target_configs.findUnique({
            where: {
                target_type_target_id_key: {
                    target_type: TARGET_TYPE_PROJECT,
                    target_id: String(remoteProjectId),
                    key: TARGET_KEY_LOCAL_PROJECT_ID,
                },
            },
            select: { value: true },
        });
        const id = Number(record?.value);
        return Number.isFinite(id) && id > 0 ? id : null;
    }

    buildProjectMetadata(remoteProject, localAuthorId) {
        const remoteProjectId = Number(remoteProject?.id);
        const projectName = truncateText(String(remoteProject?.name || `40code-${remoteProjectId}`), 128);

        return {
            name: `${remoteProjectId}`,
            title: truncateText(projectName, 1000),
            description: truncateText(String(remoteProject?.introduce || `40code镜像作品 ${remoteProjectId}`), 1000),
            type: 'scratch',
            state: 'public',
            authorid: localAuthorId,
            default_branch: 'main',
            like_count: Number(remoteProject?.like) || 0,
            favo_count: Number(remoteProject?.num_collections) || 0,
            star_count: Number(remoteProject?.like) || 0,
            time: toDateFromUnixSeconds(remoteProject?.update_time || remoteProject?.publish_time || remoteProject?.time) || new Date(),
            history: true,
        };
    }

    async ensureMirrorProject(remoteProject, localAuthorId, remoteAuthorId = null) {
        const remoteProjectId = Number(remoteProject?.id);
        if (!Number.isFinite(remoteProjectId) || remoteProjectId <= 0) {
            throw new Error('远程项目ID无效');
        }

        const metadata = this.buildProjectMetadata(remoteProject, localAuthorId);
        const mappedProjectId = await this.getMappedLocalProjectId(remoteProjectId);

        let project = null;
        if (mappedProjectId) {
            project = await prisma.ow_projects.findUnique({ where: { id: mappedProjectId } });
        }

        if (!project) {
            project = await prisma.ow_projects.findFirst({
                where: {
                    name: metadata.name,
                    authorid: localAuthorId,
                },
            });
        }

        if (!project) {
            project = await prisma.ow_projects.create({ data: metadata });
        } else {
            project = await prisma.ow_projects.update({
                where: { id: project.id },
                data: metadata,
            });
        }

        await this.upsertProjectMapping(remoteProjectId, project.id);
        await this.markSyncedProject(project.id, {
            remoteProjectId,
            remoteUserId: remoteAuthorId,
            remoteUpdatedAt: remoteProject?.update_time || remoteProject?.time || remoteProject?.publish_time,
            remoteType: REMOTE_TYPE_40CODE,
            isProfileArticle: false,
        });

        const remoteViewCount = pickRemoteViewCount(remoteProject);
        await Promise.all([
            this.upsertTargetConfig(LOCAL_TARGET_TYPE_PROJECT, String(project.id), REMOTE_META_KEY_VIEW_COUNT, String(remoteViewCount)),
            this.upsertTargetConfig(LOCAL_TARGET_TYPE_PROJECT, String(project.id), LEGACY_REMOTE_META_KEY_VIEW_COUNT, String(remoteViewCount)),
        ]);

        return project;
    }

    async saveProjectSourceAndCommit(localProject, localAuthorId, remoteProject, rawSource) {
        const source = stringifySource(rawSource);
        if (!source || source.length === 0) {
            throw new Error(`远程项目 ${remoteProject?.id} 源码为空`);
        }

        const sourceSha = hashSource(source);

        await saveProjectFile(source, { userId: localAuthorId, sha256: sourceSha });

        const branch = 'main';
        const latestCommit = await prisma.ow_projects_commits.findFirst({
            where: {
                project_id: localProject.id,
                branch,
            },
            orderBy: { commit_date: 'desc' },
            select: {
                id: true,
                commit_file: true,
            },
        });

        if (latestCommit?.commit_file === sourceSha) {
            return {
                updated: false,
                commitId: latestCommit.id,
                sourceSha,
            };
        }

        const now = new Date();
        const isFirstCommit = !latestCommit;
        const commitMessage = isFirstCommit
            ? '初始化提交'
            : `40code镜像同步 #${remoteProject?.id}`;
        const commitId = buildCommitId({
            sourceSha,
            projectId: localProject.id,
            remoteProjectId: remoteProject?.id,
            remoteVersion: remoteProject?.version,
            at: now.toISOString(),
        });

        await prisma.$transaction(async (tx) => {
            await tx.ow_projects_commits.create({
                data: {
                    id: commitId,
                    project_id: localProject.id,
                    author_id: localAuthorId,
                    branch,
                    parent_commit_id: latestCommit?.id || null,
                    commit_file: sourceSha,
                    commit_message: commitMessage,
                    commit_description: isFirstCommit
                        ? '# 初始化提交'
                        : truncateText(`自动镜像同步\n远端项目ID: ${remoteProject?.id}\n远端更新时间: ${remoteProject?.update_time || ''}`, 1000),
                    commit_date: now,
                },
            });

            await tx.ow_projects_branch.upsert({
                where: {
                    projectid_name: {
                        projectid: localProject.id,
                        name: branch,
                    },
                },
                update: {
                    latest_commit_hash: commitId,
                },
                create: {
                    projectid: localProject.id,
                    name: branch,
                    latest_commit_hash: commitId,
                    creator: localAuthorId,
                    description: '镜像默认分支',
                },
            });

            await tx.ow_projects.update({
                where: { id: localProject.id },
                data: {
                    default_branch: branch,
                },
            });
        });

        return {
            updated: true,
            commitId,
            sourceSha,
        };
    }

    async ensureAuthorByRemoteId(cfg, remoteUserId) {
        const id = Number(remoteUserId);
        if (!Number.isFinite(id) || id <= 0) {
            throw new Error(`远程作者ID无效: ${remoteUserId}`);
        }

        let mappedUser = null;
        const mappedUserId = await this.getMappedLocalUserId(id);
        if (mappedUserId) {
            mappedUser = await prisma.ow_users.findUnique({ where: { id: mappedUserId } });
        }

        try {
            const { user: remoteUser } = await this.fetchUserInfo(cfg, id);
            if (!remoteUser) {
                if (mappedUser) {
                    logger.warn(`[mirror-40code] 作者远端信息为空，使用本地映射用户 remoteUser=${id} localUser=${mappedUser.id}`);
                    return mappedUser;
                }
                throw new Error(`无法拉取作者信息: ${id}`);
            }
            return this.ensureProxyUser(remoteUser, cfg);
        } catch (error) {
            if (isUserNotFoundError(error)) {
                if (mappedUser) {
                    logger.warn(`[mirror-40code] 作者远端不存在，使用本地映射用户 remoteUser=${id} localUser=${mappedUser.id}`);
                    return mappedUser;
                }
                logger.warn(`[mirror-40code] 作者远端不存在，跳过项目同步 remoteUser=${id}`);
                return null;
            }
            if (mappedUser) {
                logger.warn(`[mirror-40code] 作者信息刷新失败，使用本地映射用户 remoteUser=${id} localUser=${mappedUser.id} error=${error.message}`);
                return mappedUser;
            }
            throw error;
        }
    }

    async syncProject(remoteProjectId, remoteAuthorHint = null) {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);

        const parsedProjectId = Number(remoteProjectId);
        if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
            throw new Error(`无效远程项目ID: ${remoteProjectId}`);
        }

        try {
            const { project: remoteProject } = await this.fetchWorkInfo(cfg, parsedProjectId);
            if (!remoteProject || Number(remoteProject?.id) !== parsedProjectId) {
                await this.recordProjectSyncState(parsedProjectId, {
                    status: 'skipped',
                    detail: 'not_found',
                });
                return {
                    remoteProjectId: parsedProjectId,
                    skipped: true,
                    reason: 'not_found',
                };
            }

            const remoteAuthorId = Number(remoteProject?.author || remoteAuthorHint);
            if (!Number.isFinite(remoteAuthorId) || remoteAuthorId <= 0) {
                await this.recordProjectSyncState(parsedProjectId, {
                    status: 'skipped',
                    detail: 'author_missing',
                });
                return {
                    remoteProjectId: parsedProjectId,
                    skipped: true,
                    reason: 'author_missing',
                };
            }

            const localAuthor = await this.ensureAuthorByRemoteId(cfg, remoteAuthorId);
            if (!localAuthor) {
                await this.recordProjectSyncState(parsedProjectId, {
                    status: 'skipped',
                    detail: 'author_not_found',
                });
                return {
                    remoteProjectId: parsedProjectId,
                    remoteAuthorId,
                    skipped: true,
                    reason: 'author_not_found',
                };
            }

            const localProject = await this.ensureMirrorProject(remoteProject, localAuthor.id, remoteAuthorId);

            await this.syncProjectThumbnail(cfg, remoteProject, localProject, localAuthor.id).catch((error) => {
                logger.warn(`[mirror-40code] 项目封面同步异常 remoteProject=${parsedProjectId} localProject=${localProject.id} error=${error.message}`);
            });

            const { source, missing } = await this.fetchWorkSource(cfg, parsedProjectId);
            if (missing) {
                await this.recordProjectSyncState(parsedProjectId, {
                    status: 'skipped',
                    detail: 'source_not_found',
                    localProjectId: localProject.id,
                });
                return {
                    remoteProjectId: parsedProjectId,
                    remoteAuthorId,
                    localAuthorId: localAuthor.id,
                    localProjectId: localProject.id,
                    skipped: true,
                    reason: 'source_not_found',
                };
            }

            if (source === null || source === undefined || source === '') {
                await this.recordProjectSyncState(parsedProjectId, {
                    status: 'skipped',
                    detail: 'source_empty',
                    localProjectId: localProject.id,
                });
                return {
                    remoteProjectId: parsedProjectId,
                    remoteAuthorId,
                    localAuthorId: localAuthor.id,
                    localProjectId: localProject.id,
                    skipped: true,
                    reason: 'source_empty',
                };
            }

            const commitResult = await this.saveProjectSourceAndCommit(localProject, localAuthor.id, remoteProject, source);

            await this.recordProjectSyncState(parsedProjectId, {
                status: 'success',
                detail: commitResult.updated ? 'updated' : 'unchanged',
                localProjectId: localProject.id,
            });

            return {
                remoteProjectId: parsedProjectId,
                remoteAuthorId,
                localAuthorId: localAuthor.id,
                localProjectId: localProject.id,
                updated: commitResult.updated,
                commitId: commitResult.commitId,
                sourceSha: commitResult.sourceSha,
            };
        } catch (error) {
            await this.recordProjectSyncState(parsedProjectId, {
                status: 'failed',
                detail: error.message,
            }).catch(() => { });
            throw error;
        }
    }

    async syncProjectAssets(remoteProjectId) {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);

        const parsedProjectId = Number(remoteProjectId);
        if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
            throw new Error(`无效远程项目ID: ${remoteProjectId}`);
        }

        const { source, missing } = await this.fetchWorkSource(cfg, parsedProjectId);
        if (missing) {
            return {
                remoteProjectId: parsedProjectId,
                skipped: true,
                reason: 'source_not_found',
            };
        }

        if (source === null || source === undefined || source === '') {
            return {
                remoteProjectId: parsedProjectId,
                skipped: true,
                reason: 'source_empty',
            };
        }

        const projectJson = (() => {
            if (typeof source === 'object' && source !== null) return source;
            if (typeof source === 'string') {
                try {
                    return JSON.parse(source);
                } catch {
                    return null;
                }
            }
            return null;
        })();

        if (!projectJson || typeof projectJson !== 'object') {
            return {
                remoteProjectId: parsedProjectId,
                skipped: true,
                reason: 'source_not_json',
            };
        }

        const md5extList = extractProjectAssetMd5ExtList(projectJson);
        if (md5extList.length === 0) {
            return {
                remoteProjectId: parsedProjectId,
                assetsTotal: 0,
                uploaded: 0,
                failed: 0,
                skipped: 0,
            };
        }

        const results = await Promise.allSettled(
            md5extList.map((md5ext) => this.syncSingleProjectAsset(cfg, parsedProjectId, md5ext))
        );

        let uploaded = 0;
        let failed = 0;
        let skipped = 0;
        for (const result of results) {
            if (result?.status === 'rejected') {
                failed += 1;
                continue;
            }

            const item = result?.value;
            if (item?.status === 'uploaded') uploaded += 1;
            else if (item?.status === 'skipped') skipped += 1;
            else failed += 1;
        }

        logger.info(`[mirror-40code] 项目素材同步完成 remoteProject=${parsedProjectId} total=${md5extList.length} uploaded=${uploaded} failed=${failed} skipped=${skipped} concurrency=unlimited`);
        return {
            remoteProjectId: parsedProjectId,
            assetsTotal: md5extList.length,
            uploaded,
            failed,
            skipped,
            concurrency: 'unlimited',
        };
    }

    async pingRemote() {
        const cfg = await this.getConfig();
        this.ensureEnabled(cfg);
        const url = `${cfg.baseUrl}/search/?token=${encodeURIComponent(cfg.token)}`;
        const payload = await this.requestJson(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(USER_SEARCH_PAYLOAD),
            timeoutMs: cfg.timeoutMs,
        });
        logger.debug(`[mirror-40code] pingRemote payload=${truncateForLog(payload, 1500)}`);
        return {
            ok: payload?.code === 1 || Boolean(payload?.data),
            code: payload?.code,
        };
    }
}

const mirror40CodeSyncService = new Mirror40CodeSyncService();

export default mirror40CodeSyncService;
