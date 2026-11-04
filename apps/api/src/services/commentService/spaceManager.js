import crypto from 'crypto';
import { prisma } from '../prisma.js';
import logger from '../logger.js';

// 默认空间配置
const DEFAULT_SPACE_CONFIG = {
    audit: 'false',
    login: '',
    ipqps: '60',
    forbiddenWords: '',
    disableUserAgent: 'false',
    disableRegion: 'false',
    secureDomains: '',
    avatarProxy: '',
    levels: '',
    // 显示
    gravatarStr: 'https://seccdn.libravatar.org/avatar/{{mail|md5}}',
    // 通知
    disableAuthorNotify: 'false',
    authorEmail: '',
    // 通知渠道开关
    notifyEmailAdmin: 'true',
    notifyEmailReply: 'true',
    notifyWechat: 'false',
    notifyQywx: 'false',
    notifyQq: 'false',
    notifyTelegram: 'false',
    notifyPushplus: 'false',
    notifyDiscord: 'false',
    notifyLark: 'false',
    smtpHost: '',
    smtpPort: '',
    smtpUser: '',
    smtpPass: '',
    smtpSecure: '',
    smtpService: '',
    senderName: '',
    senderEmail: '',
    // 邮件模板自定义
    mailSubject: '',
    mailTemplate: '',
    mailSubjectAdmin: '',
    mailTemplateAdmin: '',
    // 微信 Server酱
    scKey: '',
    scTemplate: '',
    // 企业微信
    qywxAm: '',
    qywxProxy: '',
    qywxProxyPort: '',
    wxTemplate: '',
    // QQ Qmsg酱
    qmsgKey: '',
    qqId: '',
    qmsgHost: '',
    qqTemplate: '',
    // Telegram
    tgBotToken: '',
    tgChatId: '',
    tgTemplate: '',
    // PushPlus
    pushPlusKey: '',
    pushPlusTopic: '',
    pushPlusChannel: '',
    pushPlusTemplate: '',
    pushPlusWebhook: '',
    pushPlusCallbackUrl: '',
    // Discord
    discordWebhook: '',
    discordTemplate: '',
    // 飞书
    larkWebhook: '',
    larkSecret: '',
    larkTemplate: '',
    // 反垃圾
    spamChecker: 'akismet',    // '' | 'akismet'
    akismetKey: '',
    // 验证码
    captchaType: '',           // '' | 'turnstile' | 'recaptchaV3'
    recaptchaV3Key: '',
    recaptchaV3Secret: '',
    turnstileKey: '',
    turnstileSecret: '',
};

/**
 * 生成空间 CUID (16字符hex)
 */
function generateCuid() {
    return crypto.randomBytes(16).toString('hex').slice(0, 32);
}

/**
 * 生成空间 JWT 密钥
 */
function generateJwtSecret() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 创建评论空间
 */
export async function createSpace(ownerId, name, domain = null) {
    const cuid = generateCuid();
    const jwtSecret = generateJwtSecret();

    const space = await prisma.ow_comment_spaces.create({
        data: {
            cuid,
            owner_id: ownerId,
            name,
            domain,
            jwt_secret: jwtSecret,
        },
    });

    // 创建默认配置
    const configEntries = Object.entries(DEFAULT_SPACE_CONFIG).map(([key, value]) => ({
        target_type: 'comment_space',
        target_id: cuid,
        key,
        value,
    }));

    await prisma.ow_target_configs.createMany({ data: configEntries });

    // 将 owner 注册为空间的 administrator
    await prisma.ow_comment_service_users.create({
        data: {
            space_id: space.id,
            user_id: ownerId,
            type: 'administrator',
        },
    });

    return space;
}

/**
 * 获取空间详情
 */
export async function getSpaceByGuid(cuid) {
    return prisma.ow_comment_spaces.findUnique({
        where: { cuid },
    });
}

/**
 * 列出用户拥有的空间
 */
export async function listSpaces(ownerId) {
    return prisma.ow_comment_spaces.findMany({
        where: { owner_id: ownerId },
        orderBy: { created_at: 'desc' },
    });
}

/**
 * 更新空间
 * @param {string} cuid
 * @param {number} ownerId
 * @param {object} data
 * @param {boolean} isAdmin - 是否为站点管理员
 */
export async function updateSpace(cuid, ownerId, data, isAdmin = false) {
    const space = await prisma.ow_comment_spaces.findUnique({ where: { cuid } });
    if (!space || space.owner_id !== ownerId) return null;

    // 如果空间已被封禁，非管理员不允许修改 status
    if (space.status === 'banned' && !isAdmin && data.status !== undefined) {
        return null;
    }

    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.domain !== undefined) updateData.domain = data.domain;
    if (data.status !== undefined) updateData.status = data.status;

    return prisma.ow_comment_spaces.update({
        where: { cuid },
        data: updateData,
    });
}

/**
 * 删除空间
 */
export async function deleteSpace(cuid, ownerId) {
    const space = await prisma.ow_comment_spaces.findUnique({ where: { cuid } });
    if (!space || space.owner_id !== ownerId) return false;

    // 删除相关配置
    await prisma.ow_target_configs.deleteMany({
        where: { target_type: 'comment_space', target_id: cuid },
    });

    await prisma.ow_comment_spaces.delete({ where: { cuid } });
    return true;
}

/**
 * 获取空间配置
 */
export async function getSpaceConfig(cuid) {
    const configs = await prisma.ow_target_configs.findMany({
        where: { target_type: 'comment_space', target_id: cuid },
    });

    const result = { ...DEFAULT_SPACE_CONFIG };
    for (const config of configs) {
        result[config.key] = config.value;
    }
    return result;
}

// 检测字符串中是否存在可能的 JS 注入
const DANGEROUS_PATTERNS = [
    /<script[\s>]/i,
    /javascript\s*:/i,
    /\bon\w+\s*=/i,             // onclick=, onerror= ...
    /data\s*:\s*text\/html/i,
    /expression\s*\(/i,         // CSS expression()
    /url\s*\(\s*['"]?\s*javascript/i,
];

function containsDangerousContent(str) {
    return DANGEROUS_PATTERNS.some(re => re.test(str));
}

// 枚举类型约束
const ENUM_CONFIGS = {
    spamChecker: ['', 'akismet'],
    captchaType: ['', 'turnstile', 'recaptchaV3'],
};

// 布尔值约束
const BOOLEAN_CONFIGS = [
    'audit', 'disableUserAgent', 'disableRegion', 'disableAuthorNotify',
    'smtpSecure',
    'notifyEmailAdmin', 'notifyEmailReply', 'notifyWechat', 'notifyQywx', 'notifyQq',
    'notifyTelegram', 'notifyPushplus', 'notifyDiscord', 'notifyLark',
];

// 需要安全检查的自由文本配置（可能被前端渲染到页面）
const SANITIZE_CONFIGS = [
    'gravatarStr',
];

/**
 * 校验单个配置值，返回 null 表示通过，否则返回错误信息
 */
function validateConfigValue(key, value) {
    const strVal = String(value);

    // 枚举校验
    if (ENUM_CONFIGS[key]) {
        if (!ENUM_CONFIGS[key].includes(strVal)) {
            return `Invalid value for ${key}, allowed: ${ENUM_CONFIGS[key].join(', ')}`;
        }
    }

    // 布尔校验
    if (BOOLEAN_CONFIGS.includes(key)) {
        if (strVal !== '' && strVal !== 'true' && strVal !== 'false') {
            return `${key} must be 'true', 'false' or empty`;
        }
    }

    // 安全文本校验（防 JS 注入）
    if (SANITIZE_CONFIGS.includes(key) && strVal) {
        if (containsDangerousContent(strVal)) {
            return `${key} contains potentially dangerous content`;
        }
    }

    return null;
}

/**
 * 更新空间配置
 */
export async function updateSpaceConfig(cuid, ownerId, configData) {
    const space = await prisma.ow_comment_spaces.findUnique({ where: { cuid } });
    if (!space || space.owner_id !== ownerId) return null;

    const allowedKeys = Object.keys(DEFAULT_SPACE_CONFIG);
    const updates = [];
    const errors = [];

    for (const [key, value] of Object.entries(configData)) {
        if (!allowedKeys.includes(key)) continue;

        const err = validateConfigValue(key, value);
        if (err) {
            errors.push(err);
            continue;
        }

        updates.push(
            prisma.ow_target_configs.upsert({
                where: {
                    target_type_target_id_key: {
                        target_type: 'comment_space',
                        target_id: cuid,
                        key,
                    },
                },
                update: { value: String(value) },
                create: {
                    target_type: 'comment_space',
                    target_id: cuid,
                    key,
                    value: String(value),
                },
            })
        );
    }

    await Promise.all(updates);
    const result = await getSpaceConfig(cuid);

    if (errors.length > 0) {
        return { config: result, errors };
    }
    return result;
}

/**
 * 获取或创建空间用户映射
 */
export async function getOrCreateSpaceUser(spaceId, userId, defaults = {}) {
    let spaceUser = await prisma.ow_comment_service_users.findUnique({
        where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
    });

    if (!spaceUser) {
        spaceUser = await prisma.ow_comment_service_users.create({
            data: {
                space_id: spaceId,
                user_id: userId,
                type: defaults.type || 'guest',
                display_name: defaults.display_name || null,
                email: defaults.email || null,
                avatar: defaults.avatar || null,
            },
        });
    }

    return spaceUser;
}

/**
 * 获取空间用户
 */
export async function getSpaceUser(spaceId, userId) {
    return prisma.ow_comment_service_users.findUnique({
        where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
    });
}

/**
 * 列出空间用户
 * @param {number} spaceId
 * @param {number} page
 * @param {number} pageSize
 * @param {object} filters - { type, keyword }
 */
export async function listSpaceUsers(spaceId, page = 1, pageSize = 20, filters = {}) {
    const { type, keyword } = filters;

    // 有搜索关键词时使用 pg_trgm
    if (keyword && keyword.trim()) {
        return _searchSpaceUsers(spaceId, keyword.trim(), { page, pageSize, type });
    }

    const where = { space_id: spaceId };
    if (type) where.type = type;

    const skip = (page - 1) * pageSize;
    const [users, count] = await Promise.all([
        prisma.ow_comment_service_users.findMany({
            where,
            include: { user: { select: { id: true, username: true, display_name: true, avatar: true } } },
            skip,
            take: pageSize,
            orderBy: { created_at: 'desc' },
        }),
        prisma.ow_comment_service_users.count({ where }),
    ]);

    return { users, count, page, pageSize, totalPages: Math.ceil(count / pageSize) };
}

/**
 * pg_trgm 搜索空间用户 (内部方法)
 */
async function _searchSpaceUsers(spaceId, keyword, { page, pageSize, type }) {
    const params = [keyword, spaceId];
    const conditions = ['su.space_id = $2'];

    if (type) {
        params.push(type);
        conditions.push(`su.type = $${params.length}`);
    }

    const whereSql = conditions.join(' AND ');
    const scoreExpr = `GREATEST(
        similarity(COALESCE(su.display_name, ''), $1),
        similarity(COALESCE(u.display_name, ''), $1),
        similarity(COALESCE(u.username, ''), $1)
    )`;
    const matchExpr = `(
        su.display_name ILIKE '%' || $1 || '%'
        OR u.display_name ILIKE '%' || $1 || '%'
        OR u.username ILIKE '%' || $1 || '%'
        OR ${scoreExpr} > 0.1
    )`;

    const dataSql = `
        SELECT su.user_id, ${scoreExpr} AS score
        FROM ow_comment_service_users su
        LEFT JOIN ow_users u ON u.id = su.user_id
        WHERE ${whereSql} AND ${matchExpr}
        ORDER BY score DESC, su.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const countSql = `
        SELECT COUNT(*)::int AS total
        FROM ow_comment_service_users su
        LEFT JOIN ow_users u ON u.id = su.user_id
        WHERE ${whereSql} AND ${matchExpr}
    `;

    const [rows, countRows] = await Promise.all([
        prisma.$queryRawUnsafe(dataSql, ...params, pageSize, (page - 1) * pageSize),
        prisma.$queryRawUnsafe(countSql, ...params),
    ]);

    const count = countRows[0]?.total || 0;
    const userIds = rows.map(r => r.user_id);

    if (userIds.length === 0) {
        return { users: [], count: 0, page, pageSize, totalPages: 0 };
    }

    // 用 Prisma 查出完整记录
    const users = await prisma.ow_comment_service_users.findMany({
        where: { space_id: spaceId, user_id: { in: userIds } },
        include: { user: { select: { id: true, username: true, display_name: true, avatar: true } } },
    });

    // 保持 score 排序
    const userMap = new Map(users.map(u => [u.user_id, u]));
    const sorted = userIds.map(id => userMap.get(id)).filter(Boolean);

    return { users: sorted, count, page, pageSize, totalPages: Math.ceil(count / pageSize) };
}

/**
 * 更新空间用户
 */
export async function updateSpaceUser(spaceId, userId, data) {
    const updateData = {};
    if (data.type !== undefined) updateData.type = data.type;
    if (data.display_name !== undefined) updateData.display_name = data.display_name;
    if (data.label !== undefined) updateData.label = data.label;

    return prisma.ow_comment_service_users.update({
        where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
        data: updateData,
    });
}

/**
 * 获取空间统计
 */
export async function getSpaceStats(spaceId) {
    const [statusCounts, userCount] = await Promise.all([
        prisma.ow_comment_service.groupBy({
            by: ['status'],
            where: { space_id: spaceId },
            _count: { _all: true },
        }),
        prisma.ow_comment_service_users.count({ where: { space_id: spaceId } }),
    ]);
    const counts = new Map(statusCounts.map(group => [group.status, group._count._all]));
    const commentCount = statusCounts.reduce((total, group) => total + group._count._all, 0);

    return { commentCount, userCount, waitingCount: counts.get('waiting') || 0, spamCount: counts.get('spam') || 0 };
}

// ============================================================
// 管理员空间管理
// ============================================================

/**
 * 管理员：分页列出所有评论空间
 * @param {object} options - { page, limit, status, search }
 */
export async function adminListSpaces({ page = 1, limit = 20, status, search } = {}) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(limit) || 20));

    const where = {};
    if (status) where.status = status;
    if (search && search.trim()) {
        where.OR = [
            { name: { contains: search.trim(), mode: 'insensitive' } },
            { cuid: { contains: search.trim(), mode: 'insensitive' } },
        ];
    }

    const [spaces, count] = await Promise.all([
        prisma.ow_comment_spaces.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (pageNum - 1) * size,
            take: size,
            select: {
                id: true,
                cuid: true,
                name: true,
                domain: true,
                status: true,
                owner_id: true,
                created_at: true,
            },
        }),
        prisma.ow_comment_spaces.count({ where }),
    ]);

    return {
        page: pageNum,
        totalPages: Math.ceil(count / size),
        pageSize: size,
        count,
        data: spaces,
    };
}

/**
 * 管理员：获取单个空间完整信息
 * @param {number} spaceId
 */
export async function adminGetSpace(spaceId) {
    const space = await prisma.ow_comment_spaces.findUnique({
        where: { id: parseInt(spaceId) },
    });
    if (!space) return null;

    const { jwt_secret, ...safe } = space;
    return safe;
}

/**
 * 管理员：直接修改空间状态（无限制）
 * @param {number} spaceId
 * @param {string} status
 */
export async function adminUpdateSpaceStatus(spaceId, status) {
    return prisma.ow_comment_spaces.update({
        where: { id: parseInt(spaceId) },
        data: { status },
    });
}

export default {
    createSpace,
    getSpaceByGuid,
    listSpaces,
    updateSpace,
    deleteSpace,
    getSpaceConfig,
    updateSpaceConfig,
    getOrCreateSpaceUser,
    getSpaceUser,
    listSpaceUsers,
    updateSpaceUser,
    getSpaceStats,
    adminListSpaces,
    adminGetSpace,
    adminUpdateSpaceStatus,
};
