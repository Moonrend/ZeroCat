import logger from "../../services/logger.js";
import { prisma } from "../../services/prisma.js";
import { addUserContact, sendVerificationEmail, verifyContact } from "../email.js";
import isEmail from 'validator/lib/isEmail.js'
import { isDisposableEmail } from "../../services/global.js";
/**
 * 获取用户邮箱列表
 */
export const getEmails = async (req, res) => {
    try {
        const userId = res.locals.userid;

        const emails = await prisma.ow_users_contacts.findMany({
            where: {
                user_id: userId,
                contact_type: "email",
            },
            select: {
                contact_id: true,
                contact_value: true,
                is_primary: true,
                verified: true,
                created_at: true,
            },
            orderBy: [{ is_primary: "desc" }, { created_at: "desc" }],
        });

        return res.status(200).json({
            status: "success",
            message: "获取成功",
            data: emails,
        });
    } catch (error) {
        logger.error("获取邮箱列表时出错:", error);
        return res.status(200).json({
            status: "error",
            message: "获取邮箱列表失败",
        });
    }
};

/**
 * 发送邮箱验证码
 */
export const sendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const userId = res.locals.userid;

        // 检查邮箱是否属于当前用户
        const contact = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: userId,
                contact_value: email,
                contact_type: "email",
            },
        });

        if (!contact) {
            return res.status(200).json({
                status: "error",
                message: "未找到此邮箱或邮箱未验证",
            });
        }

        await sendVerificationEmail(email, contact.contact_info, "ADD_EMAIL");

        return res.status(200).json({
            status: "success",
            message: "验证码已发送",
        });
    } catch (error) {
        logger.error("发送验证码时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "发送验证码失败",
        });
    }
};

/**
 * 添加新邮箱
 */
export const addEmail = async (req, res) => {
    try {
        const { email } = req.body;
        const userId = res.locals.userid;

        // 检查新邮箱格式
        if (!email || !isEmail(email)|| isDisposableEmail(email)) {
            return res.status(200).json({
                status: "error",
                message: "请提供有效的邮箱地址",
            });
        }

        // 检查邮箱是否已被使用
        const existingContact = await prisma.ow_users_contacts.findFirst({
            where: { contact_value: email },
        });

        if (existingContact) {
            return res.status(200).json({
                status: "error",
                message: "此邮箱已被使用",
            });
        }

        // 检查邮箱数量限制
        const currentEmailCount = await prisma.ow_users_contacts.count({
            where: {
                user_id: userId,
                contact_type: "email",
            },
        });

        if (currentEmailCount >= 5) {
            return res.status(200).json({
                status: "error",
                message: "最多只能绑定5个邮箱",
            });
        }

        // 添加新邮箱
        const contact = await addUserContact(userId, email, "email", false);
        await sendVerificationEmail(email, contact.contact_info, "ADD_EMAIL");

        return res.status(200).json({
            status: "success",
            message: "邮箱添加成功，请查收验证邮件",
            data: {
                contact_id: contact.contact_id,
                contact_value: contact.contact_value,
                is_primary: contact.is_primary,
                verified: contact.verified,
            },
        });
    } catch (error) {
        logger.error("添加邮箱时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "添加邮箱失败",
        });
    }
};

/**
 * 验证邮箱
 */
export const verifyEmail = async (req, res) => {
    try {
        const { email, token } = req.body;
        const userId = res.locals.userid;

        // 检查参数是否完整
        if (!email || !token) {
            return res.status(200).json({
                status: "error",
                message: "邮箱和验证码都是必需的",
            });
        }

        // 检查邮箱是否属于当前用户
        const contact = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: userId,
                contact_value: email,
                contact_type: "email",
                verified: false,
            },
        });

        if (!contact) {
            return res.status(200).json({
                status: "error",
                message: "未找到此邮箱或邮箱已验证",
            });
        }

        // 验证验证码
        const isValid = await verifyContact(email, token, contact);

        if (!isValid) {
            return res.status(200).json({
                status: "error",
                message: "验证码无效",
            });
        }

        return res.status(200).json({
            status: "success",
            message: "邮箱验证成功",
            data: {
                contact_id: contact.contact_id,
                contact_value: contact.contact_value,
                is_primary: contact.is_primary,
                verified: true,
            },
        });
    } catch (error) {
        logger.error("验证邮箱时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "验证邮箱失败",
        });
    }
};

/**
 * 删除邮箱
 */
export const removeEmail = async (req, res) => {
    try {
        const { email } = req.body;
        const userId = res.locals.userid;

        // 查找要删除的邮箱
        const contactToDelete = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: userId,
                contact_value: email,
                contact_type: "email",
            },
        });

        if (!contactToDelete) {
            return res.status(200).json({
                status: "error",
                message: "未找到此邮箱",
            });
        }

        // 禁止删除主邮箱
        if (contactToDelete.is_primary) {
            return res.status(200).json({
                status: "error",
                message: "不能删除主邮箱",
            });
        }

        // 删除邮箱
        await prisma.ow_users_contacts.delete({
            where: {
                contact_id: contactToDelete.contact_id,
            },
        });

        return res.status(200).json({
            status: "success",
            message: "邮箱删除成功",
        });
    } catch (error) {
        logger.error("删除邮箱时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "删除邮箱失败",
        });
    }
};

/**
 * 设置主邮箱
 */
export const setPrimaryEmail = async (req, res) => {
    try {
        const { email } = req.body;
        const userId = res.locals.userid;

        // 验证邮箱归属
        const contactToSet = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: userId,
                contact_value: email,
                contact_type: "email",
                verified: true
            }
        });

        if (!contactToSet) {
            return res.status(200).json({
                status: "error",
                message: "邮箱不存在或未验证"
            });
        }

        // 事务中进行主邮箱切换
        await prisma.$transaction([
            // 先清除所有主邮箱标记
            prisma.ow_users_contacts.updateMany({
                where: {
                    user_id: userId,
                    contact_type: "email",
                    is_primary: true
                },
                data: {
                    is_primary: false
                }
            }),
            // 设置新的主邮箱
            prisma.ow_users_contacts.update({
                where: {
                    contact_id: contactToSet.contact_id
                },
                data: {
                    is_primary: true
                }
            })
        ]);

        return res.status(200).json({
            status: "success",
            message: "主邮箱设置成功"
        });
    } catch (error) {
        logger.error("设置主邮箱时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "设置主邮箱失败"
        });
    }
};