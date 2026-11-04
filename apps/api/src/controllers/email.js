import crypto from 'crypto';
import base32Encode from 'base32-encode';
import {prisma} from "../services/prisma.js";
import { createNotification } from '../controllers/notifications.js';
import {TOTP} from "otpauth";
import logger from '../services/logger.js';
import memoryCache from '../services/memoryCache.js';
import zcconfig from "../services/config/zcconfig.js";

// 创建TOTP实例的通用函数
function createTotpInstance(secret) {
    return new TOTP({
        secret: secret,
        algorithm: "SHA256",
        digits: 6,
        period: 300, // 5分钟有效期
        issuer: "ZeroCat",
        label: "邮箱验证"
    });
}

// 生成验证码
function generateEmailToken(secret) {
    const totp = createTotpInstance(secret);
    return totp.generate();
}

// 验证验证码
function validateEmailToken(secret, token) {
    try {
        const totp = createTotpInstance(secret);
        // window: 1 表示允许前后一个时间窗口的验证码
        return totp.validate({token, window: 1}) !== null;
    } catch (error) {
        logger.error('验证码验证失败:', error);
        return false;
    }
}

// Generate a Base32 hash for TOTP
const generateContactHash = () => {
    // 生成16字节的随机数据
    const buffer = crypto.randomBytes(16);
    // 使用 base32-encode 库将随机字节转换为 Base32 格式
    return base32Encode(buffer, 'RFC4648', {padding: false});
};

// Add a contact for a user
const addUserContact = async (userId, contactValue, contactType, isPrimary = false) => {
    const contactHash = generateContactHash();

    try {
        const contact = await prisma.ow_users_contacts.create({
            data: {
                user_id: userId,
                contact_value: contactValue,
                contact_info: contactHash,
                contact_type: contactType,
                is_primary: isPrimary,
                verified: false
            }
        });

        return contact;
    } catch (error) {
        if (error.code === 'P2002') {
            throw new Error('Contact already exists');
        }
        throw error;
    }
};

// 添加速率限制
const rateLimitEmailVerification = async (email) => {
    const key = `email_verification:${email}`;
    const count = memoryCache.get(key) || 0;

    if (count >= 3) {
        throw new Error('发送验证码过于频繁，请稍后再试 #2');
    }

    memoryCache.set(key, count + 1, 3600); // 1小时过期
};

// Send verification email
const sendVerificationEmail = async (contactValue, contactHash) => {
    await rateLimitEmailVerification(contactValue);

    const token = generateEmailToken(contactHash);
    const verifyUrl = `${await zcconfig.get("urls.frontend")}/app/account/email/verify?email=${encodeURIComponent(contactValue)}&token=${encodeURIComponent(token)}`;

    // 查找用户ID以发送隐藏通知
    const contact = await prisma.ow_users_contacts.findFirst({
        where: {
            contact_value: contactValue,
            contact_type: 'email'
        }
    });

    const userId = contact?.user_id || null;

    // 使用createNotification发送验证邮件通知
    await createNotification({
        userId,
        title: '验证您的邮箱',
        content: `您的验证码：${token}\n\n此验证码将在5分钟内有效。\n\n您也可以点击以下链接完成验证：\n${verifyUrl}`,
        notificationType: 'email_verification',
        notificationRequirement: 'BASIC',
        hidden: true,
        pushChannels: ['email'],
        data: {
            email_to: contactValue,
            email_username: contactValue.split('@')[0],
            email_link: verifyUrl,
            email_buttons: null,
            verification_code: token,
            verify_url: verifyUrl,
            type: 'email_verification'
        }
    });
};

// Verify contact

const verifyContact = async (contactValue, token, existingContact = null) => {
    const contact = existingContact ?? await prisma.ow_users_contacts.findFirst({
        where: {
            contact_value: contactValue
        }
    });

    if (!contact) {
        logger.debug('未找到邮箱联系方式');
        return false;
    }

    const isValid = validateEmailToken(contact.contact_info, token);
    logger.debug('验证结果:', isValid);

    if (!isValid) {
        logger.debug('验证码错误');
        return false;
    }

    await prisma.ow_users_contacts.update({
        where: {
            contact_id: contact.contact_id
        },
        data: {
            verified: true
        }
    });

    return true;
};

export {
    addUserContact,
    sendVerificationEmail,
    verifyContact
};
