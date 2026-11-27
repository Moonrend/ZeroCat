import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {prisma} from '../prisma.js';
import redisClient from '../redis.js';
import logger from '../logger.js';
import {createNotification} from '../../controllers/notifications.js';
import zcconfig from '../config/zcconfig.js';
import twoFactor from './twoFactor.js';

const VERIFICATION_CODE_PREFIX = 'verify_code:';
const VERIFICATION_CODE_EXPIRY = 5 * 60; // 5分钟
const MAX_VERIFICATION_ATTEMPTS = 5;
const RESET_CODE_ISSUE_PREFIX = 'verify_code_issue:reset_password:';
const RESET_CODE_ISSUE_WINDOW = 15 * 60;
const MAX_RESET_CODE_ISSUES = 3;

/**
 * 统一的身份认证服务
 */
export class UnifiedAuthService {
    constructor() {
        this.supportedMethods = ['password', 'email', 'totp', 'passkey'];
        this.supportedPurposes = ['login', 'sudo', 'reset_password', 'change_email', 'delete_account'];
    }

    /**
     * 生成并发送邮件验证码
     * @param {number} userId 用户ID
     * @param {string} email 邮箱地址（可选）
     * @param {string} purpose 验证目的：login, sudo, reset_password, change_email, delete_account
     * @returns {Promise<{success: boolean, message: string, codeId?: string}>}
     */
    async sendVerificationCode(userId, email = null, purpose = 'login') {
        try {
            if (!userId) {
                return { success: false, message: '缺少用户信息' };
            }

            if (purpose === 'reset_password') {
                const issueCount = await redisClient.incrementWithExpiry(
                    `${RESET_CODE_ISSUE_PREFIX}${userId}`,
                    RESET_CODE_ISSUE_WINDOW
                );
                if (issueCount === null || issueCount > MAX_RESET_CODE_ISSUES) {
                    return { success: false, message: '验证码发送过于频繁，请稍后再试' };
                }
            }

            let targetEmail = typeof email === 'string' ? email.trim() : null;

            // 如果未指定邮箱，优先读取联系方式表中的主邮箱，再回退到用户表邮箱字段
            if (!targetEmail) {
                const primaryContact = await prisma.ow_users_contacts.findFirst({
                    where: {
                        user_id: userId,
                        contact_type: 'email',
                        is_primary: true,
                        verified: true
                    },
                    select: { contact_value: true }
                });

                if (primaryContact?.contact_value) {
                    targetEmail = primaryContact.contact_value;
                }

                if (!targetEmail) {
                    const anyVerifiedContact = await prisma.ow_users_contacts.findFirst({
                        where: {
                            user_id: userId,
                            contact_type: 'email',
                            verified: true
                        },
                        select: { contact_value: true }
                    });

                    if (anyVerifiedContact?.contact_value) {
                        targetEmail = anyVerifiedContact.contact_value;
                    }
                }

                if (!targetEmail) {
                    const user = await prisma.ow_users.findUnique({
                        where: { id: userId },
                        select: { email: true }
                    });
                    targetEmail = user?.email || null;
                }

                if (!targetEmail) {
                    return { success: false, message: '用户未绑定邮箱' };
                }
            } else {
                // 验证指定邮箱是否归属于该用户（兼容用户表和联系方式表两种存储）
                const [contactEmail, userEmail] = await Promise.all([
                    prisma.ow_users_contacts.findFirst({
                        where: {
                            user_id: userId,
                            contact_type: 'email',
                            contact_value: targetEmail
                        },
                        select: { contact_id: true }
                    }),
                    prisma.ow_users.findFirst({
                        where: {
                            id: userId,
                            email: targetEmail
                        },
                        select: { id: true }
                    })
                ]);

                if (!contactEmail && !userEmail) {
                    return { success: false, message: '指定的邮箱不属于当前用户' };
                }
            }

            // 生成6位验证码和唯一ID
            const code = crypto.randomInt(100000, 999999).toString();
            const codeId = crypto.randomUUID();
            const codeKey = `${VERIFICATION_CODE_PREFIX}${codeId}`;

            // 存储验证码
            await redisClient.set(codeKey, {
                code,
                email: targetEmail,
                userId,
                purpose,
                attemptsRemaining: MAX_VERIFICATION_ATTEMPTS,
                createdAt: Date.now()
            }, VERIFICATION_CODE_EXPIRY);

            // 生成通知内容
            const { title, content } = await this.generateNotificationContent(code, purpose, targetEmail);

            // 发送邮件类型通知
            await createNotification({
                notificationType: 'verification_code',
                notificationRequirement: 'BASIC',
                title,
                content,userId,
                pushChannels: ['email'],
                hidden: true,
                data: {
                    email_to: targetEmail,
                    purpose,
                    code,
                    userId
                }
            });

            logger.info(`[unified-auth] 已向用户 ${userId} 发送${purpose}验证码，邮箱: ${targetEmail}`);
            return {
                success: true,
                message: '验证码已发送到您的邮箱',
                codeId
            };
        } catch (error) {
            logger.error('[unified-auth] 发送验证码失败:', error);
            return { success: false, message: '发送验证码失败' };
        }
    }

    /**
     * 验证邮件验证码
     * @param {string} codeId 验证码ID
     * @param {string} code 验证码
     * @param {string} purpose 请求的认证目的
     * @param {number} userId 用户ID（可选，用于额外验证）
     * @returns {Promise<{valid: boolean, message: string, data?: any}>}
     */
    async verifyEmailCode(codeId, code, purpose, userId = null) {
        try {
            const codeKey = `${VERIFICATION_CODE_PREFIX}${codeId}`;
            const verification = await redisClient.consumeVerificationCode(codeKey, {
                code,
                purpose,
                userId,
                maxAttempts: MAX_VERIFICATION_ATTEMPTS
            });

            if (verification.status === 'missing') {
                return { valid: false, message: '验证码无效或已过期' };
            }
            if (verification.status === 'locked') {
                return { valid: false, message: '验证码尝试次数过多，请重新获取' };
            }
            if (verification.status === 'invalid') {
                return { valid: false, message: '验证码错误' };
            }
            if (verification.status !== 'valid' || !verification.data) {
                return { valid: false, message: '验证验证码时发生错误' };
            }

            const storedData = verification.data;

            logger.info(`[unified-auth] 用户 ${storedData.userId} 邮件验证码验证成功，目的: ${storedData.purpose}`);
            return {
                valid: true,
                message: '验证码验证成功',
                data: {
                    userId: storedData.userId,
                    email: storedData.email,
                    purpose: storedData.purpose
                }
            };
        } catch (error) {
            logger.error('[unified-auth] 验证邮件验证码失败:', error);
            return { valid: false, message: '验证验证码时发生错误' };
        }
    }

    /**
     * 验证用户密码
     * @param {number} userId 用户ID
     * @param {string} password 密码
     * @returns {Promise<{valid: boolean, message: string, user?: any}>}
     */
    async verifyPassword(userId, password) {
        try {
            const user = await prisma.ow_users.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    username: true,
                    display_name: true,
                    email: true,
                    password: true
                }
            });

            if (!user || !user.password) {
                return { valid: false, message: '用户不存在或未设置密码' };
            }

            const isValid = await bcrypt.compare(password, user.password);

            return {
                valid: isValid,
                message: isValid ? '密码验证成功' : '密码错误',
                user: isValid ? {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    email: user.email
                } : undefined
            };
        } catch (error) {
            logger.error('[unified-auth] 验证密码失败:', error);
            return { valid: false, message: '密码验证失败' };
        }
    }

    /**
     * 通过用户名或邮箱查找用户并验证密码
     * @param {string} identifier 用户名或邮箱
     * @param {string} password 密码
     * @returns {Promise<{valid: boolean, message: string, user?: any}>}
     */
    async verifyCredentials(identifier, password) {
        try {
            const user = await prisma.ow_users.findFirst({
                where: {
                    OR: [
                        { username: identifier },
                        { email: identifier }
                    ]
                },
                select: {
                    id: true,
                    username: true,
                    display_name: true,
                    email: true,
                    password: true
                }
            });

            if (!user || !user.password) {
                return { valid: false, message: '用户不存在或密码未设置' };
            }

            const isValid = await bcrypt.compare(password, user.password);

            return {
                valid: isValid,
                message: isValid ? '身份验证成功' : '用户名或密码错误',
                user: isValid ? {
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    email: user.email
                } : undefined
            };
        } catch (error) {
            logger.error('[unified-auth] 验证凭据失败:', error);
            return { valid: false, message: '身份验证失败' };
        }
    }

    /**
     * 统一的身份认证方法
     * @param {Object} authData 认证数据
     * @param {string} authData.method 认证方式：password, email, totp
     * @param {string} authData.purpose 认证目的：login, sudo, reset_password等
     * @param {number} authData.userId 用户ID（password方式和sudo目的需要）
     * @param {string} authData.identifier 用户标识符（用户名或邮箱，login目的需要）
     * @param {string} authData.password 密码
     * @param {string} authData.codeId 验证码ID（email方式）
     * @param {string} authData.code 验证码（email方式）
     * @returns {Promise<{success: boolean, message: string, user?: any, data?: any}>}
     */
    async authenticate(authData) {
        try {
            const { method, purpose, userId, identifier, password, codeId, code } = authData;

            // 验证参数
            if (!method || !this.supportedMethods.includes(method)) {
                return { success: false, message: '不支持的认证方式' };
            }

            if (!purpose || !this.supportedPurposes.includes(purpose)) {
                return { success: false, message: '不支持的认证目的' };
            }

            let authResult;

            switch (method) {
                case 'password':
                    if (purpose === 'login') {
                        // 登录需要用户名/邮箱+密码
                        if (!identifier || !password) {
                            return { success: false, message: '请提供用户名/邮箱和密码' };
                        }
                        authResult = await this.verifyCredentials(identifier, password);
                    } else {
                        // 其他目的需要用户ID+密码
                        if (!userId || !password) {
                            return { success: false, message: '请提供用户ID和密码' };
                        }
                        authResult = await this.verifyPassword(userId, password);
                    }
                    break;

                case 'email':
                    if (!codeId || !code) {
                        return { success: false, message: '请提供验证码ID和验证码' };
                    }
                    authResult = await this.verifyEmailCode(codeId, code, purpose, userId);

                    if (authResult.valid) {
                        // 如果是登录目的，需要获取完整用户信息
                        if (purpose === 'login') {
                            const user = await prisma.ow_users.findUnique({
                                where: { id: authResult.data.userId },
                                select: {
                                    id: true,
                                    username: true,
                                    display_name: true,
                                    email: true
                                }
                            });
                            authResult.user = user;
                        } else {
                            authResult.user = { id: authResult.data.userId };
                        }
                    }
                    break;

                case 'totp': {
                    // userId required
                    const uid = purpose === 'login' ? authResult?.user?.id || null : (userId || null);
                    const targetUserId = uid || userId;
                    const totpToken = code || password || authData?.totp || null; // accept in any field
                    if (!targetUserId || !totpToken) {
                        return { success: false, message: '缺少用户ID或TOTP验证码' };
                    }
                    const verify = await twoFactor.verifyTotp(targetUserId, totpToken);
                    if (!verify.success) {
                        return { success: false, message: verify.message };
                    }
                    // if login, must have prior password/email pre-auth challenge
                    if (purpose === 'login') {
                        // expect a challengeId to finalize
                        const challengeId = authData?.challengeId;
                        if (!challengeId) {
                            return { success: false, message: '缺少登录挑战ID' };
                        }
                        const challenge = await twoFactor.getLogin2FAChallenge(challengeId);
                        if (!challenge || challenge.userId !== targetUserId) {
                            return { success: false, message: '登录挑战无效' };
                        }
                        return { valid: true, message: 'TOTP验证成功', user: { id: targetUserId }, data: { challengeId } };
                    }
                    return { valid: true, message: 'TOTP验证成功', user: { id: targetUserId } };
                }

                case 'passkey':
                    // Passkey handled via separate controller due to WebAuthn ceremony
                    return { success: false, message: 'Passkey认证需调用WebAuthn端点' };

                default:
                    return { success: false, message: '不支持的认证方式' };
            }

            if (!authResult.valid) {
                logger.warn(`[unified-auth] ${purpose}认证失败: ${authResult.message}`);
                return {
                    success: false,
                    message: authResult.message,
                    user: authResult.user
                };
            }

            logger.info(`[unified-auth] ${purpose}认证成功，方式: ${method}，用户: ${authResult.user?.id}`);
            return {
                success: true,
                message: '身份认证成功',
                user: authResult.user,
                data: authResult.data
            };
        } catch (error) {
            logger.error('[unified-auth] 统一认证失败:', error);
            return { success: false, message: '身份认证失败' };
        }
    }

    /**
     * 生成不同目的的通知内容
     * @param {string} code 验证码
     * @param {string} purpose 认证目的
     * @param {string} email 目标邮箱
     * @returns {Promise<{title: string, content: string}>}
     */
    async generateNotificationContent(code, purpose, email) {
        const siteName = await zcconfig.get('site.name', 'ZeroCat');

        const templates = {
            login: {
                title: `登录验证码`,
                description: '您正在登录账户'
            },
            sudo: {
                title: `Sudo模式验证码`,
                description: '您正在尝试进入sudo模式'
            },
            reset_password: {
                title: `重置密码验证码`,
                description: '您正在重置账户密码'
            },
            change_email: {
                title: `更改邮箱验证码`,
                description: '您正在更改账户邮箱地址'
            },
            delete_account: {
                title: `删除账户验证码`,
                description: '您正在删除账户'
            }
        };

        const template = templates[purpose] || templates.login;

        const content = `您好！\n\n${template.description}，验证码为：${code}\n\n验证码有效期为5分钟。如果这不是您的操作，请忽略此邮件。\n\n为了您的账户安全，请不要将验证码告诉任何人。`;

        return {
            title: template.title,
            content
        };
    }
}

// 创建单例实例
export const unifiedAuth = new UnifiedAuthService();

// 导出常用方法的简化版本
export const sendVerificationCode = unifiedAuth.sendVerificationCode.bind(unifiedAuth);
export const verifyEmailCode = unifiedAuth.verifyEmailCode.bind(unifiedAuth);
export const verifyPassword = unifiedAuth.verifyPassword.bind(unifiedAuth);
export const verifyCredentials = unifiedAuth.verifyCredentials.bind(unifiedAuth);
export const authenticate = unifiedAuth.authenticate.bind(unifiedAuth);
