import logger from '../../services/logger.js';
import {
    sendVerificationCode,
    authenticate
} from '../../services/auth/unifiedAuth.js';
import { prisma } from '../../services/prisma.js'
import { hash, userpwTest } from '../../services/global.js';

import { generateSudoToken } from '../../services/auth/sudoAuth.js';

/**
 * 发送验证码统一接口
 */
export async function sendCode(req, res) {
    try {
        const { email, purpose = 'login' } = req.body;
        let  userId  = res.locals.userid;

        // 对于需要登录状态的操作，从中间件获取userId
        if (['sudo', 'change_email', 'delete_account'].includes(purpose)) {
            if (!res.locals.userid) {
                return res.status(401).json({
                    status: 'error',
                    message: `${purpose}操作需要先登录`,
                    code: 'NEED_LOGIN'
                });
            }
            logger.info(`[unified-auth-controller] ${purpose}操作需要登录，使用userId: ${res.locals.userid}`);
            userId = res.locals.userid;
        }

        // 对于登录和重置密码，如果没有提供userId但提供了email，尝试查找用户
        if (['login', 'reset_password'].includes(purpose) && !userId && email) {
            const emailContact = await prisma.ow_users_contacts.findFirst({
                where: {
                    contact_type: 'email',
                    contact_value: email,
                    ...(purpose === 'reset_password' ? { verified: true } : {})
                },
                select: {
                    user_id: true,
                    user: {
                        select: {
                            status: true
                        }
                    }
                }
            });
            const fallbackUser = !emailContact
                ? await prisma.ow_users.findFirst({
                    where: { email },
                    select: {
                        id: true,
                        status: true
                    }
                })
                : null;

            const resolvedUserId = emailContact?.user_id || fallbackUser?.id || null;
            const resolvedUserStatus = emailContact?.user?.status || fallbackUser?.status || null;

            if (!resolvedUserId || resolvedUserStatus !== 'active') {
                return res.status(404).json({
                    status: 'error',
                    message: '该邮箱未注册',
                    code: 'EMAIL_NOT_FOUND'
                });
            }
            logger.info(`[unified-auth-controller] 通过邮箱查找到用户: ${resolvedUserId}`);
            userId = resolvedUserId;
        }

        if (!userId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少用户信息',
                code: 'MISSING_USER_INFO'
            });
        }

        const result = await sendVerificationCode(userId, email, purpose);

        if (result.success) {
            res.json({
                status: 'success',
                message: result.message,
                data: {
                    code_id: result.codeId
                }
            });
        } else {
            res.status(400).json({
                status: 'error',
                message: result.message,
                code: 'SEND_CODE_FAILED'
            });
        }
    } catch (error) {
        logger.error('[unified-auth-controller] 发送验证码失败:', error);
        res.status(500).json({
            status: 'error',
            message: '发送验证码时发生错误',
            code: 'INTERNAL_ERROR'
        });
    }
}

/**
 * 统一认证接口
 */
export async function auth(req, res) {
    try {
        const {
            method,
            purpose,
            identifier,
            password,
            code_id: codeId,
            code,
            new_password: snakeCaseNewPassword,
            newPassword: camelCaseNewPassword
        } = req.body;
        const newPassword = snakeCaseNewPassword || camelCaseNewPassword;

        let { userId } = req.body;

        // 对于需要登录状态的操作，从中间件获取userId
        if (['sudo', 'change_email', 'delete_account'].includes(purpose)) {
            if (!res.locals.userid) {
                return res.status(401).json({
                    status: 'error',
                    message: `${purpose}操作需要先登录`,
                    code: 'NEED_LOGIN'
                });
            }
            userId = res.locals.userid;
        }

        // 执行统一认证
        const authResult = await authenticate({
            method,
            purpose,
            userId,
            identifier,
            password,
            codeId,
            code
        });

        if (!authResult.success) {
            return res.status(400).json({
                status: 'error',
                message: authResult.message,
                code: 'AUTH_FAILED'
            });
        }

        // 根据认证目的执行相应操作
        let responseData = {};

        switch (purpose) {
            case 'login':
                // 由具体登录控制器处理令牌签发与2FA，这里仅返回用户
                responseData = { user: authResult.user };
                break;

            case 'sudo':
                // 生成sudo令牌
                const sudoResult = await generateSudoToken(authResult.user.id);
                responseData = {
                    sudo_token: sudoResult.token,
                    expires_in: 0.5 * 60 // 15分钟
                };
                break;

            case 'reset_password':
                if (!newPassword) {
                    return res.status(400).json({
                        status: 'error',
                        message: '新密码是必需的',
                        code: 'MISSING_NEW_PASSWORD'
                    });
                }

                if (!userpwTest(newPassword)) {
                    return res.status(400).json({
                        status: 'error',
                        message: '密码格式不正确，密码至少需要8位，包含数字和字母',
                        code: 'INVALID_PASSWORD_FORMAT'
                    });
                }

                await prisma.ow_users.update({
                    where: { id: authResult.user.id },
                    data: {
                        password: hash(newPassword)
                    }
                });

                // 重置密码后撤销现有登录令牌
                await prisma.ow_tokens.updateMany({
                    where: {
                        user_id: authResult.user.id,
                        revoked: false,
                    },
                    data: {
                        revoked: true,
                        revoked_at: new Date(),
                    }
                });

                responseData = {
                    verified: true,
                    user_id: authResult.user.id,
                    password_reset: true
                };
                break;

            case 'change_email':
            case 'delete_account':
                // 这些操作需要额外的业务逻辑，这里只返回认证成功状态
                responseData = {
                    verified: true,
                    user_id: authResult.user.id
                };
                break;
        }

        res.json({
            status: 'success',
            message: `${purpose}认证成功`,
            data: responseData
        });

    } catch (error) {
        logger.error('[unified-auth-controller] 统一认证失败:', error);
        res.status(500).json({
            status: 'error',
            message: '认证时发生错误',
            code: 'INTERNAL_ERROR'
        });
    }
}

/**
 * 获取认证方法列表
 */
export async function getAuthMethods(req, res) {
    try {
        const { purpose = 'login', identifier } = req.query;

        // 根据目的返回可用的认证方法（基础集合）
        const baseMethods = {
            login: ['password', 'email', 'passkey'],
            sudo: ['password', 'email', 'totp', 'passkey'],
            reset_password: ['email'],
            change_email: ['password', 'email'],
            delete_account: ['password', 'email']
        };

        let availableMethods = baseMethods[purpose] || ['password', 'email'];
        const isEmailIdentifier = !!identifier && /\S+@\S+\.\S+/.test(identifier);
        // 账户是否存在：true=存在；false=明确不存在（仅用户名）；null=不透露（邮箱，防扫号）
        let accountExists = null;

        // 识别用户：优先使用已登录用户，其次使用查询参数中的identifier（用户名或邮箱）
        let userId = res.locals.userid;

        // 解析用户记录（含 password 字段，用于判断该账户是否设置了密码）
        let userRecord = null;
        if (userId) {
            userRecord = await prisma.ow_users.findFirst({
                where: { id: Number(userId) },
                select: { id: true, password: true }
            });
        } else if (identifier) {
            // 先按用户名 / 用户表邮箱查找
            userRecord = await prisma.ow_users.findFirst({
                where: { OR: [{ username: identifier }, { email: identifier }] },
                select: { id: true, password: true }
            });
            // 查不到再按已验证 / 主邮箱联系方式回查（邮箱主要存于联系方式表）
            if (!userRecord) {
                const emailContact = await prisma.ow_users_contacts.findFirst({
                    where: {
                        contact_type: 'email',
                        contact_value: identifier,
                        OR: [{ is_primary: true }, { verified: true }]
                    },
                    select: { user_id: true }
                });
                if (emailContact?.user_id) {
                    userRecord = await prisma.ow_users.findFirst({
                        where: { id: emailContact.user_id },
                        select: { id: true, password: true }
                    });
                }
            }
            if (userRecord) userId = userRecord.id;
        }

        // 如果能够识别用户，则依据其真实拥有的认证方式过滤（防枚举：未识别用户保留基础集合）
        if (userId) {
            const contacts = await prisma.ow_users_contacts.findMany({
                where: {
                    user_id: Number(userId),
                    OR: [
                        { contact_type: 'totp' },
                        { contact_type: 'passkey', verified: true },
                        { contact_type: 'email', OR: [{ is_primary: true }, { verified: true }] },
                    ],
                },
                select: { contact_type: true, verified: true, metadata: true },
            });
            const totpContact = contacts.find(contact => contact.contact_type === 'totp');
            const passkeyContact = contacts.find(contact => contact.contact_type === 'passkey');
            const emailContact = contacts.find(contact => contact.contact_type === 'email');

            const hasTotp = !!totpContact && !!totpContact.verified && totpContact.metadata?.enabled === true;
            const hasPasskey = !!passkeyContact && Array.isArray(passkeyContact.metadata?.credentials) && passkeyContact.metadata.credentials.length > 0;
            const hasPassword = !!(userRecord && userRecord.password);
            const hasEmail = !!emailContact;

            // 在可用方法中移除该账户未拥有的方式
            if (!hasTotp) {
                availableMethods = availableMethods.filter(m => m !== 'totp');
            }
            if (!hasPasskey) {
                availableMethods = availableMethods.filter(m => m !== 'passkey');
            }
            if (!hasPassword) {
                availableMethods = availableMethods.filter(m => m !== 'password');
            }
            if (!hasEmail) {
                availableMethods = availableMethods.filter(m => m !== 'email');
            }
            accountExists = true;
        } else if (identifier && !isEmailIdentifier) {
            // 用户名（非邮箱）未找到：用户名属公开信息，可明确提示不存在
            accountExists = false;
            availableMethods = [];
        }

        res.json({
            status: 'success',
            data: {
                purpose,
                available_methods: availableMethods,
                account_exists: accountExists
            }
        });
    } catch (error) {
        logger.error('[unified-auth-controller] 获取认证方法失败:', error);
        res.status(500).json({
            status: 'error',
            message: '获取认证方法时发生错误',
            code: 'INTERNAL_ERROR'
        });
    }
}
