/**
 * 统一令牌服务
 *
 * 替代旧的会话令牌(JWT) + 账户令牌(zc_) + OAuth 令牌的分散实现。
 * 所有令牌均为不透明随机串, 仅在数据库中存储 SHA-256 哈希, 并携带 scope 列表用于精细化鉴权。
 *
 * 令牌类型 (ow_tokens.type):
 *   - session  : 用户登录会话 (不保存权限快照，运行时使用当前用户角色策略，带刷新令牌)
 *   - personal : 用户自建的个人 API 令牌 (自定义 scope, 无刷新令牌)
 *   - oauth    : 第三方应用授权令牌 (用户授予的 scope 子集, 带刷新令牌)
 *   - editor   : 编辑器长效令牌 (项目实例级 scope, 无刷新令牌)
 */

import crypto from "crypto";
import logger from "../logger.js";
import { prisma } from "../prisma.js";
import redisClient from "../redis.js";
import zcconfig from "../config/zcconfig.js";
import { parseDeviceInfo } from "./tokenUtils.js";
import { normalizeScopes, validateUserGrantableScopes } from "./scopes.js";
import { getUserPolicy } from "./policyEngine.js";

const TOKEN_PREFIX = "zc_";
const CACHE_PREFIX = "token:cache:";
const REFRESH_GRACE_PREFIX = "refresh:grace:";
const REFRESH_GRACE_TTL_SEC = 30;
const TOKEN_CACHE_MAX_TTL = 5 * 60;
const RAW_TOKEN_RANDOM_HEX_LENGTH = 96;
const RAW_TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}[a-f0-9]{${RAW_TOKEN_RANDOM_HEX_LENGTH}}$`, "i");
const ACTIVITY_THROTTLE_PREFIX = "token:activity:update:";
const ACTIVITY_UPDATE_INTERVAL_SEC = 60;
const localActivityThrottle = new Map();

// 默认有效期 (秒)
const DEFAULT_SESSION_ACCESS_EXPIRY = 60 * 60 * 24 * 7; // 7 天
const DEFAULT_SESSION_REFRESH_EXPIRY = 60 * 60 * 24 * 90; // 90 天
const DEFAULT_OAUTH_ACCESS_EXPIRY = 60 * 60; // 1 小时
const DEFAULT_OAUTH_REFRESH_EXPIRY = 60 * 60 * 24 * 30; // 30 天
const DEFAULT_EDITOR_ACCESS_EXPIRY = 60 * 60 * 24 * 365; // 1 年
const MAX_EDITOR_ACCESS_EXPIRY = 60 * 60 * 24 * 365; // 1 年
const TOKEN_TYPES = new Set(["session", "personal", "oauth", "editor"]);

/**
 * 返回 token 在当前时刻实际参与 scope 匹配的权限。
 *
 * session token 是网页登录会话，不再把权限快照固化在 token 记录里；
 * 它总是使用用户当前角色策略中的 allow 权限。personal/oauth token
 * 仍使用自身记录的 scopes，再由 requireScope 叠加用户角色策略上限。
 *
 * @param {{userId:number|string,type:string,scopes?:string[]}} params
 * @returns {Promise<string[]>}
 */
export async function getEffectiveTokenScopes({ userId, type, scopes = [] }) {
    if (type !== "session") {
        return normalizeScopes(scopes);
    }

    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
        return [];
    }

    const policy = await getUserPolicy(normalizedUserId);
    return normalizeScopes(policy.allow || []);
}

/**
 * 生成不透明令牌明文
 * @returns {string} 形如 zc_<96 hex>
 */
function generateRawToken() {
    return TOKEN_PREFIX + crypto.randomBytes(48).toString("hex");
}

function normalizeRawToken(rawToken) {
    return typeof rawToken === "string" ? rawToken.trim() : "";
}

export function isValidRawTokenFormat(rawToken) {
    return RAW_TOKEN_PATTERN.test(normalizeRawToken(rawToken));
}

/**
 * 计算令牌哈希 (SHA-256 hex)
 * @param {string} rawToken
 * @returns {string}
 */
export function hashToken(rawToken) {
    return crypto.createHash("sha256").update(normalizeRawToken(rawToken)).digest("hex");
}

/**
 * 令牌展示用前缀 (前 12 个字符)
 */
function tokenDisplayPrefix(rawToken) {
    return rawToken.substring(0, 12);
}

function normalizeIpAddress(value) {
    const normalized = String(value || "").trim();
    return normalized ? normalized.substring(0, 100) : null;
}

function tokenCacheKey(hash) {
    return CACHE_PREFIX + hash;
}

function refreshGraceKey(hash) {
    return REFRESH_GRACE_PREFIX + hash;
}

export function tokenCacheKeysForRecords(records) {
    return [...new Set(records.flatMap((record) => [
        record.token_hash ? tokenCacheKey(record.token_hash) : null,
        record.refresh_token_hash ? refreshGraceKey(record.refresh_token_hash) : null,
    ]).filter(Boolean))];
}

/** Call only after the transaction that revoked/deleted these tokens commits. */
export async function invalidateTokenCaches(keys) {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    if (uniqueKeys.length === 0) return { success: true };
    try {
        if (await redisClient.deleteMany(uniqueKeys) !== true) {
            throw new Error("Redis cache deletion returned false");
        }
        return { success: true };
    } catch (error) {
        logger.warn(`[token] 令牌缓存清理失败（数据库状态仍为鉴权依据）: ${error.message}`);
        return { success: false };
    }
}

async function findCurrentRefreshPair(tokenId, accessToken, refreshToken) {
    if (
        !Number.isInteger(tokenId) || tokenId <= 0
        || !isValidRawTokenFormat(accessToken)
        || !isValidRawTokenFormat(refreshToken)
    ) return null;
    const record = await prisma.ow_tokens.findUnique({
        where: { id: tokenId },
        select: {
            id: true, type: true, token_hash: true, refresh_token_hash: true,
            revoked: true, expires_at: true, refresh_expires_at: true, scopes: true,
            user: { select: { id: true, status: true } },
        },
    });
    const now = Date.now();
    if (
        !record || record.revoked
        || !["session", "oauth"].includes(record.type)
        || record.token_hash !== hashToken(accessToken)
        || record.refresh_token_hash !== hashToken(refreshToken)
        || record.user?.status !== "active"
        || (record.expires_at && record.expires_at.getTime() <= now)
        || (record.refresh_expires_at && record.refresh_expires_at.getTime() <= now)
    ) return null;
    return record;
}

async function getSessionAccessExpiry() {
    try {
        const v = parseInt(await zcconfig.get("security.accessTokenExpiry"), 10);
        if (!isNaN(v) && v > 0) return v;
    } catch (_) { /* ignore */ }
    return DEFAULT_SESSION_ACCESS_EXPIRY;
}

async function getSessionRefreshExpiry() {
    try {
        const v = parseInt(await zcconfig.get("security.refreshTokenExpiry"), 10);
        if (!isNaN(v) && v > 0) return v;
    } catch (_) { /* ignore */ }
    return DEFAULT_SESSION_REFRESH_EXPIRY;
}

/**
 * 签发令牌
 * @param {object} params
 * @param {number} params.userId 用户ID
 * @param {"session"|"personal"|"oauth"|"editor"} params.type 令牌类型
 * @param {string[]} params.scopes 授予的 scope 列表
 * @param {string} [params.name] 令牌名称 (personal/oauth)
 * @param {number} [params.applicationId] OAuth 应用ID
 * @param {number} [params.authorizationId] OAuth 授权记录ID
 * @param {number|null} [params.accessTokenExpiry] 访问令牌有效期(秒), null=永不过期(personal)
 * @param {number} [params.refreshTokenExpiry] 刷新令牌有效期(秒)
 * @param {boolean} [params.withRefreshToken] 是否签发刷新令牌
 * @param {string} [params.ip] 客户端IP
 * @param {string} [params.userAgent] UA
 * @param {boolean} [params.recordLoginEvent] 是否记录登录事件
 * @returns {Promise<object>} { success, accessToken, refreshToken?, expiresAt?, refreshExpiresAt?, tokenId, scopes }
 */
export async function issueToken(params) {
    const {
        userId,
        type = "session",
        scopes = ["*"],
        name = null,
        applicationId = null,
        authorizationId = null,
        ip = null,
        userAgent = null,
        recordLoginEvent = false,
    } = params;

    try {
        if (!TOKEN_TYPES.has(type)) {
            return { success: false, message: "不支持的令牌类型" };
        }

        // 解析有效期
        let accessTokenExpiry = params.accessTokenExpiry;
        let refreshTokenExpiry = params.refreshTokenExpiry;
        let withRefreshToken = params.withRefreshToken;

        if (type === "session") {
            if (accessTokenExpiry === undefined) accessTokenExpiry = await getSessionAccessExpiry();
            if (refreshTokenExpiry === undefined) refreshTokenExpiry = await getSessionRefreshExpiry();
            if (withRefreshToken === undefined) withRefreshToken = true;
        } else if (type === "oauth") {
            if (accessTokenExpiry === undefined) accessTokenExpiry = DEFAULT_OAUTH_ACCESS_EXPIRY;
            if (refreshTokenExpiry === undefined) refreshTokenExpiry = DEFAULT_OAUTH_REFRESH_EXPIRY;
            if (withRefreshToken === undefined) withRefreshToken = true;
        } else if (type === "editor") {
            if (accessTokenExpiry === undefined) accessTokenExpiry = DEFAULT_EDITOR_ACCESS_EXPIRY;
            const editorExpiry = Number(accessTokenExpiry);
            if (
                !Number.isInteger(editorExpiry)
                || editorExpiry <= 0
                || editorExpiry > MAX_EDITOR_ACCESS_EXPIRY
            ) {
                return {
                    success: false,
                    message: `编辑器令牌有效期必须在 1 到 ${MAX_EDITOR_ACCESS_EXPIRY} 秒之间`,
                };
            }
            accessTokenExpiry = editorExpiry;
            withRefreshToken = false;
            refreshTokenExpiry = null;
        } else {
            // personal: 默认永不过期, 无刷新令牌
            if (accessTokenExpiry === undefined) accessTokenExpiry = null;
            withRefreshToken = false;
        }

        const normalizedScopes = type === "session" ? [] : normalizeScopes(scopes);
        if (type !== "session") {
            const grantCheck = await validateUserGrantableScopes(userId, normalizedScopes);
            if (!grantCheck.allowed) {
                return {
                    success: false,
                    message: "请求的权限范围超过用户本身权限",
                    code: "ZC_ERROR_SCOPE_ESCALATION",
                    deniedScopes: grantCheck.denied,
                };
            }
        }

        const now = Date.now();
        const rawAccess = generateRawToken();
        const accessHash = hashToken(rawAccess);
        const accessExpiresAt = accessTokenExpiry ? new Date(now + accessTokenExpiry * 1000) : null;

        let rawRefresh = null;
        let refreshHash = null;
        let refreshExpiresAt = null;
        if (withRefreshToken) {
            rawRefresh = generateRawToken();
            refreshHash = hashToken(rawRefresh);
            refreshExpiresAt = new Date(now + (refreshTokenExpiry || DEFAULT_SESSION_REFRESH_EXPIRY) * 1000);
        }

        const deviceInfo = userAgent ? parseDeviceInfo(userAgent) : null;
        const normalizedIp = normalizeIpAddress(ip);

        const record = await prisma.ow_tokens.create({
            data: {
                user_id: userId,
                type,
                name,
                token_hash: accessHash,
                token_prefix: tokenDisplayPrefix(rawAccess),
                refresh_token_hash: refreshHash,
                scopes: normalizedScopes,
                application_id: applicationId,
                authorization_id: authorizationId,
                expires_at: accessExpiresAt,
                refresh_expires_at: refreshExpiresAt,
                ip_address: normalizedIp,
                user_agent: userAgent?.substring(0, 255) || null,
                device_info: deviceInfo ? JSON.stringify(deviceInfo) : null,
                last_used_at: new Date(now),
                last_used_ip: normalizedIp,
                activity_count: 0,
            },
        });

        if (recordLoginEvent) {
            try {
                const { createEvent } = await import("../../controllers/events.js");
                await createEvent("user_login", userId, "user", userId, {
                    event_type: "user_login",
                    device_info: deviceInfo,
                    ip_address: ip,
                });
            } catch (eventError) {
                logger.error(`记录登录事件失败: ${eventError.message}`);
            }
        }

        const responseScopes = type === "session"
            ? await getEffectiveTokenScopes({ userId, type, scopes: normalizedScopes })
            : normalizedScopes;

        return {
            success: true,
            accessToken: rawAccess,
            refreshToken: rawRefresh,
            expiresAt: accessExpiresAt,
            refreshExpiresAt,
            tokenId: record.id,
            scopes: responseScopes,
            type,
        };
    } catch (error) {
        logger.error(`签发令牌失败: ${error.message}`);
        logger.error(error.stack);
        return { success: false, message: "签发令牌失败", error: error.message };
    }
}

/**
 * 验证令牌
 * @param {string} rawToken 令牌明文
 * @param {string} [ipAddress] 客户端IP
 * @returns {Promise<{valid:boolean, user?:object, scopes?:string[], tokenType?:string, tokenId?:number, applicationId?:number, message?:string}>}
 */
export async function verifyToken(rawToken, ipAddress = null) {
    try {
        const normalizedToken = normalizeRawToken(rawToken);
        if (!isValidRawTokenFormat(normalizedToken)) {
            return { valid: false, message: "无效的令牌格式" };
        }

        const hash = hashToken(normalizedToken);
        const cacheKey = tokenCacheKey(hash);
        const normalizedIp = normalizeIpAddress(ipAddress);

        // 缓存只保存展示信息，令牌/账户是否有效始终以当前数据库记录为准。
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            const current = Number.isInteger(cached.tokenId) && cached.tokenId > 0
                ? await prisma.ow_tokens.findUnique({
                    where: { id: cached.tokenId },
                    select: {
                        token_hash: true, revoked: true, expires_at: true, type: true,
                        user: { select: { id: true, status: true } },
                    },
                })
                : null;
            if (
                !current || current.revoked || current.token_hash !== hash
                || current.type !== cached.type
                || current.user?.status !== "active"
                || current.user.id !== cached.user?.userid
                || (current.expires_at && current.expires_at.getTime() <= Date.now())
            ) {
                await invalidateTokenCaches([cacheKey]);
                return { valid: false, message: "令牌已失效或用户账户状态异常" };
            }
            updateTokenActivity(cached.tokenId, normalizedIp).catch((e) =>
                logger.error(`更新令牌活动失败: ${e.message}`)
            );
            const scopes = await getEffectiveTokenScopes({
                userId: current.user.id,
                type: current.type,
                scopes: cached.scopes,
            });
            return {
                valid: true,
                user: cached.user,
                scopes,
                tokenType: current.type,
                tokenId: cached.tokenId,
                applicationId: cached.applicationId || null,
            };
        }

        // 2. 回落数据库
        const record = await prisma.ow_tokens.findUnique({
            where: { token_hash: hash },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        email: true,
                        status: true,
                    },
                },
            },
        });

        if (!record || record.revoked) {
            return { valid: false, message: "令牌不存在或已被吊销" };
        }

        // 过期检查
        if (record.expires_at && record.expires_at < new Date()) {
            return { valid: false, message: "令牌已过期" };
        }

        // 用户状态检查
        if (!record.user || record.user.status !== "active") {
            return { valid: false, message: "用户账户状态异常" };
        }

        const user = {
            userid: record.user.id,
            username: record.user.username,
            display_name: record.user.display_name,
            email: record.user.email,
            token_id: record.id,
        };
        const storedScopes = normalizeScopes(record.scopes);
        const scopes = await getEffectiveTokenScopes({
            userId: record.user.id,
            type: record.type,
            scopes: storedScopes,
        });

        // 写入缓存 (TTL = 剩余有效期, 上限 5 分钟)
        const remainingMs = record.expires_at
            ? record.expires_at.getTime() - Date.now()
            : TOKEN_CACHE_MAX_TTL * 1000;
        const ttl = Math.min(TOKEN_CACHE_MAX_TTL, Math.max(1, Math.floor(remainingMs / 1000)));
        await redisClient.set(
            cacheKey,
            {
                tokenId: record.id,
                user,
                scopes: storedScopes,
                type: record.type,
                applicationId: record.application_id || null,
                expires_at: record.expires_at ? record.expires_at.getTime() : null,
            },
            ttl
        );

        updateTokenActivity(record.id, normalizedIp).catch((e) =>
            logger.error(`更新令牌活动失败: ${e.message}`)
        );

        return {
            valid: true,
            user,
            scopes,
            tokenType: record.type,
            tokenId: record.id,
            applicationId: record.application_id || null,
        };
    } catch (error) {
        logger.error(`验证令牌时出错: ${error.message}`);
        return { valid: false, message: "验证令牌时发生错误" };
    }
}

/**
 * 使用 HttpOnly refresh token 识别浏览器登录会话。
 * 不轮换 refresh token，也不会向调用方返回完整会话 access token。
 */
export async function getSessionFromRefreshToken(rawRefreshToken, ipAddress = null) {
    try {
        const normalizedRefreshToken = normalizeRawToken(rawRefreshToken);
        if (!isValidRawTokenFormat(normalizedRefreshToken)) {
            return null;
        }

        const record = await prisma.ow_tokens.findUnique({
            where: { refresh_token_hash: hashToken(normalizedRefreshToken) },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        status: true,
                    },
                },
            },
        });

        if (
            !record
            || record.type !== "session"
            || record.revoked
            || (record.refresh_expires_at && record.refresh_expires_at < new Date())
            || !record.user
            || record.user.status !== "active"
        ) {
            return null;
        }

        updateTokenActivity(record.id, normalizeIpAddress(ipAddress)).catch((error) =>
            logger.warn(`[token] 更新编辑器会话来源活动失败: ${error.message}`)
        );

        return {
            tokenId: record.id,
            userId: record.user.id,
            user: {
                id: record.user.id,
                username: record.user.username,
                display_name: record.user.display_name,
            },
        };
    } catch (error) {
        logger.error(`读取浏览器登录会话失败: ${error.message}`);
        return null;
    }
}

/**
 * 异步更新令牌活动记录
 */
async function shouldWriteTokenActivity(tokenId) {
    const key = ACTIVITY_THROTTLE_PREFIX + tokenId;
    if (redisClient.isConnected) {
        return redisClient.setIfNotExists(key, "1", ACTIVITY_UPDATE_INTERVAL_SEC);
    }

    const now = Date.now();
    const nextAllowedAt = localActivityThrottle.get(tokenId) || 0;
    if (nextAllowedAt > now) {
        return false;
    }

    localActivityThrottle.set(tokenId, now + ACTIVITY_UPDATE_INTERVAL_SEC * 1000);
    if (localActivityThrottle.size > 10_000) {
        for (const [cachedTokenId, expiresAt] of localActivityThrottle.entries()) {
            if (expiresAt <= now) {
                localActivityThrottle.delete(cachedTokenId);
            }
        }
    }
    return true;
}

export async function updateTokenActivity(tokenId, ipAddress, { force = false } = {}) {
    try {
        const normalizedTokenId = Number(tokenId);
        if (!Number.isInteger(normalizedTokenId) || normalizedTokenId <= 0) {
            return false;
        }

        if (!force && !(await shouldWriteTokenActivity(normalizedTokenId))) {
            return true;
        }

        const data = {
            last_used_at: new Date(),
            activity_count: { increment: 1 },
        };
        const normalizedIp = normalizeIpAddress(ipAddress);
        if (normalizedIp) {
            data.last_used_ip = normalizedIp;
        }

        await prisma.ow_tokens.update({
            where: { id: normalizedTokenId },
            data,
        });
        return true;
    } catch (error) {
        logger.error(`更新令牌活动记录出错: ${error.message}`);
        return false;
    }
}

function serializeGracePayload(payload) {
    return {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: payload.expiresAt instanceof Date
            ? payload.expiresAt.toISOString()
            : payload.expiresAt,
        refreshExpiresAt: payload.refreshExpiresAt instanceof Date
            ? payload.refreshExpiresAt.toISOString()
            : payload.refreshExpiresAt,
        tokenId: payload.tokenId,
        scopes: payload.scopes,
    };
}

async function readGraceRefreshResult(refreshHash) {
    try {
        const cached = await redisClient.get(refreshGraceKey(refreshHash));
        if (!cached?.accessToken || !cached.refreshToken) return null;
        const current = await findCurrentRefreshPair(cached.tokenId, cached.accessToken, cached.refreshToken);
        if (!current) {
            await invalidateTokenCaches([refreshGraceKey(refreshHash)]);
            return null;
        }
        const scopes = await getEffectiveTokenScopes({
            userId: current.user.id, type: current.type, scopes: current.scopes,
        });
        // 获取策略期间可能有吊销/封禁或下一次轮换，返回前再核对当前令牌对。
        if (!await findCurrentRefreshPair(cached.tokenId, cached.accessToken, cached.refreshToken)) return null;
        return {
            success: true,
            accessToken: cached.accessToken,
            refreshToken: cached.refreshToken,
            expiresAt: current.expires_at,
            refreshExpiresAt: current.refresh_expires_at,
            tokenId: current.id,
            scopes,
            fromGrace: true,
        };
    } catch {
        return null;
    }
}

async function storeGraceRefreshResult(refreshHash, payload) {
    if (!refreshHash) return;
    try {
        const stored = await redisClient.set(
            refreshGraceKey(refreshHash),
            serializeGracePayload(payload),
            REFRESH_GRACE_TTL_SEC
        );
        if (!stored) logger.warn("[token] 写入刷新宽限期缓存失败");
    } catch (error) {
        logger.warn(`[token] 写入刷新宽限期缓存失败: ${error.message}`);
    }
}

/**
 * 使用刷新令牌换取新的访问令牌 (会话 / OAuth)
 * 轮换访问令牌与刷新令牌；旧刷新令牌在宽限期内仍可换取同一组最新令牌（并发/多标签页安全）。
 * @param {string} rawRefreshToken 刷新令牌明文
 * @param {string} [ipAddress]
 * @param {string} [userAgent]
 * @returns {Promise<object>}
 */
export async function refreshAccessToken(rawRefreshToken, ipAddress = null, userAgent = null) {
    try {
        const normalizedRefreshToken = normalizeRawToken(rawRefreshToken);
        if (!isValidRawTokenFormat(normalizedRefreshToken)) {
            return { success: false, message: "无效的刷新令牌" };
        }
        const refreshHash = hashToken(normalizedRefreshToken);
        const normalizedIp = normalizeIpAddress(ipAddress);

        const graceResult = await readGraceRefreshResult(refreshHash);
        if (graceResult) {
            return graceResult;
        }

        const record = await prisma.ow_tokens.findUnique({
            where: { refresh_token_hash: refreshHash },
            include: {
                user: {
                    select: { id: true, status: true },
                },
            },
        });

        if (!record || record.revoked || !["session", "oauth"].includes(record.type)) {
            return { success: false, message: "无效的刷新令牌" };
        }
        if (!record.user || record.user.status !== "active") {
            return { success: false, message: "用户账户状态异常" };
        }
        if (record.refresh_expires_at && record.refresh_expires_at < new Date()) {
            return { success: false, message: "刷新令牌已过期" };
        }

        const previousAccessHash = record.token_hash;
        const previousRefreshHash = refreshHash;

        const accessTokenExpiry =
            record.type === "oauth" ? DEFAULT_OAUTH_ACCESS_EXPIRY : await getSessionAccessExpiry();
        const refreshTokenExpiry =
            record.type === "oauth" ? DEFAULT_OAUTH_REFRESH_EXPIRY : await getSessionRefreshExpiry();
        const now = Date.now();
        const rawAccess = generateRawToken();
        const rawRefresh = generateRawToken();
        const accessHash = hashToken(rawAccess);
        const newRefreshHash = hashToken(rawRefresh);
        const accessExpiresAt = new Date(now + accessTokenExpiry * 1000);
        // 滚动刷新令牌过期时间：每次刷新都延长，保持用户活跃时不过期
        const refreshExpiresAt = new Date(now + refreshTokenExpiry * 1000);

        const updateResult = await prisma.ow_tokens.updateMany({
            where: {
                id: record.id,
                refresh_token_hash: previousRefreshHash,
                token_hash: previousAccessHash,
                revoked: false,
                type: record.type,
                user: { is: { status: "active" } },
                OR: [{ refresh_expires_at: null }, { refresh_expires_at: { gt: new Date() } }],
            },
            data: {
                token_hash: accessHash,
                token_prefix: tokenDisplayPrefix(rawAccess),
                refresh_token_hash: newRefreshHash,
                expires_at: accessExpiresAt,
                refresh_expires_at: refreshExpiresAt,
                last_used_at: new Date(now),
                last_used_ip: normalizedIp,
                user_agent: userAgent?.substring(0, 255) || record.user_agent,
                device_info: userAgent ? JSON.stringify(parseDeviceInfo(userAgent)) : record.device_info,
                activity_count: { increment: 1 },
            },
        });

        if (updateResult.count !== 1) {
            const retryGraceResult = await readGraceRefreshResult(previousRefreshHash);
            if (retryGraceResult) {
                return retryGraceResult;
            }
            return { success: false, message: "刷新令牌已被轮换，请重试登录" };
        }

        const result = {
            success: true,
            accessToken: rawAccess,
            refreshToken: rawRefresh,
            expiresAt: accessExpiresAt,
            refreshExpiresAt: refreshExpiresAt,
            tokenId: record.id,
            scopes: await getEffectiveTokenScopes({
                userId: record.user.id,
                type: record.type,
                scopes: record.scopes,
            }),
        };

        // 数据库轮换成功后再清理缓存；Redis 故障不能撤销已提交的轮换。
        await invalidateTokenCaches([tokenCacheKey(previousAccessHash)]);
        // 旧刷新令牌宽限期：并发请求仍可拿到同一组最新令牌
        await storeGraceRefreshResult(previousRefreshHash, result);
        // 吊销可能发生在轮换或策略查询之后，不能把已被踢出的令牌作为成功返回。
        if (!await findCurrentRefreshPair(record.id, rawAccess, rawRefresh)) {
            return { success: false, message: "令牌已失效或用户账户状态异常" };
        }

        return result;
    } catch (error) {
        logger.error(`刷新令牌时出错: ${error.message}`);
        return { success: false, message: "刷新令牌时出错" };
    }
}

/**
 * 吊销单个令牌
 * @param {number} tokenId
 * @returns {Promise<object>}
 */
export async function revokeToken(tokenId, options = {}) {
    try {
        const db = options.db ?? prisma;
        const record = await db.ow_tokens.findUnique({ where: { id: tokenId } });
        if (!record) return { success: false, message: "令牌不存在" };
        const result = await revokeTokensWhere({ id: tokenId }, options);
        if (!result.success) return result;
        return { ...result, message: record.revoked ? "令牌已被吊销" : "令牌已吊销" };
    } catch (error) {
        logger.error(`吊销令牌出错: ${error.message}`);
        return { success: false, message: "吊销令牌时出错" };
    }
}

/**
 * 通过刷新令牌吊销其对应会话。用于 access token 已过期但浏览器仍有 HttpOnly refresh cookie 的登出场景。
 * @param {string} rawRefreshToken
 * @returns {Promise<object>}
 */
export async function revokeTokenByRefreshToken(rawRefreshToken, options = {}) {
    try {
        const normalizedRefreshToken = normalizeRawToken(rawRefreshToken);
        if (!isValidRawTokenFormat(normalizedRefreshToken)) {
            return { success: false, message: "无效的刷新令牌" };
        }

        const refreshHash = hashToken(normalizedRefreshToken);
        const db = options.db ?? prisma;
        const record = await db.ow_tokens.findUnique({
            where: { refresh_token_hash: refreshHash },
            select: { id: true },
        });
        if (!record) return { success: false, message: "刷新令牌不存在" };
        return revokeToken(record.id, options);
    } catch (error) {
        logger.error(`通过刷新令牌吊销会话出错: ${error.message}`);
        return { success: false, message: "吊销令牌时出错" };
    }
}

/**
 * 吊销某用户的全部令牌 (可排除当前令牌)
 * @param {number} userId
 * @param {number|null} [excludeTokenId]
 * @returns {Promise<object>}
 */
export async function revokeAllUserTokens(userId, excludeTokenId = null, options = {}) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
        return { success: false, message: "无效的用户ID" };
    }
    return revokeTokensWhere({
        user_id: normalizedUserId,
        ...(excludeTokenId ? { id: { not: excludeTokenId } } : {}),
    }, options);
}

/**
 * 按条件吊销一批令牌并清理缓存。调用方必须传入收窄后的 where 条件。
 * @param {object} where Prisma ow_tokens where 条件
 * @param {{db?:object,invalidateCache?:boolean}} [options] 事务客户端默认不清缓存，提交后调用 invalidateTokenCaches(cacheKeys)
 * @returns {Promise<object>} DB 成功后 success 始终为 true；cacheInvalidated/warning 单独报告缓存故障
 */
export async function revokeTokensWhere(where, { db = prisma, invalidateCache = db === prisma } = {}) {
    try {
        if (!where || typeof where !== "object" || Array.isArray(where) || Object.keys(where).length === 0) {
            return { success: false, message: "缺少吊销条件" };
        }

        const narrowedWhere = { AND: [where, { revoked: false }] };
        const tokens = await db.ow_tokens.updateManyAndReturn({
            where: narrowedWhere,
            data: { revoked: true, revoked_at: new Date() },
            select: { token_hash: true, refresh_token_hash: true },
        });

        // DB-first：任何旧缓存命中仍会检查当前行，Redis 故障不能复活已吊销令牌。
        const cacheKeys = tokenCacheKeysForRecords(tokens);
        const cacheResult = invalidateCache ? await invalidateTokenCaches(cacheKeys) : null;
        return {
            success: true,
            count: tokens.length,
            cacheKeys,
            cacheInvalidated: cacheResult?.success ?? false,
            ...(cacheResult && !cacheResult.success ? { warning: "令牌已吊销，但缓存清理失败" } : {}),
        };
    } catch (error) {
        logger.error(`批量吊销令牌出错: ${error.message}`);
        return { success: false, message: "批量吊销令牌失败" };
    }
}

/**
 * 列出用户的令牌 (不含敏感哈希)
 * @param {number} userId
 * @param {object} [filter] 如 { type: "personal" }
 * @returns {Promise<Array>}
 */
export async function listUserTokens(userId, filter = {}) {
    const tokens = await prisma.ow_tokens.findMany({
        where: { user_id: userId, ...filter },
        select: {
            id: true,
            type: true,
            name: true,
            token_prefix: true,
            scopes: true,
            application_id: true,
            expires_at: true,
            last_used_at: true,
            last_used_ip: true,
            activity_count: true,
            revoked: true,
            revoked_at: true,
            created_at: true,
            updated_at: true,
        },
        orderBy: { created_at: "desc" },
    });
    return tokens.map((token) => ({
        ...token,
        scopes: normalizeScopes(token.scopes),
    }));
}

/**
 * 内省令牌: 根据明文令牌返回其归属与元数据 (不含哈希/明文)。
 * 用于调试工具。返回 null 表示不存在。
 * @param {string} rawToken 令牌明文
 * @returns {Promise<object|null>}
 */
export async function introspectToken(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return null;
    const record = await prisma.ow_tokens.findFirst({
        where: { token_hash: hashToken(rawToken) },
        include: {
            user: {
                select: { id: true, username: true, display_name: true, status: true },
            },
            application: {
                select: { id: true, name: true, client_id: true },
            },
        },
    });
    if (!record) return null;

    const now = Date.now();
    const expired = record.expires_at ? record.expires_at.getTime() < now : false;
    const active = !record.revoked && !expired && record.user?.status === "active";
    const storedScopes = normalizeScopes(record.scopes);
    const effectiveScopes = await getEffectiveTokenScopes({
        userId: record.user_id,
        type: record.type,
        scopes: storedScopes,
    });

    return {
        active,
        revoked: record.revoked,
        expired,
        token_id: record.id,
        type: record.type,
        name: record.name,
        token_prefix: record.token_prefix,
        scopes: effectiveScopes,
        effective_scopes: effectiveScopes,
        stored_scopes: storedScopes,
        scope_source: record.type === "session" ? "current_user_policy" : "token_record",
        user_id: record.user_id,
        user: record.user
            ? {
                  id: record.user.id,
                  username: record.user.username,
                  display_name: record.user.display_name,
                  status: record.user.status,
              }
            : null,
        application: record.application || null,
        expires_at: record.expires_at,
        last_used_at: record.last_used_at,
        last_used_ip: record.last_used_ip,
        ip_address: record.ip_address,
        device_info: record.device_info,
        activity_count: record.activity_count,
        created_at: record.created_at,
    };
}

export default {
    issueToken,
    verifyToken,
    refreshAccessToken,
    revokeToken,
    revokeTokenByRefreshToken,
    revokeTokensWhere,
    invalidateTokenCaches,
    tokenCacheKeysForRecords,
    revokeAllUserTokens,
    listUserTokens,
    introspectToken,
    getEffectiveTokenScopes,
    getSessionFromRefreshToken,
    updateTokenActivity,
    isValidRawTokenFormat,
    hashToken,
};
