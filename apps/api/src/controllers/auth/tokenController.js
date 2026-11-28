import logger from "../../services/logger.js";
import authUtils from "../../services/auth/auth.js";
import {prisma} from "../../services/prisma.js";
import ipLocation from "../../services/ip/ipLocation.js";
import zcconfig from "../../services/config/zcconfig.js";
import {
    extractRefreshTokenFromRequest,
    respondWithBrowserAuthTokens,
    toIsoOrValue,
} from "../../services/auth/tokenUtils.js";
import {
    getSessionFromRefreshToken,
    issueToken,
} from "../../services/auth/tokenService.js";
import {
    tokenContextCanGrantScopes,
    userCanAccessResourceScope,
} from "../../services/auth/scopes.js";

const EDITOR_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

async function getSessionFromRefreshTokenCandidates(refreshTokens, ipAddress) {
    const candidates = Array.isArray(refreshTokens) && refreshTokens.length > 0
        ? refreshTokens
        : [];
    for (const refreshToken of candidates) {
        const session = await getSessionFromRefreshToken(refreshToken, ipAddress);
        if (session) {
            return { session, refreshToken };
        }
    }
    return { session: null, refreshToken: null };
}

async function issueEditorTokenForUser({
    userId,
    user = null,
    projectId,
    tokenType,
    tokenScopes = [],
    req,
    res,
}) {
    const readScope = `project:${projectId}:read`;
    const updateScope = `project:${projectId}:update`;
    const manageScope = `project:${projectId}:manage`;
    const [canRead, canUpdate, canManage] = await Promise.all([
        userCanAccessResourceScope(userId, readScope),
        userCanAccessResourceScope(userId, updateScope),
        userCanAccessResourceScope(userId, manageScope),
    ]);

    if (!canRead) {
        return {
            statusCode: 404,
            payload: {
                status: "error",
                message: "项目不存在或无权访问",
                code: "ZC_ERROR_PROJECT_NOT_ACCESSIBLE",
            },
        };
    }

    const scopes = ["user:read", readScope];
    if (canUpdate) {
        scopes.push(updateScope, `project:${projectId}:interact`);
    }
    if (canManage) {
        scopes.push(manageScope);
    }

    if (!tokenContextCanGrantScopes(tokenType, tokenScopes, scopes)) {
        return {
            statusCode: 403,
            payload: {
                status: "error",
                message: "当前令牌无权授予编辑器所需的权限",
                code: "ZC_ERROR_SCOPE_ESCALATION",
            },
        };
    }

    const issued = await issueToken({
        userId,
        type: "editor",
        name: `scratch-editor:${projectId}`,
        scopes,
        accessTokenExpiry: EDITOR_TOKEN_TTL_SECONDS,
        ip: req.ipInfo?.clientIP || req.ip,
        userAgent: req.headers["user-agent"],
    });
    if (!issued.success) {
        logger.error(`[token] 签发编辑器令牌失败: ${issued.message || "unknown"}`);
        return {
            statusCode: issued.code === "ZC_ERROR_SCOPE_ESCALATION" ? 403 : 500,
            payload: {
                status: "error",
                message: issued.message || "签发编辑器令牌失败",
                code: issued.code || "EDITOR_TOKEN_ISSUE_FAILED",
            },
        };
    }

    return {
        statusCode: 200,
        payload: {
            status: "success",
            token: issued.accessToken,
            expires_at: toIsoOrValue(issued.expiresAt),
            project_id: projectId,
            user: user || { id: userId },
            access: {
                can_read: canRead,
                can_edit: canUpdate,
                can_manage: canManage,
            },
        },
    };
}

/**
 * 验证 Origin/Referer 是否在允许的来源列表中（CSRF 防护）
 * @param {object} req Express request 对象
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
export async function validateOriginForCSRF(req) {
    let origin = req.headers['origin'];

    // 如果没有 Origin，尝试从 Referer 提取
    if (!origin) {
        const referer = req.headers['referer'];
        if (referer) {
            try {
                const refererUrl = new URL(referer);
                origin = refererUrl.origin;
            } catch {
                // 无效的 Referer
            }
        }
    }

    // Cookie 场景下必须有 Origin 或 Referer
    if (!origin) {
        return { valid: false, message: '缺少 Origin 或 Referer 头' };
    }

    try {
        const originHostname = new URL(origin).hostname.toLowerCase();

        // 检查 CORS 白名单
        const corslist = await zcconfig.get("cors");
        if (Array.isArray(corslist)) {
            const corsHosts = corslist
                .filter((item) => item !== "*")
                .map((item) => {
                    const value = String(item || "").trim().toLowerCase();
                    if (!value) return "";
                    try {
                        return new URL(value).hostname.toLowerCase();
                    } catch {
                        try {
                            return new URL(`http://${value}`).hostname.toLowerCase();
                        } catch {
                            return value;
                        }
                    }
                })
                .filter(Boolean);
            if (corsHosts.includes(originHostname)) {
                return { valid: true };
            }
        }

        // 检查 urls.frontend
        const frontendUrl = await zcconfig.get("urls.frontend");
        if (frontendUrl) {
            const frontendHostname = new URL(frontendUrl).hostname.toLowerCase();
            if (
                originHostname === frontendHostname ||
                originHostname.endsWith(`.${frontendHostname}`)
            ) {
                return { valid: true };
            }
        }
    } catch {
        // URL 解析失败
    }

    return { valid: false, message: '来源不在允许列表中' };
}

/**
 * 从浏览器 HttpOnly refresh cookie 换取项目限定的编辑器 token。
 * 编辑器页面永远不会读取、持久化或接收完整 session token。
 */
export const issueEditorSession = async (req, res) => {
    try {
        const projectId = Number(req.body?.project_id);
        if (!Number.isInteger(projectId) || projectId <= 0) {
            return res.status(400).json({
                status: "error",
                message: "无效的项目 ID",
                code: "INVALID_PROJECT_ID",
            });
        }

        const {
            fromCookie,
            refresh_token: refreshToken,
            refresh_tokens: refreshTokens,
        } = extractRefreshTokenFromRequest(req);
        if (!fromCookie || !refreshToken) {
            return res.status(401).json({
                status: "error",
                message: "需要浏览器登录会话",
                code: "ZC_ERROR_EDITOR_SESSION_REQUIRED",
            });
        }

        const csrfCheck = await validateOriginForCSRF(req);
        if (!csrfCheck.valid) {
            return res.status(403).json({
                status: "error",
                message: csrfCheck.message || "CSRF 验证失败",
                code: "ZC_ERROR_CSRF_FORBIDDEN",
            });
        }

        const { session } = await getSessionFromRefreshTokenCandidates(
            refreshTokens || [refreshToken],
            req.ipInfo?.clientIP || req.ip
        );
        if (!session) {
            return res.status(401).json({
                status: "error",
                message: "登录会话已失效",
                code: "ZC_ERROR_NEED_LOGIN",
            });
        }

        const result = await issueEditorTokenForUser({
            userId: session.userId,
            user: session.user,
            projectId,
            tokenType: "session",
            tokenScopes: [],
            req,
            res,
        });
        res.set("Cache-Control", "no-store");
        return res.status(result.statusCode).json(result.payload);
    } catch (error) {
        logger.error(`签发编辑器会话时出错: ${error.message}`);
        return res.status(500).json({
            status: "error",
            message: "签发编辑器会话失败",
            code: "EDITOR_SESSION_ISSUE_FAILED",
        });
    }
};

/**
 * 使用当前 access token 签发 Scratch 编辑器项目限定长效 token。
 * 不依赖 refresh cookie，供主站打开编辑器前直接传给沙盒编辑器页面。
 */
export const issueEditorToken = async (req, res) => {
    try {
        const projectId = Number(req.body?.project_id || req.query?.project_id || req.query?.projectid);
        if (!Number.isInteger(projectId) || projectId <= 0) {
            return res.status(400).json({
                status: "error",
                message: "无效的项目 ID",
                code: "INVALID_PROJECT_ID",
            });
        }

        if (!res.locals.userid) {
            return res.status(401).json({
                status: "error",
                message: "需要登录",
                code: "ZC_ERROR_NEED_LOGIN",
            });
        }

        const result = await issueEditorTokenForUser({
            userId: res.locals.userid,
            user: {
                id: res.locals.userid,
                username: res.locals.username,
                display_name: res.locals.display_name,
            },
            projectId,
            tokenType: res.locals.tokenType,
            tokenScopes: res.locals.scopes || [],
            req,
            res,
        });
        res.set("Cache-Control", "no-store");
        return res.status(result.statusCode).json(result.payload);
    } catch (error) {
        logger.error(`签发编辑器令牌时出错: ${error.message}`);
        return res.status(500).json({
            status: "error",
            message: "签发编辑器令牌失败",
            code: "EDITOR_TOKEN_ISSUE_FAILED",
        });
    }
};

/**
 * 刷新令牌
 */
export const refreshToken = async (req, res) => {
    try {
        // 优先从 cookie 读取 refresh token，回退到 body（兼容非浏览器客户端）
        const { fromCookie, refresh_token, refresh_tokens: refreshTokens } = extractRefreshTokenFromRequest(req);
        const csrfCheck = fromCookie ? await validateOriginForCSRF(req) : { valid: true, skipped: true };

        if (!refresh_token) {
            return res.status(400).json({
                status: "error",
                message: "刷新令牌是必需的",
            });
        }

        // 当 refresh token 来自 Cookie 时，执行 CSRF 验证
        if (fromCookie) {
            if (!csrfCheck.valid) {
                return res.status(403).json({
                    status: "error",
                    message: csrfCheck.message || "CSRF 验证失败",
                });
            }
        }

        let result = { success: false, message: "刷新令牌失败" };
        const candidates = Array.isArray(refreshTokens) && refreshTokens.length > 0
            ? refreshTokens
            : [refresh_token].filter(Boolean);
        for (const candidate of candidates) {
            result = await authUtils.refreshAccessToken(
                candidate,
                req.ip,
                req.headers["user-agent"]
            );
            if (result.success) break;
        }

        if (result.success) {
            return respondWithBrowserAuthTokens(res, {
                status: "success",
                message: "令牌已刷新",
                token: result.accessToken,
                refresh_token: result.refreshToken,
                expires_at: toIsoOrValue(result.expiresAt),
                refresh_expires_at: toIsoOrValue(result.refreshExpiresAt),
            });
        } else {
            return res.status(401).json({
                status: "error",
                message: result.message || "刷新令牌失败",
                code: "ZC_ERROR_NEED_LOGOUT",
            });
        }
    } catch (error) {
        logger.error("刷新令牌时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "刷新令牌失败",
            code: "ZC_ERROR_NEED_LOGOUT",
        });
    }
};

/**
 * 获取令牌详情
 */
export const getTokenDetails = async (req, res) => {
    try {
        const userId = res.locals.userid;
        const {tokenId} = req.params;
        const includeLocation = req.query.include_location === "true";

        // 验证令牌ID格式
        const tokenIdNumber = parseInt(tokenId);
        if (isNaN(tokenIdNumber)) {
            return res.status(400).json({
                status: "error",
                message: "无效的令牌ID格式",
            });
        }

        // 获取令牌详情
        const token = await prisma.ow_tokens.findFirst({
            where: {
                id: tokenIdNumber,
                user_id: userId,
            },
        });

        if (!token) {
            return res.status(404).json({
                status: "error",
                message: "未找到令牌或无权查看",
            });
        }

        // 按需获取位置信息
        let ipLocationInfo = null;
        let lastUsedIpLocationInfo = null;

        if (includeLocation) {
            // 如果有IP地址，则获取其位置信息
            if (token.ip_address) {
                try {
                    ipLocationInfo = await ipLocation.getIPLocation(token.ip_address);
                } catch (e) {
                    logger.error(`获取IP ${token.ip_address} 位置信息时出错:`, e);
                }
            }

            // 如果有最后使用IP，且与创建IP不同，则获取其位置信息
            if (token.last_used_ip && token.last_used_ip !== token.ip_address) {
                try {
                    lastUsedIpLocationInfo = await ipLocation.getIPLocation(
                        token.last_used_ip
                    );
                } catch (e) {
                    logger.error(`获取IP ${token.last_used_ip} 位置信息时出错:`, e);
                }
            } else if (token.last_used_ip) {
                // 如果最后使用IP与创建IP相同，复用创建IP的位置信息
                lastUsedIpLocationInfo = ipLocationInfo;
            }
        }

        // 解析设备信息
        let deviceInfo = null;
        try {
            if (token.device_info) {
                deviceInfo = JSON.parse(token.device_info);
            }
        } catch (e) {
            logger.error(`解析设备信息时出错:`, e);
        }

        // 格式化响应数据
        const tokenDetails = {
            id: token.id,
            created_at: token.created_at,
            expires_at: token.expires_at,
            refresh_expires_at: token.refresh_expires_at,
            last_used_at: token.last_used_at,
            activity_count: token.activity_count,
            extended_at: token.extended_at,
            revoked: token.revoked,
            revoked_at: token.revoked_at,
            ip_address: token.ip_address,
            ip_location: ipLocationInfo,
            last_used_ip: token.last_used_ip,
            last_used_ip_location: lastUsedIpLocationInfo,
            device_info: deviceInfo,
            is_current: token.id === res.locals.tokenId,
        };

        return res.status(200).json({
            status: "success",
            data: tokenDetails,
        });
    } catch (error) {
        logger.error("获取令牌详情时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "获取令牌详情失败",
        });
    }
};

/**
 * 获取活跃令牌列表
 */
export const getActiveTokens = async (req, res) => {
    try {
        const userId = res.locals.userid;

        const tokens = await authUtils.getUserActiveTokens(userId);

        // 处理位置信息 - 默认不获取位置
        const includeLocation = req.query.include_location === "true";

        // 打包令牌信息结果
        const formattedTokens = await Promise.all(
            tokens.map(async (token) => {
                let ipLocationInfo = null;
                let lastUsedIpLocationInfo = null;

                // 如果请求包含位置信息，则实时获取
                if (includeLocation) {
                    if (token.ip_address) {
                        try {
                            ipLocationInfo = await ipLocation.getIPLocation(token.ip_address);
                        } catch (e) {
                            logger.error(`获取IP ${token.ip_address} 位置信息时出错:`, e);
                        }
                    }

                    // 如果最后使用IP与创建IP不同，则获取其位置信息
                    if (token.last_used_ip && token.last_used_ip !== token.ip_address) {
                        try {
                            lastUsedIpLocationInfo = await ipLocation.getIPLocation(
                                token.last_used_ip
                            );
                        } catch (e) {
                            logger.error(`获取IP ${token.last_used_ip} 位置信息时出错:`, e);
                        }
                    } else if (token.last_used_ip) {
                        // 如果最后使用IP与创建IP相同，复用创建IP的位置信息
                        lastUsedIpLocationInfo = ipLocationInfo;
                    }
                }

                // 解析设备信息
                let deviceInfo = null;
                try {
                    if (token.device_info) {
                        deviceInfo = JSON.parse(token.device_info);
                    }
                } catch (e) {
                    logger.error(`解析设备信息时出错:`, e);
                }

                return {
                    id: token.id,
                    created_at: token.created_at,
                    expires_at: token.expires_at,
                    refresh_expires_at: token.refresh_expires_at,
                    last_used_at: token.last_used_at,
                    activity_count: token.activity_count,
                    extended_at: token.extended_at,
                    ip_address: token.ip_address,
                    ip_location: ipLocationInfo,
                    last_used_ip: token.last_used_ip,
                    last_used_ip_location: lastUsedIpLocationInfo,
                    device_info: deviceInfo,
                    is_current: token.id === res.locals.tokenId,
                };
            })
        );

        return res.status(200).json({
            status: "success",
            message: "获取成功",
            data: formattedTokens,
        });
    } catch (error) {
        logger.error("获取活跃令牌列表时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "获取活跃令牌列表失败",
        });
    }
};

/**
 * 吊销特定令牌
 */
export const revokeToken = async (req, res) => {
    try {
        const {token_id} = req.body;
        const userId = res.locals.userid;

        if (!token_id) {
            return res.status(400).json({
                status: "error",
                message: "令牌ID是必需的",
            });
        }

        // 验证令牌是否属于当前用户
        const tokenRecord = await prisma.ow_tokens.findFirst({
            where: {
                id: token_id,
                user_id: userId,
            },
        });

        if (!tokenRecord) {
            return res.status(403).json({
                status: "error",
                message: "无权操作此令牌",
            });
        }

        const result = await authUtils.revokeToken(token_id);

        if (result.success) {
            return res.status(200).json({
                status: "success",
                message: "令牌已成功吊销",
            });
        } else {
            return res.status(400).json({
                status: "error",
                message: result.message || "吊销令牌失败",
            });
        }
    } catch (error) {
        logger.error("吊销令牌时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "吊销令牌失败",
        });
    }
};
