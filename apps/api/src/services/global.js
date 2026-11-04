import zcconfig from "./config/zcconfig.js";
import logger from "./logger.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { PasswordHash } from "phpass";
import fs from "fs";
import { createRequire } from 'module';

// Some Node.js environments or older bundlers may not support `import ... assert { type: 'json' }`.
// Use createRequire to synchronously load JSON in a compatible way.
const require = createRequire(import.meta.url);
const disposableDomains = require('disposable-domains');
//prisma client
import { prisma } from "./prisma.js";
import { putObject } from "./objectStorage.js";

const pwdHash = new PasswordHash();
async function S3update(name, fileContent) {
    try {
        const data = await putObject({
            bucket: await zcconfig.get("s3.bucket"),
            key: name,
            body: fileContent,
        });
        logger.debug(data);
        logger.debug(
            `成功上传了文件 ${await zcconfig.get("s3.bucket")}/${name}`
        );
    } catch (err) {
        logger.error("S3 update Error:", err);
    }
}

async function S3updateFromPath(name, path) {
    try {
        const fileContent = fs.readFileSync(path);
        await S3update(name, fileContent);
    } catch (err) {
        logger.error("S3 update Error:", err);
    }
}

function md5(data) {
    return crypto.createHash("md5").update(data).digest("base64");
}

function hash(data) {
    return pwdHash.hashPassword(data);
}

function checkhash(pwd, storeHash) {
    return pwdHash.checkPassword(pwd, storeHash);
}

function userpwTest(pw) {
    return /^(?:\d+|[a-zA-Z]+|[!@#$%^&*]+){6,16}$/.test(pw);
}

function emailTest(email) {
    return /^([a-zA-Z]|[0-9])(\w|\-)+@[a-zA-Z0-9]+\.[a-zA-Z]{2,4}$/.test(email);
}

/**
 * 清理用户名：只保留小写字母和数字，用单个下划线连接各部分
 * - 移除所有非字母数字字符，用下划线替代
 * - 合并连续下划线为单个
 * - 移除首尾下划线
 * - 转小写
 * @param {string} raw 原始字符串
 * @returns {string} 清理后的用户名（可能为空字符串）
 */
function sanitizeUsername(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')  // 非字母数字替换为下划线
        .replace(/^_+|_+$/g, '')       // 去除首尾下划线
        .replace(/_+/g, '_');           // 合并连续下划线
}

/**
 * 验证用户名是否合法
 * 规则：2-20位，只允许小写字母、数字和单个下划线，必须以字母开头
 * @param {string} username
 * @returns {{ valid: boolean, message?: string }}
 */
function validateUsername(username) {
    if (!username || typeof username !== 'string') {
        return { valid: false, message: '用户名不能为空' };
    }
    if (username.length < 2) {
        return { valid: false, message: '用户名至少需要2个字符' };
    }
    if (username.length > 20) {
        return { valid: false, message: '用户名不能超过20个字符' };
    }
    if (!/^[a-z]/.test(username)) {
        return { valid: false, message: '用户名必须以字母开头' };
    }
    if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(username)) {
        return { valid: false, message: '用户名只能包含小写字母、数字，且不能有连续下划线' };
    }
    return { valid: true };
}

function randomPassword(len = 12) {
    const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
    const maxPos = chars.length;
    const password = Array.from({ length: len - 4 }, () =>
        chars.charAt(Math.floor(Math.random() * maxPos))
    ).join("");
    return `${password}@Aa1`;
}

async function generateJwt(json) {
    try {
        const secret = await zcconfig.get("security.jwttoken");
        logger.debug(secret);
        if (!secret) {
            throw new Error("JWT secret is not defined in the configuration");
        }
        return jwt.sign(json, secret);
    } catch (error) {
        logger.error("Error generating JWT:", error);
        throw error;
    }
}

function isJSON(str) {
    if (typeof str !== "string") return false;
    try {
        const obj = JSON.parse(str);
        return obj && typeof obj === "object";
    } catch (e) {
        logger.error("error:", str, e);
        return false;
    }
}
function isDisposableEmail(email) {

    // 在 disposableDomains 中匹配根域名或子域名
    if (email) {
        email = email.toLowerCase().trim();
    }
    if (!email || !email.includes("@")) {
        return false;
    }

    const emailDomain = email.split("@")[1];
    return disposableDomains.some((domain) =>
        emailDomain === domain || emailDomain.endsWith(`.${domain}`)
    );
}
export {
    prisma,
    S3updateFromPath,
    S3update,
    md5,
    hash,
    checkhash,
    userpwTest,
    emailTest,
    sanitizeUsername,
    validateUsername,
    randomPassword,
    generateJwt,
    isJSON,
    isDisposableEmail,
};

