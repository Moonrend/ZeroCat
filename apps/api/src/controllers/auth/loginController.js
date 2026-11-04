import logger from "../../services/logger.js";
import authUtils from "../../services/auth/auth.js";
import {checkhash, emailTest, userpwTest,} from "../../services/global.js";
import { prisma } from "../../services/prisma.js";
import redisClient from "../../services/redis.js";
import zcconfig from "../../services/config/zcconfig.js";
import {
    checkRateLimit,
    generateVerificationCode,
    VerificationType,
    verifyCode,
} from "../../services/auth/verification.js";
import {
    generateMagicLinkForLogin,
    markMagicLinkAsUsed,
    sendMagicLinkEmail,
    validateMagicLinkAndLogin as MagiclinkValidateMagicLinkAndLogin,
} from "../../services/auth/magiclink.js";
import { createNotification } from "../notifications.js";
import tokenUtils from "../../services/auth/tokenUtils.js";
import twoFactor from "../../services/auth/twoFactor.js";
import { revokeTokenByRefreshToken } from "../../services/auth/tokenService.js";

/**
 * 通过用户名或邮箱解析用户（邮箱优先匹配已验证/主邮箱联系方式，其次按用户名）
 */
const resolveUserByIdentifier = async (identifier) => {
    if (!identifier) return null;
    let user = null;
    if (emailTest(identifier)) {
        user = await prisma.ow_users.findFirst({
            where: {
                contacts: { some: {
                    contact_value: identifier,
                    contact_type: "email",
                    OR: [{ is_primary: true }, { verified: true }],
                } },
            },
        });
    }
    if (!user) {
        user = await prisma.ow_users.findFirst({where: {username: identifier}});
    }
    return user;
};

/**
 * 获取用户用于接收验证码/链接的邮箱（主邮箱优先，其次任一已验证邮箱）
 */
const getUserDeliveryEmail = async (userId) => {
    const contact = await prisma.ow_users_contacts.findFirst({
        where: { user_id: userId, contact_type: "email", verified: true },
        orderBy: { is_primary: "desc" },
        select: { contact_value: true },
    });
    return contact?.contact_value || null;
};

/**
 * 处理用户密码登录
 */
export const loginWithPassword = async (req, res, next) => {
    try {
        const loginId = req.body.un;

        // 检查登录尝试次数
        const attemptKey = `login_attempts:${loginId}`;
        const attempts = (await redisClient.get(attemptKey)) || 0;

        if (attempts >= 5) {
            return res.status(200).json({
                status: "error",
                message: "登录尝试次数过多，请15分钟后再试",
            });
        }

        if (!req.body.pw || !userpwTest(req.body.pw)) {
            await redisClient.set(attemptKey, attempts + 1, 900); // 15分钟过期
            return res.status(200).json({
                status: "error",
                message: "账户或密码错误",
            });
        }

        const user = await resolveUserByIdentifier(loginId);

        if (!user) {
            await redisClient.set(attemptKey, attempts + 1, 900); // 15分钟过期
            return res.status(200).json({
                status: "error",
                message: "账户或密码错误",
            });
        }

        // 检查用户是否设置了密码
        if (!user.password) {
            return res.status(200).json({
                status: "error",
                message: "此账户未设置密码，请使用验证码或魔术链接登录",
                code: "NO_PASSWORD",
            });
        }

        // 检查密码是否正确
        if (!checkhash(req.body.pw, user.password)) {
            await redisClient.set(attemptKey, attempts + 1, 900); // 15分钟过期
            return res.status(200).json({
                status: "error",
                message: "账户或密码错误",
            });
        }

        // 检查账户状态
        if (user.status !== "active") {
            return res.status(200).json({
                status: "error",
                message: "账户状态异常 #1",
            });
        }

        const deliveryEmail = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: user.id,
                contact_type: "email",
                OR: [{ is_primary: true }, { verified: true }],
            },
            orderBy: { is_primary: "desc" },
            select: { contact_value: true },
        });

        if (!deliveryEmail) {
            return res.status(200).json({
                status: "error",
                message: "请先验证邮箱",
            });
        }

        const userEmail = deliveryEmail.contact_value;

        // 获取标准化的用户信息
        const userInfo = await tokenUtils.getUserInfoForToken(user, userEmail);

        // 检查是否启用2FA
        const twoFA = await twoFactor.getTwoFactorStatus(user.id);
        if (twoFA.enabled) {
            const { challengeId, expiresIn } = await twoFactor.createLogin2FAChallenge(
                user.id,
                userInfo,
                req.ipInfo?.clientIP || req.ip,
                req.headers["user-agent"]
            );
            // 登录成功后清除尝试记录
            await redisClient.delete(attemptKey);
            return res.status(200).json({
                status: "need_2fa",
                message: "需要二次验证",
                data: {
                    challenge_id: challengeId,
                    expires_in: expiresIn,
                    available_methods: ["totp", "passkey"],
                },
            });
        }

        // 未启用2FA，直接签发令牌
        const tokenResult = await tokenUtils.createUserLoginTokens(
            user.id,
            userInfo,
            req.ipInfo?.clientIP || req.ip,
            req.headers["user-agent"],
            {
                recordLoginEvent: true,
                loginMethod: 'password'
            }
        );

        if (!tokenResult.success) {
            logger.error(`创建登录令牌失败: ${tokenResult.message}`);
            return res.status(500).json({
                status: "error",
                message: "创建登录令牌失败"
            });
        }

        // 登录成功后清除尝试记录
        await redisClient.delete(attemptKey);

        const response = tokenUtils.generateLoginResponse(user, tokenResult, userEmail);
        return tokenUtils.respondWithBrowserAuthTokens(res, response);
    } catch (err) {
        logger.error("密码登录失败:", err);
        return res.status(500).json({
            status: "error",
            message: "服务器内部错误，请稍后再试",
        });
    }
};

/**
 * 发送登录验证码（支持用户名或邮箱，带防枚举）
 */
export const sendLoginCode = async (req, res) => {
    try {
        const identifier = req.body.identifier || req.body.email;
        const responseMessage = "如果该账户存在，验证码已发送到其绑定邮箱";

        if (!identifier) {
            return res.status(200).json({
                status: "error",
                message: "请输入邮箱或用户名",
            });
        }

        const user = await resolveUserByIdentifier(identifier);
        const email = user && user.status === "active"
            ? await getUserDeliveryEmail(user.id)
            : null;

        // 账户不存在 / 未绑定邮箱：返回统一成功响应，避免账号枚举
        if (!email) {
            return res.status(200).json({status: "success", message: responseMessage, expiresIn: 300});
        }

        // 检查发送频率限制（仍返回统一成功响应）
        const rateCheck = await checkRateLimit(email, VerificationType.LOGIN);
        if (!rateCheck.success) {
            logger.warn(`[sendLoginCode] 触发发送频率限制: ${email}`);
            return res.status(200).json({status: "success", message: responseMessage, expiresIn: 300});
        }

        // 生成验证码
        const verificationResult = await generateVerificationCode(
            email,
            VerificationType.LOGIN
        );

        if (!verificationResult.success) {
            logger.error(`[sendLoginCode] 生成验证码失败: ${verificationResult.message}`);
            return res.status(200).json({status: "success", message: responseMessage, expiresIn: 300});
        }

        // 发送登录验证码邮件通知
        const code = verificationResult.code;
        await createNotification({
            userId: user.id,
            title: '登录验证码',
            content: `您的登录验证码：${code}\n\n请在登录页面输入此验证码完成登录。\n\n验证码5分钟内有效，请及时使用。`,
            notificationType: 'login_code_email',
            notificationRequirement: 'BASIC',
            hidden: true,
            pushChannels: ['email'],
            data: {
                email_to: email,
                email_username: email.split('@')[0],
                email_link: null,
                email_buttons: null,
                verification_code: code,
                type: 'login_code'
            }
        });

        return res.status(200).json({
            status: "success",
            message: responseMessage,
            expiresIn: 300, // 5分钟过期
        });
    } catch (error) {
        logger.error("发送登录验证码时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "发送验证码失败",
        });
    }
};

/**
 * 使用验证码登录（支持用户名或邮箱，带防枚举）
 */
export const loginWithCode = async (req, res) => {
    try {
        const identifier = req.body.identifier || req.body.email;
        const {code} = req.body;

        if (!identifier || !code) {
            return res.status(200).json({
                status: "error",
                message: "邮箱/用户名和验证码都是必需的",
            });
        }

        const user = await resolveUserByIdentifier(identifier);
        const email = user ? await getUserDeliveryEmail(user.id) : null;

        // 账户不存在 / 无邮箱：返回与验证码错误一致的提示，避免账号枚举
        if (!user || !email) {
            return res.status(200).json({
                status: "error",
                message: "验证码无效或已过期",
            });
        }

        // 验证验证码
        const verifyResult = await verifyCode(email, code, VerificationType.LOGIN);

        if (!verifyResult.success) {
            return res.status(200).json({
                status: "error",
                message: verifyResult.message,
                attemptsLeft: verifyResult.attemptsLeft,
            });
        }

        if (user.status !== "active") {
            return res.status(200).json({
                status: "error",
                message: "账户状态异常 #2",
            });
        }

        // 获取标准化的用户信息
        const userInfo = await tokenUtils.getUserInfoForToken(user, email);

        // 检查是否启用2FA
        const twoFA = await twoFactor.getTwoFactorStatus(user.id);
        if (twoFA.enabled) {
            const { challengeId, expiresIn } = await twoFactor.createLogin2FAChallenge(
                user.id,
                userInfo,
                req.ipInfo?.clientIP || req.ip,
                req.headers["user-agent"]
            );
            return res.status(200).json({
                status: "need_2fa",
                message: "需要二次验证",
                data: {
                    challenge_id: challengeId,
                    expires_in: expiresIn,
                    available_methods: ["totp", "passkey"],
                },
            });
        }

        const tokenResult = await tokenUtils.createUserLoginTokens(
            user.id,
            userInfo,
            req.ipInfo?.clientIP || req.ip,
            req.headers["user-agent"],
            {
                recordLoginEvent: true,
                loginMethod: 'code'
            }
        );

        if (!tokenResult.success) {
            logger.error(`创建登录令牌失败: ${tokenResult.message}`);
            return res.status(500).json({
                status: "error",
                message: "创建登录令牌失败"
            });
        }

        const response = tokenUtils.generateLoginResponse(user, tokenResult, email);
        return tokenUtils.respondWithBrowserAuthTokens(res, response);
    } catch (error) {
        logger.error("验证码登录时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "登录失败",
        });
    }
};

/**
 * 生成魔术链接（支持用户名或邮箱，带防枚举）
 */
export const sendMagicLinkForLogin = async (req, res) => {
    try {
        const identifier = req.body.identifier || req.body.email;
        const {redirect} = req.body;
        const responseMessage = "如果该账户存在，登录链接已发送到其绑定邮箱";

        if (!identifier) {
            return res.status(200).json({
                status: "error",
                message: "请输入邮箱或用户名",
            });
        }

        const user = await resolveUserByIdentifier(identifier);
        const email = user && user.status === "active"
            ? await getUserDeliveryEmail(user.id)
            : null;

        // 账户不存在 / 未绑定邮箱：返回统一成功响应，避免账号枚举
        if (!email) {
            return res.status(200).json({status: "success", message: responseMessage});
        }

        // 检查速率限制（仍返回统一成功响应）
        const rateCheck = await checkRateLimit(email, VerificationType.LOGIN);
        if (!rateCheck.success) {
            logger.warn(`[sendMagicLink] 触发发送频率限制: ${email}`);
            return res.status(200).json({status: "success", message: responseMessage});
        }

        // 生成魔术链接
        const clientId = req.headers["user-agent"]
            ? req.headers["user-agent"].substring(0, 50)
            : undefined;
        const options = {
            expiresIn: 600, // 10分钟
            clientId,
            redirect,
        };

        const magicLinkResult = await generateMagicLinkForLogin(user.id, email, options);

        if (!magicLinkResult.success) {
            logger.error(`[sendMagicLink] 生成失败: ${magicLinkResult.message}`);
            return res.status(200).json({status: "success", message: responseMessage});
        }

        // 发送魔术链接邮件
        await sendMagicLinkEmail(email, magicLinkResult.magicLink, {
            templateType: "login",
            userId: user.id
        });

        return res.status(200).json({status: "success", message: responseMessage});
    } catch (error) {
        logger.error("生成魔术链接时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "生成魔术链接失败",
        });
    }
};

/**
 * 验证魔术链接并登录
 */
export const validateMagicLinkAndLogin = async (req, res) => {
    try {
        const {token, redirect} = req.query;

        if (!token) {
            return res.status(200).json({
                status: "error",
                message: "无效的魔术链接",
            });
        }

        // 验证魔术链接
        const validateResult = await MagiclinkValidateMagicLinkAndLogin(token);

        if (!validateResult.success) {
            return res.status(200).json({
                status: "error",
                message: validateResult.message,
            });
        }

        // 获取用户信息
        const user = await prisma.ow_users.findUnique({
            where: {id: validateResult.userId},
        });

        if (!user) {
            return res.status(200).json({
                status: "error",
                message: "用户不存在",
            });
        }
        logger.debug(validateResult);
        // 检查用户状态，如果不是激活状态且魔术链接的目的是激活账户，则激活账户
        if (user.status !== "active") {
            if (user.status === "pending") {
                // 激活用户账户
                await prisma.ow_users.update({
                    where: {id: user.id},
                    data: {status: "active"},
                });
                logger.debug("激活用户账户");
                //激活这个邮箱
                await prisma.ow_users_contacts.update({
                    where: {
                        user_id: user.id,
                        contact_value: validateResult.email,
                        contact_type: "email",
                    },
                    data: {verified: true},
                });
                // 更新用户对象以反映新状态
                user.status = "active";
            } else {
                // 如果不是激活用户的魔术链接，则返回错误
                return res.status(200).json({
                    status: "error",
                    message: "账户状态异常 #3",
                });
            }
        }

        const userEmail = await getUserDeliveryEmail(user.id);

        if (!userEmail) {
            return res.status(200).json({
                status: "error",
                message: "请先验证邮箱",
            });
        }

        // 获取标准化的用户信息
        const userInfo = await tokenUtils.getUserInfoForToken(user, userEmail);

        // 检查是否启用2FA
        const twoFA = await twoFactor.getTwoFactorStatus(user.id);
        if (twoFA.enabled) {
            const { challengeId, expiresIn } = await twoFactor.createLogin2FAChallenge(
                user.id,
                userInfo,
                req.ipInfo?.clientIP || req.ip,
                req.headers["user-agent"]
            );
            await markMagicLinkAsUsed(token);
            return res.status(200).json({
                status: "need_2fa",
                message: "需要二次验证",
                data: {
                    challenge_id: challengeId,
                    expires_in: expiresIn,
                    available_methods: ["totp", "passkey"],
                    callback: redirect ? { redirect: decodeURIComponent(redirect), canUseCurrentPage: true } : null,
                },
            });
        }

        const tokenResult = await tokenUtils.createUserLoginTokens(
            user.id,
            userInfo,
            req.ipInfo?.clientIP || req.ip,
            req.headers["user-agent"],
            {
                recordLoginEvent: true,
                loginMethod: 'magic_link'
            }
        );

        if (!tokenResult.success) {
            logger.error(`创建登录令牌失败: ${tokenResult.message}`);
            return res.status(500).json({
                status: "error",
                message: "创建登录令牌失败"
            });
        }

        await markMagicLinkAsUsed(token);

        const callbackData = redirect
            ? {
                redirect: decodeURIComponent(redirect),
                canUseCurrentPage: true,
            }
            : null;

        const response = tokenUtils.generateLoginResponse(user, tokenResult, userEmail, {callback: callbackData});
        return tokenUtils.respondWithBrowserAuthTokens(res, response);
    } catch (error) {
        logger.error("验证魔术链接时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "验证魔术链接失败",
        });
    }
};

/**
 * 登出
 */
export const logout = async (req, res) => {
    try {
        const tokenId = res.locals.tokenId || res.locals.tokeninfo?.token_id || null;
        if (tokenId) {
            await authUtils.revokeToken(tokenId);
        }

        const { refresh_tokens: refreshTokens } = tokenUtils.extractRefreshTokenFromRequest(req);
        for (const refreshToken of refreshTokens || []) {
            await revokeTokenByRefreshToken(refreshToken);
        }

        tokenUtils.clearRefreshTokenCookie(res);
        return res.status(200).json({
            status: "success",
            message: "登出成功",
        });
    } catch (error) {
        logger.error("登出时出错:", error);
        tokenUtils.clearRefreshTokenCookie(res);
        return res.status(500).json({
            status: "error",
            message: "登出失败",
        });
    }
};

/**
 * 登出所有设备
 */
export const logoutAllDevices = async (req, res) => {
    try {
        // 使用中间件验证后的用户信息
        const result = await authUtils.revokeAllUserTokens(res.locals.userid, res.locals.tokeninfo.token_id);

        if (result.success) {
            tokenUtils.clearAllRefreshTokenCookies(res);
            return res.status(200).json({
                status: "success",
                message: "已登出所有其他设备",
                count: result.count,
            });
        } else {
            return res.status(200).json({
                status: "error",
                message: result.message || "登出失败",
            });
        }
    } catch (error) {
        logger.error("登出所有设备时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "登出失败",
        });
    }
};

