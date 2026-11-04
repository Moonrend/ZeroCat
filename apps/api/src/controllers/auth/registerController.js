import logger from "../../services/logger.js";
import {emailTest, hash, userpwTest, validateUsername} from "../../services/global.js";
import { prisma } from "../../services/prisma.js";
import {
    checkRateLimit,
    createTemporaryToken,
    invalidateTemporaryToken,
    validateTemporaryToken,
    createRegistrationToken,
    validateRegistrationToken,
    invalidateRegistrationToken,
    VerificationType
} from "../../services/auth/verification.js";
import {generateMagicLinkForLogin, sendMagicLinkEmail} from "../../services/auth/magiclink.js";
import {sendEmail} from "../../services/email/emailService.js";
import tokenUtils from "../../services/auth/tokenUtils.js";
import zcconfig from "../../services/config/zcconfig.js";
import {createNotification} from "../notifications.js";
import {createEvent} from "../events.js";
import gorseService from "../../services/gorse.js";
import {assignDefaultRolesToUser} from "../../services/auth/policyEngine.js";

/**
 * 开始注册 / 登录：用户仅输入邮箱
 * - 邮箱已是激活账户 → 发送登录魔术链接
 * - 邮箱未注册 → 发送注册链接（点击后继续注册，邮箱视为已验证）
 * 两种情况返回相同响应，避免邮箱枚举（扫号）
 */
export const beginRegister = async (req, res) => {
    try {
        const {email, redirect} = req.body;
        const responseMessage = "我们已向该邮箱发送了一封邮件，请查收以继续";

        if (!email || !emailTest(email)) {
            return res.status(200).json({status: "error", message: "请输入有效的邮箱地址"});
        }

        // 频率限制（仍返回统一成功响应，避免枚举）
        const rateCheck = await checkRateLimit(email, VerificationType.REGISTER);
        if (!rateCheck.success) {
            logger.warn(`[beginRegister] 触发频率限制: ${email}`);
            return res.status(200).json({status: "success", message: responseMessage});
        }

        const existingUser = await prisma.ow_users.findFirst({
            where: {
                status: "active",
                contacts: { some: { contact_value: email, contact_type: "email", verified: true } },
            },
            select: { id: true },
        });

        const frontendUrl = await zcconfig.get("urls.frontend");

        if (existingUser) {
            // 已注册激活账户 → 发送登录魔术链接（保留 redirect）
            const magicLinkOptions = {templateType: "login"};
            if (redirect) {
                magicLinkOptions.redirect = redirect;
            }
            const magicLinkResult = await generateMagicLinkForLogin(existingUser.id, email, magicLinkOptions);
            if (magicLinkResult.success) {
                await sendMagicLinkEmail(email, magicLinkResult.magicLink, {templateType: "login", userId: existingUser.id});
            }
        } else {
            // 未注册 → 发送注册链接（尚无用户，直接发送到该邮箱）
            const tokenResult = await createRegistrationToken(email, 3600, redirect || null); // 1小时有效
            if (tokenResult.success) {
                let registerLink = `${frontendUrl}/app/account/register?token=${tokenResult.token}`;
                if (redirect) {
                    registerLink += `&redirect=${encodeURIComponent(redirect)}`;
                }
                await sendEmail(email, "完成 ZeroCat 账户注册", buildRegisterEmailHtml(registerLink));
            }
        }

        return res.status(200).json({status: "success", message: responseMessage});
    } catch (error) {
        logger.error("开始注册失败:", error);
        return res.status(200).json({status: "error", message: "操作失败，请稍后再试"});
    }
};

/**
 * 校验注册令牌并返回其邮箱（用于注册继续页展示已验证邮箱）
 */
export const checkRegisterToken = async (req, res) => {
    const {token} = req.query;
    const result = await validateRegistrationToken(token);
    if (!result.success) {
        return res.status(200).json({status: "error", message: result.message});
    }
    return res.status(200).json({status: "success", data: {email: result.email, redirect: result.redirect || null}});
};

/**
 * 完成注册：凭注册令牌设置用户名与密码，邮箱视为已验证并激活账户，完成后自动登录
 */
export const completeRegister = async (req, res) => {
    try {
        const {token, username, password} = req.body;

        if (!token || !username || !password) {
            return res.status(200).json({status: "error", message: "缺少必要参数"});
        }

        // 校验注册令牌 → 邮箱
        const tokenResult = await validateRegistrationToken(token);
        if (!tokenResult.success) {
            return res.status(200).json({status: "error", message: tokenResult.message});
        }
        const email = tokenResult.email;

        // 校验用户名格式
        const validation = validateUsername(username);
        if (!validation.valid) {
            return res.status(200).json({status: "error", message: validation.message});
        }

        // 校验密码
        if (!userpwTest(password)) {
            return res.status(200).json({status: "error", message: "密码格式不正确，密码至少需要8位，包含数字和字母"});
        }

        // 用户名占用检查
        const existingUser = await prisma.ow_users.findUnique({where: {username}});
        if (existingUser) {
            return res.status(200).json({status: "error", message: "用户名已被使用"});
        }

        // 邮箱占用检查（竞态安全）
        const existingContact = await prisma.ow_users_contacts.findFirst({
            where: {contact_value: email, contact_type: "email"},
        });
        if (existingContact) {
            return res.status(200).json({status: "error", message: "该邮箱已被注册，请直接登录"});
        }

        // 创建用户（邮箱已验证、账户激活）并授予默认用户角色
        const newUser = await prisma.$transaction(async (tx) => {
            const createdUser = await tx.ow_users.create({
                data: {
                    username,
                    display_name: username,
                    password: hash(password),
                    status: "active",
                },
            });
            await tx.ow_users_contacts.create({
                data: {
                    user_id: createdUser.id,
                    contact_value: email,
                    contact_type: "email",
                    is_primary: true,
                    verified: true,
                },
            });
            await assignDefaultRolesToUser(createdUser.id, tx);
            return createdUser;
        });

        // 同步推荐系统 + 注册事件
        gorseService.upsertUser(newUser.id, {username}).catch((e) => {
            logger.debug("[gorse] register user sync failed:", e.message);
        });
        await createEvent("user_register", newUser.id, "user", newUser.id, {
            event_type: "user_register",
            actor_id: newUser.id,
            target_type: "user",
            target_id: newUser.id,
        });

        // 注册令牌一次性使用
        await invalidateRegistrationToken(token);

        // 自动登录
        const userInfo = await tokenUtils.getUserInfoForToken(newUser, email);
        const tokenGen = await tokenUtils.createUserLoginTokens(
            newUser.id,
            userInfo,
            req.ipInfo?.clientIP || req.ip,
            req.headers["user-agent"],
            {recordLoginEvent: true, loginMethod: "register"}
        );

        if (!tokenGen.success) {
            return res.status(200).json({status: "success", message: "注册成功，请登录", needLogin: true});
        }

        const response = tokenUtils.generateLoginResponse(newUser, tokenGen, email);
        return tokenUtils.respondWithBrowserAuthTokens(res, response);
    } catch (error) {
        logger.error("完成注册失败:", error);
        return res.status(200).json({status: "error", message: "注册失败"});
    }
};

/**
 * 构造注册邮件 HTML
 */
function buildRegisterEmailHtml(registerLink) {
    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2328;">
  <h2 style="margin:0 0 16px;">完成你的 ZeroCat 账户注册</h2>
  <p style="margin:0 0 16px;line-height:1.6;">点击下方按钮继续注册，你的邮箱将自动完成验证：</p>
  <p style="margin:0 0 16px;"><a href="${registerLink}" style="display:inline-block;padding:12px 28px;background:#0098ff;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;">继续注册</a></p>
  <p style="margin:0 0 8px;color:#6b7280;font-size:13px;line-height:1.6;">如果按钮无法点击，请复制此链接到浏览器打开：<br>${registerLink}</p>
  <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;">链接 1 小时内有效。如果这不是你的操作，请忽略此邮件。</p>
</div>`;
}

/**
 * 注册可用性检查：用户名是否合法且未被占用
 * 注意：邮箱存在性不在此暴露（防扫号），由 register/begin 以统一响应处理
 */
export const checkAvailability = async (req, res) => {
    try {
        const {username} = req.query;
        const data = {};

        if (typeof username === "string" && username.trim()) {
            const value = username.trim();
            const validation = validateUsername(value);
            if (!validation.valid) {
                data.username = {valid: false, available: false, message: validation.message};
            } else {
                const existing = await prisma.ow_users.findUnique({where: {username: value}});
                data.username = existing
                    ? {valid: true, available: false, message: "用户名已被使用"}
                    : {valid: true, available: true, message: "用户名可用"};
            }
        }

        return res.status(200).json({status: "success", data});
    } catch (error) {
        logger.error("注册可用性检查失败:", error);
        return res.status(500).json({status: "error", message: "检查失败"});
    }
};

/**
 * 发送找回密码链接（点击链接打开设置新密码页面）
 */
export const retrievePassword = async (req, res) => {
    try {
        const {email} = req.body;
        const responseMessage = "如果此邮箱已注册，我们已向其发送密码重置链接";

        if (!email || !emailTest(email)) {
            return res.status(200).json({
                status: "error",
                message: "请提供有效的邮箱地址",
            });
        }

        const user = await prisma.ow_users.findFirst({
            where: {
                status: "active",
                contacts: { some: { contact_value: email, contact_type: "email", verified: true } },
            },
            select: { id: true },
        });

        // 安全起见：无论邮箱是否存在，都返回相同的成功响应，避免账号枚举
        if (!user) {
            return res.status(200).json({status: "success", message: responseMessage});
        }

        // 检查发送频率限制（仍返回统一成功响应以避免枚举）
        const rateCheck = await checkRateLimit(email, VerificationType.PASSWORD_RESET);
        if (!rateCheck.success) {
            logger.warn(`[retrievePassword] 触发发送频率限制: ${email}`);
            return res.status(200).json({status: "success", message: responseMessage});
        }

        // 生成强随机重置令牌（存储于 Redis），仅通过邮件投递链接
        const tokenResult = await createTemporaryToken(user.id, "reset_password", {email}, 1800); // 30分钟有效
        if (!tokenResult.success) {
            logger.error(`[retrievePassword] 创建重置令牌失败: ${tokenResult.message}`);
            return res.status(200).json({status: "success", message: responseMessage});
        }
        const frontendUrl = await zcconfig.get("urls.frontend");
        const resetLink = `${frontendUrl}/app/account/reset-password?token=${tokenResult.token}`;

        await createNotification({
            userId: user.id,
            title: "重置密码",
            content: `您正在重置账户密码。请点击下方链接设置新密码：\n\n${resetLink}\n\n链接将在 30 分钟后失效。如果这不是您的操作，请忽略此邮件。`,
            notificationType: "password_reset_email",
            notificationRequirement: "BASIC",
            hidden: true,
            pushChannels: ["email"],
            data: {
                email_to: email,
                email_username: email.split("@")[0],
                email_link: resetLink,
                email_buttons: null,
                type: "password_reset"
            }
        });

        return res.status(200).json({status: "success", message: responseMessage});
    } catch (error) {
        logger.error("发送找回密码链接时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "发送找回密码链接失败",
        });
    }
};

/**
 * 重置密码（凭邮件中的强随机令牌）
 */
export const resetPassword = async (req, res) => {
    try {
        const {
            token,
            new_password: snakeCaseNewPassword,
            newPassword: camelCaseNewPassword
        } = req.body;
        const newPassword = snakeCaseNewPassword || camelCaseNewPassword;

        if (!token || !newPassword) {
            return res.status(200).json({
                status: "error",
                message: "重置令牌和新密码都是必需的",
            });
        }

        if (!userpwTest(newPassword)) {
            return res.status(200).json({
                status: "error",
                message: "密码格式不正确，密码至少需要8位，包含数字和字母",
            });
        }

        // 校验强随机重置令牌（Redis 存储，限定用途 reset_password）
        const tokenResult = await validateTemporaryToken(token, "reset_password");
        if (!tokenResult.success) {
            return res.status(200).json({
                status: "error",
                message: tokenResult.message || "重置链接无效或已过期",
            });
        }

        const user = await prisma.ow_users.findUnique({
            where: {id: tokenResult.userId},
        });

        if (!user) {
            return res.status(200).json({
                status: "error",
                message: "用户不存在",
            });
        }

        // 更新密码
        await prisma.ow_users.update({
            where: {id: user.id},
            data: {
                password: hash(newPassword),
            },
        });

        // 撤销所有现有登录令牌
        await prisma.ow_tokens.updateMany({
            where: {
                user_id: user.id,
                revoked: false,
            },
            data: {
                revoked: true,
                revoked_at: new Date(),
            },
        });

        // 令牌一次性使用，立即失效
        await invalidateTemporaryToken(token);

        return res.status(200).json({
            status: "success",
            message: "密码已重置，请使用新密码登录",
        });
    } catch (error) {
        logger.error("重置密码时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "重置密码失败",
        });
    }
};

/**
 * 设置用户密码（仅限当前登录用户为自己设置初始密码）
 * 需登录中间件保护：使用 res.locals.userid，忽略请求体中的用户ID，避免越权。
 */
export const setPassword = async (req, res) => {
    try {
        const {password} = req.body;
        const userId = res.locals.userid;

        if (!userId) {
            return res.status(401).json({
                status: "error",
                message: "请先登录",
            });
        }

        if (!password) {
            return res.status(200).json({
                status: "error",
                message: "密码是必需的",
            });
        }

        if (!userpwTest(password)) {
            return res.status(200).json({
                status: "error",
                message: "密码格式不正确，密码至少需要8位，包含数字和字母",
            });
        }

        // 获取用户信息
        const user = await prisma.ow_users.findUnique({
            where: {id: userId},
        });

        if (!user) {
            return res.status(200).json({
                status: "error",
                message: "用户不存在",
            });
        }

        // 仅允许为「尚未设置密码」的账户设置初始密码；已有密码请走需 sudo 的修改密码流程
        if (user.password) {
            return res.status(200).json({
                status: "error",
                message: "账户已设置密码，请通过修改密码功能更改",
            });
        }

        // 更新密码
        await prisma.ow_users.update({
            where: {id: user.id},
            data: {
                password: hash(password),
            },
        });

        return res.status(200).json({
            status: "success",
            message: "密码设置成功",
        });
    } catch (error) {
        logger.error("设置密码时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "设置密码失败",
        });
    }
};
