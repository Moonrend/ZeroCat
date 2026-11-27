/**
 * 远程媒体缓存服务
 * 将远程 ActivityPub 用户的头像 / 横幅图片下载到本地 S3，
 * 并在 ow_assets 中建立记录（带 mastodon-sync 标签），
 * 返回本地 MD5 哈希供 ow_users.avatar / images 字段使用。
 */

import { createHash } from 'crypto';
import sharp from 'sharp';
import logger from '../logger.js';
import { prisma } from '../prisma.js';
import { federationGet, publicNetworkGet } from './federationHttp.js';
import {
    generateMD5,
    uploadToS3,
    checkAssetExists,
    createAssetRecord,
    processImage,
} from '../assets.js';

// ── 常量 ────────────────────────────────────────────
const FETCH_TIMEOUT = 15_000;           // 15 秒超时
const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 最大 10 MB
const DEFAULT_HASH = 'fcd939e653195bb6d057e8c2519f5cc7';

// 用于 ow_assets 的标记
const SYNC_TAG = 'activitypub-sync';
const AVATAR_CATEGORY = 'avatars';
const BANNER_CATEGORY = 'images';

// ── 内存级简易缓存 ─────────────────────────────────────
// key = remoteUrl, value = { md5, ts }
const urlHashCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

function getCachedHash(remoteUrl) {
    const entry = urlHashCache.get(remoteUrl);
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.md5;
    urlHashCache.delete(remoteUrl);
    return null;
}
function setCachedHash(remoteUrl, md5) {
    urlHashCache.set(remoteUrl, { md5, ts: Date.now() });
    // 防止无限膨胀
    if (urlHashCache.size > 5000) {
        const oldest = urlHashCache.keys().next().value;
        urlHashCache.delete(oldest);
    }
}

// ── 核心：下载 + 处理 + 存储 ─────────────────────────────
/**
 * 将远程图片 URL 缓存到本地 S3 并在 ow_assets 中记录
 *
 * @param {string} remoteUrl     - 远程图片完整 URL
 * @param {object} options
 * @param {'avatar'|'banner'} options.purpose - 用途（决定裁剪策略）
 * @param {number|null} options.proxyUserId  - 关联的代理用户 ID（存入 uploader_id）
 * @param {string|null} options.actorUrl     - 来源 Actor URL（写入 metadata）
 * @param {boolean} options.enforceFederationPolicy - 是否应用联邦实例策略
 * @returns {Promise<string>} 本地 MD5 哈希；失败时返回 DEFAULT_HASH
 */
export async function cacheRemoteImage(remoteUrl, {
    purpose = 'avatar',
    proxyUserId = null,
    actorUrl = null,
    // 可选：允许非 ActivityPub 场景（如 OAuth）自定义标签/元数据
    source = 'activitypub',
    tags = SYNC_TAG,
    uploaderIp = 'activitypub-sync',
    uploaderUa = 'ZeroCat-AP-Federation/1.0',
    extraMetadata = null,
    enforceFederationPolicy = true,
} = {}) {
    if (!remoteUrl || typeof remoteUrl !== 'string') return DEFAULT_HASH;

    // 如果已经是本地 MD5 哈希（32 位 hex），直接返回
    if (/^[0-9a-f]{32}$/i.test(remoteUrl)) return remoteUrl;

    try {
        // 内存缓存命中
        const cached = getCachedHash(remoteUrl);
        if (cached) {
            logger.debug(`[ap-media] 缓存命中: ${remoteUrl} -> ${cached}`);
            return cached;
        }

        // ── 1. 下载远程图片 ──────────────────────────────
        const buffer = await downloadRemoteImage(remoteUrl, { enforceFederationPolicy });
        if (!buffer || buffer.length === 0) {
            logger.warn(`[ap-media] 下载失败或为空: ${remoteUrl}（详见上一条下载失败/HTTP异常日志）`);
            return DEFAULT_HASH;
        }

        // ── 2. 处理图片 ─────────────────────────────────
        let processedBuffer;
        let finalExtension = 'webp';
        let finalMimeType = 'image/webp';
        let processingMeta = {};

        if (purpose === 'avatar') {
            // 头像：512×512 webp，质量 95，≤500KB
            const result = await processImage(buffer, {
                width: 512,
                height: 512,
                format: 'webp',
                quality: 95,
                sanitize: true,
                maxFileSize: 500 * 1024,
            });
            processedBuffer = result.buffer;
            processingMeta = {
                originalSize: buffer.length,
                processedSize: result.size,
                dimensions: { width: result.width, height: result.height },
                compressionRatio: result.compressionRatio,
            };
        } else {
            // 横幅：保持原始宽高比，转 webp，限制 1500 宽
            const result = await processImage(buffer, {
                maxWidth: 1500,
                format: 'webp',
                quality: 85,
                sanitize: true,
            });
            processedBuffer = result.buffer;
            processingMeta = {
                originalSize: buffer.length,
                processedSize: result.size,
                dimensions: { width: result.width, height: result.height },
                compressionRatio: result.compressionRatio,
            };
        }

        // ── 3. MD5 去重 ─────────────────────────────────
        const md5 = generateMD5(processedBuffer);

        // 先检查是否已经存在
        const existing = await checkAssetExists(md5);
        if (existing) {
            logger.debug(`[ap-media] 素材已存在: ${md5} (from ${remoteUrl})`);
            setCachedHash(remoteUrl, md5);
            return md5;
        }

        // ── 4. 上传到 S3 ────────────────────────────────
        const s3Key = `assets/${md5.substring(0, 2)}/${md5.substring(2, 4)}/${md5}.${finalExtension}`;
        await uploadToS3(processedBuffer, s3Key, finalMimeType);

        // ── 5. 在 ow_assets 中建立记录 ──────────────────
        const filename = extractFilenameFromUrl(remoteUrl) || `${purpose}_${md5}.webp`;
        await createAssetRecord({
            md5,
            filename,
            extension: finalExtension,
            mimeType: finalMimeType,
            fileSize: processedBuffer.length,
            uploaderId: proxyUserId,
            uploaderIp,
            uploaderUa,
            metadata: {
                source,
                remoteUrl,
                actorUrl: actorUrl || null,
                purpose,
                imageProcessing: processingMeta,
                ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
            },
            tags,
            category: purpose === 'avatar' ? AVATAR_CATEGORY : BANNER_CATEGORY,
        });

        logger.info(`[ap-media] 已缓存远程${purpose === 'avatar' ? '头像' : '横幅'}: ${remoteUrl} -> ${md5}`);
        setCachedHash(remoteUrl, md5);
        return md5;

    } catch (err) {
        logger.error(`[ap-media] 缓存远程图片失败 (${remoteUrl}):`, err.message);
        return DEFAULT_HASH;
    }
}

/**
 * 批量缓存头像 + 横幅
 * @returns {{ avatar: string, banner: string }} 本地 MD5 哈希
 */
export async function cacheActorMedia(actor, proxyUserId = null) {
    const actorUrl = actor.id || actor.url;

    // 提取头像 URL
    let avatarUrl = null;
    if (actor.icon) {
        avatarUrl = typeof actor.icon === 'string' ? actor.icon : actor.icon?.url;
    }

    // 提取横幅 URL
    let bannerUrl = null;
    if (actor.image) {
        bannerUrl = typeof actor.image === 'string' ? actor.image : actor.image?.url;
    }

    // 并行缓存
    const [avatarHash, bannerHash] = await Promise.all([
        avatarUrl
            ? cacheRemoteImage(avatarUrl, { purpose: 'avatar', proxyUserId, actorUrl })
            : Promise.resolve(DEFAULT_HASH),
        bannerUrl
            ? cacheRemoteImage(bannerUrl, { purpose: 'banner', proxyUserId, actorUrl })
            : Promise.resolve(DEFAULT_HASH),
    ]);

    return { avatar: avatarHash, banner: bannerHash };
}

// ── 辅助函数 ────────────────────────────────────────────

/**
 * 下载远程图片（带超时 & 大小限制）
 */
async function downloadRemoteImage(url, { enforceFederationPolicy = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const safeGet = enforceFederationPolicy ? federationGet : publicNetworkGet;
        const resp = await safeGet(url, {
            signal: controller.signal,
            timeout: FETCH_TIMEOUT,
            responseType: 'stream',
            maxRedirects: 5,
            headers: {
                'Accept': 'image/*',
                'User-Agent': 'ZeroCat-AP-Federation/1.0',
            },
            validateStatus: () => true,
        });

        if (resp.status < 200 || resp.status >= 300) {
            resp.data?.destroy?.();
            logger.warn('[ap-media] 远程图片 HTTP 异常', {
                url,
                status: resp.status,
                statusText: resp.statusText,
                contentType: resp.headers?.['content-type'] || null,
                contentLength: resp.headers?.['content-length'] || null,
            });
            return null;
        }

        // 检查 Content-Length
        const contentLength = parseInt(resp.headers?.['content-length'] || '0', 10);
        if (contentLength > MAX_DOWNLOAD_SIZE) {
            resp.data?.destroy?.();
            logger.warn(`[ap-media] 远程图片过大 (${contentLength} bytes): ${url}`);
            return null;
        }

        // 流式读取（防止超大响应）
        const chunks = [];
        let totalSize = 0;
        for await (const value of resp.data) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            totalSize += chunk.length;
            if (totalSize > MAX_DOWNLOAD_SIZE) {
                resp.data.destroy();
                logger.warn(`[ap-media] 远程图片下载超限 (>${MAX_DOWNLOAD_SIZE}): ${url}`);
                return null;
            }
            chunks.push(chunk);
        }

        return Buffer.concat(chunks);
    } catch (err) {
        if (err.name === 'AbortError') {
            logger.warn('[ap-media] 远程图片下载超时', {
                url,
                timeoutMs: FETCH_TIMEOUT,
                errorName: err.name,
                errorMessage: err.message,
            });
        } else {
            logger.warn('[ap-media] 远程图片下载失败', {
                url,
                timeoutMs: FETCH_TIMEOUT,
                ...extractErrorDetails(err),
            });
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function extractErrorDetails(err) {
    const details = {
        errorName: err?.name || null,
        errorMessage: err?.message || null,
        errorCode: err?.code || null,
        errorType: err?.type || null,
        stack: err?.stack || null,
    };

    const cause = err?.cause;
    if (cause) {
        details.cause = {
            name: cause?.name || null,
            message: cause?.message || null,
            code: cause?.code || null,
            stack: cause?.stack || null,
        };
    }

    return details;
}

/**
 * 从 URL 中提取文件名
 */
function extractFilenameFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const parts = pathname.split('/');
        const last = parts[parts.length - 1];
        return last && last.length > 0 && last.length <= 200 ? last : null;
    } catch {
        return null;
    }
}
