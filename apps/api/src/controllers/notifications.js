/**
 * @fileoverview 通知系统辅助函数和常量
 */
import {prisma} from "../services/prisma.js";
import logger from "../services/logger.js";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendEmail } from "../services/email/emailService.js";
import zcconfig from "../services/config/zcconfig.js";
import { sendPushNotificationToUser } from "../services/pushNotification.js";
import emailTemplateService from "../services/email/emailTemplateService.js";
import { canViewContent, assertCanWrite } from "../services/moderation/visibility.js";

async function notificationIsVisible(notification, viewerId = null) {
    const actorId = notification.actor_id ?? notification.actorId;
    if (actorId && !await canViewContent('activity', { actor_id: Number(actorId) }, viewerId)) return false;
    if (actorId && !await canViewContent('profile', { id: Number(actorId) }, viewerId)) return false;
    let kind = String(notification.target_type ?? notification.targetType ?? '').toLowerCase();
    if (kind === 'user') kind = 'profile';
    if (kind === 'comment' && notification.data?.spaceCuid) kind = 'comment_service';
    const targetId = notification.target_id ?? notification.targetId;
    if (targetId && ['profile', 'post', 'project', 'comment', 'comment_service', 'list'].includes(kind)) {
        const models = { profile: 'ow_users', post: 'ow_posts', project: 'ow_projects', comment: 'ow_comment', comment_service: 'ow_comment_service', list: 'ow_projects_lists' };
        const target = await prisma[models[kind]].findUnique({ where: { id: Number(targetId) } });
        if (!target || !await canViewContent(kind, target, viewerId)) return false;
        if (kind === 'comment' && ['project', 'post'].includes(target.page_type)) {
            const parentModel = target.page_type === 'project' ? 'ow_projects' : 'ow_posts';
            const parent = await prisma[parentModel].findUnique({ where: { id: Number(target.page_id) || 0 } });
            if (!await canViewContent(target.page_type, parent, viewerId)) return false;
        }
    }
    return true;
}

export async function notificationCanSend(notification, viewerId) {
    if (!await notificationIsVisible(notification, viewerId)) return false;
    const actorId = notification.actor_id ?? notification.actorId;
    if (actorId) {
        const type = String(notification.target_type ?? notification.targetType ?? '').toLowerCase();
        const category = { post: 'posts', project: 'projects', user: 'relations', comment: 'comments', comment_service: 'comments' }[type] || 'activity';
        try { await assertCanWrite(Number(actorId), category, 'sync'); }
        catch (error) {
            if (error.statusCode === 403 || error.status === 403) return false;
            throw error;
        }
    }
    return true;
}

async function sanitizeNotification(notification, viewerId) {
    if (await notificationIsVisible(notification, viewerId)) {
        if (notification.actor_id && notification.target_type) {
            // 社区通知只保留当前可见的入口，历史正文/资料快照不作为可信公开数据。
            return { ...notification, title: '社区通知', content: '你关注的内容有更新', metadata: {}, data: {} };
        }
        return notification;
    }
    return { ...notification, title: '内容不可用', content: '', link: null, metadata: {}, data: {}, actor_id: null, actor: null, target_type: null, target_id: null };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NotificationTemplates = JSON.parse(
    readFileSync(join(__dirname, '../config/notificationTemplates.json'), 'utf8')
);

/**
 * 渲染模板字符串
 * @param {string} template - 模板字符串
 * @param {Object} vars - 变量对象
 * @returns {string} 渲染后的字符串
 */
function renderTemplate(template, vars) {
    if (!template || typeof template !== 'string') {
        return '';
    }

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = vars?.[key];
        return value === undefined || value === null ? '' : String(value);
    });
}

/**
 * 获取目标对象信息
 * @param {string} targetType - 目标类型
 * @param {number} targetId - 目标ID
 * @returns {Promise<Object|null>} 目标对象信息
 */
async function getTargetInfo(targetType, targetId) {
    try {
        switch (targetType) {
            case 'project':
                return await prisma.ow_projects.findUnique({
                    where: { id: Number(targetId) },
                    select: {
                        id: true,
                        name: true,
                        title: true,
                        authorid: true,
                        author: {
                            select: {
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                });
            case 'post':
                return await prisma.ow_posts.findUnique({
                    where: { id: Number(targetId) },
                    select: {
                        id: true,
                        content: true,
                        author_id: true,
                        author: {
                            select: {
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                });
            case 'user':
                return await prisma.ow_users.findUnique({
                    where: { id: Number(targetId) },
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                    },
                });
            case 'comment':
                return await prisma.ow_comment.findUnique({
                    where: { id: Number(targetId) },
                    select: {
                        id: true,
                        text: true,
                        user_id: true,
                        user: {
                            select: {
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                });
            default:
                return null;
        }
    } catch (error) {
        logger.error(`获取目标信息错误 ${targetType}/${targetId}:`, error);
        return null;
    }
}

/**
 * 生成目标对象的链接
 * @param {string} targetType - 目标类型
 * @param {number} targetId - 目标ID
 * @returns {string|null} 生成的链接
 */
/**
 * 生成目标对象的链接
 * @param {string} targetType - 目标类型
 * @param {number} targetId - 目标ID
 * @returns {string|null} 生成的链接
 */
function generateTargetLink(targetType, targetId) {
    if (!targetType || targetId === null || targetId === undefined) {
        return null;
    }

    const normalizedType = String(targetType).toLowerCase();
    switch (normalizedType) {
        case 'project':
            return `/app/link/project?id=${targetId}`;
        case 'post':
            return `/app/posts/${targetId}`;
        case 'user':
            return `/app/link/user?id=${targetId}`;
        default:
            return null;
    }
}

/**
 * 执行多渠道推送
 * @param {Object} pushData - 推送数据
 * @param {Object} pushData.notification - 通知对象
 * @param {number} pushData.userId - 用户ID
 * @param {string} pushData.title - 标题
 * @param {string} pushData.content - 内容
 * @param {string} pushData.link - 链接
 * @param {Object} pushData.template - 模板信息
 * @param {Array} pushData.pushChannels - 推送渠道
 * @param {Object} pushData.notificationData - 原始通知数据
 */
async function executeMultiChannelPush(pushData) {
    const { notification, userId, title, content, link, template, pushChannels, notificationData } = pushData;
    const pushResults = {};
    if (!await notificationCanSend(notificationData, userId)) return { skipped: true, reason: 'content_unavailable' };
    let hasError = false;

    // 遍历所有推送渠道
    for (const channel of pushChannels) {
        try {
            let result = null;

            switch (channel) {
                case 'browser':
                case 'push':
                    // 浏览器推送通知 - 需要用户ID
                    if (!userId) {
                        logger.warn(`跳过 ${channel} 推送：没有用户ID`);
                        continue;
                    }
                    result = await sendPushNotificationToUser(userId, {
                        title: title,
                        body: content,
                        url: link,
                        icon: template.icon ? `/icons/${template.icon}.png` : undefined,
                        data: {
                            notificationId: notification.id,
                            type: notificationData.notificationType,
                            ...notificationData.data
                        }
                    });
                    break;

                case 'email':
                    // 邮件推送
                    if (notificationData.data && notificationData.data.email_to) {
                        // 使用EmailTemplateService渲染和发送邮件
                        const emailData_details = notificationData.data;
                        const {
                            email_to,
                            email_username,
                            email_link,
                            email_buttons
                        } = emailData_details;

                        // 获取用户信息以显示display_name
                        let userDisplayInfo = {};
                        if (userId) {
                            const user = await prisma.ow_users.findUnique({
                                where: { id: Number(userId) },
                                select: {
                                    display_name: true,
                                    username: true,
                                },
                            });
                            userDisplayInfo = {
                                display_name: user?.display_name || user?.username || email_username || email_to.split('@')[0]
                            };
                        } else {
                            userDisplayInfo = {
                                display_name: email_username || email_to.split('@')[0]
                            };
                        }

                        const rendered = await emailTemplateService.renderTemplate('notification', {
                            title,
                            content,
                            email: email_to,
                            username: userDisplayInfo.display_name,
                            userId: userId,
                            link: email_link,
                            buttons: email_buttons
                        });

                        const { sendEmail } = await import('../services/email/emailService.js');
                        await sendEmail(email_to, rendered.subject, rendered.html, { notificationId: notification.id });

                        result = {
                            success: true,
                            to: email_to,
                            subject: rendered.subject
                        };
                    } else {
                        // 原有逻辑，发送给已知用户
                        result = await sendEmailNotificationDirect({
                            userId,
                            title,
                            content,
                            link,
                            notificationId: notification.id
                        });
                    }
                    break;

                default:
                    logger.warn(`未知的推送渠道: ${channel}`);
                    continue;
            }

            pushResults[channel] = {
                success: true,
                result: result,
                timestamp: new Date()
            };

        } catch (error) {
            hasError = true;
            pushResults[channel] = {
                success: false,
                error: error.message,
                timestamp: new Date()
            };
            logger.warn(`${channel}推送失败 (用户 ${userId}):`, error.message);
        }
    }

    // 更新通知的推送结果
    try {
        await prisma.ow_notifications.update({
            where: { id: notification.id },
            data: {
                push_results: pushResults,
                push_error: hasError
            }
        });
    } catch (updateError) {
        logger.error('更新推送结果失败:', updateError);
    }

    return { pushResults, hasError };
}

/**
 * 直接发送邮件通知（内部函数）
 * @param {Object} emailData - 邮件数据
 * @param {number} emailData.userId - 用户ID
 * @param {string} emailData.title - 标题
 * @param {string} emailData.content - 内容
 * @param {string} [emailData.link] - 链接
 * @param {number} [emailData.notificationId] - 关联的通知ID
 * @returns {Promise<Object>} 发送结果
 */
async function sendEmailNotificationDirect(emailData) {
    const { userId, title, content, link, notificationId } = emailData;

    // 获取用户邮箱
    const user = await prisma.ow_users.findUnique({
        where: { id: Number(userId) },
        select: {
            email: true,
            display_name: true,
            username: true,
        },
    });

    if (!user || !user.email) {
        throw new Error('用户邮箱不存在');
    }

    // 从通知的data中获取邮件相关信息
    const notification = await prisma.ow_notifications.findUnique({
        where: { id: notificationId },
        select: { data: true }
    });

    const emailData_details = notification?.data || {};
    const {
        email_to,
        email_username,
        email_link,
        email_buttons,
        has_link,
        has_buttons
    } = emailData_details;

    // 使用EmailTemplateService渲染邮件
    const rendered = await emailTemplateService.renderTemplate('notification', {
        title,
        content,
        email: user.email,
        username: user.display_name || user.username,
        userId: userId,
        link: email_link,
        buttons: email_buttons
    });

    // 发送邮件
    await sendEmail(user.email, rendered.subject, rendered.html, { notificationId });

    return {
        success: true,
        to: user.email,
        subject: rendered.subject
    };
}


/**
 * 检查是否应根据用户设置发送通知
 * @param {number} userId - 接收通知的用户ID
 * @param {string} notificationRequirement - 通知要求等级 BASIC|ENHANCED|ALL
 * @param {number} [actorId] - 触发通知的用户ID
 * @param {string} [targetType] - 目标类型
 * @param {number} [targetId] - 目标ID
 * @returns {Promise<boolean>}
 */
const NOTIFICATION_LEVEL_ORDER = {
    NONE: 0,
    BASIC: 1,
    ENHANCED: 2,
    ALL: 3
};

const NOTIFICATION_REQUIREMENT_ORDER = {
    BASIC: 1,
    ENHANCED: 2,
    ALL: 3
};


function normalizeNotificationLevel(level) {
    if (!level) return "BASIC";
    const normalized = String(level).toUpperCase();
    if (normalized === "DEFAULT") return "BASIC";
    if (NOTIFICATION_LEVEL_ORDER[normalized] !== undefined) {
        return normalized;
    }
    return "BASIC";
}

function normalizeTargetTypeForSettings(targetType) {
    if (!targetType) return null;
    const normalized = String(targetType).toUpperCase();
    if (normalized === "USER" || normalized === "PROJECT") {
        return normalized;
    }
    if (normalized === "USERS") return "USER";
    if (normalized === "PROJECTS") return "PROJECT";
    return null;
}

function normalizeNotificationRequirement(requirement) {
    const normalized = String(requirement || "").toUpperCase();
    if (normalized === "DIRECT") {
        return "BASIC";
    }
    if (NOTIFICATION_REQUIREMENT_ORDER[normalized] !== undefined) {
        return normalized;
    }
    return "BASIC";
}

function isLevelAllowed(level, required) {
    const levelRank = NOTIFICATION_LEVEL_ORDER[normalizeNotificationLevel(level)];
    const requiredRank = NOTIFICATION_REQUIREMENT_ORDER[required];
    return levelRank >= requiredRank;
}

async function getProjectOwnerSetting(userId, projectId) {
    if (!userId || !projectId) return null;
    const project = await prisma.ow_projects.findUnique({
        where: { id: Number(projectId) },
        select: { authorid: true }
    });
    if (!project?.authorid) {
        return null;
    }
    return getNotificationSetting(userId, "USER", project.authorid);
}

async function shouldSendNotification({ userId, notificationRequirement, actorId, targetType, targetId }) {
    const requirement = normalizeNotificationRequirement(notificationRequirement);
    const normalizedTargetType = normalizeTargetTypeForSettings(targetType);

    // 1. 检查针对 target 的设置
    let targetSetting = null;
    let projectOwnerSetting = null;
    if (normalizedTargetType && targetId) {
        targetSetting = await getNotificationSetting(userId, normalizedTargetType, targetId);

        // 项目有单独配置时，优先级最高，直接按项目配置判断。
        if (normalizedTargetType === "PROJECT" && targetSetting) {
            const projectLevel = normalizeNotificationLevel(targetSetting.level);
            if (projectLevel === "NONE") {
                logger.debug(`用户 ${userId} 已通过项目配置屏蔽 PROJECT:${targetId} 的通知`);
                return false;
            }
            return isLevelAllowed(projectLevel, requirement);
        }

        // 项目未配置时，回退到用户总配置（项目所有者设置）。
        if (normalizedTargetType === "PROJECT" && !targetSetting) {
            projectOwnerSetting = await getProjectOwnerSetting(userId, targetId);
        }

        const targetLevel = normalizeNotificationLevel(targetSetting?.level);
        if (targetLevel === "NONE") {
            logger.debug(`用户 ${userId} 已屏蔽对 ${normalizedTargetType}:${targetId} 的通知`);
            return false;
        }
    }

    // 2. 检查针对 actor 的设置
    let actorSetting = null;
    if (actorId) {
        actorSetting = await getNotificationSetting(userId, "USER", actorId);
        if (normalizeNotificationLevel(actorSetting?.level) === "NONE") {
            logger.debug(`用户 ${userId} 已屏蔽来自用户 ${actorId} 的通知`);
            return false;
        }
    }

    const candidateLevels = [];
    if (targetSetting) candidateLevels.push(normalizeNotificationLevel(targetSetting.level));
    if (projectOwnerSetting) candidateLevels.push(normalizeNotificationLevel(projectOwnerSetting.level));
    if (actorSetting) candidateLevels.push(normalizeNotificationLevel(actorSetting.level));

    if (candidateLevels.length === 0) {
        return isLevelAllowed("BASIC", requirement);
    }

    return candidateLevels.some((level) => isLevelAllowed(level, requirement));
}

/**
 * 创建新通知
 * 使用模板生成通知内容并存储到数据库
 *
 * @param {Object} notificationData - 通知数据
 * @param {number} notificationData.userId - 接收通知的用户ID
 * @param {string} notificationData.notificationType - 通知类型
 * @param {number} [notificationData.actorId] - 触发通知的用户ID
 * @param {string} [notificationData.targetType] - 目标类型
 * @param {number} [notificationData.targetId] - 目标ID
 * @param {string} [notificationData.notificationRequirement] - 通知要求等级 BASIC|ENHANCED|ALL
 * @param {Object} [notificationData.data] - 通知的附加数据
 * @param {boolean} [notificationData.highPriority] - 是否为高优先级通知
 * @param {boolean} [notificationData.hidden] - 是否为隐藏通知(不在用户列表中显示)
 * @param {Array} [notificationData.pushChannels] - 推送渠道数组 ['email', 'browser', 'push']
 * @param {string} [notificationData.title] - 自定义标题(覆盖模板)
 * @param {string} [notificationData.content] - 自定义内容(覆盖模板)
 * @param {string} [notificationData.link] - 自定义链接
 * @returns {Promise<Object>} 创建的通知
 */
export async function createNotification(notificationData) {
    try {
        if (!await notificationCanSend(notificationData, notificationData.userId)) return null;
        const notificationType = notificationData.notificationType
            ? String(notificationData.notificationType)
            : 'custom_notification';

        // 在创建前检查用户设置
        const shouldSend = await shouldSendNotification({
            userId: notificationData.userId,
            notificationRequirement: notificationData.notificationRequirement,
            actorId: notificationData.actorId,
            targetType: notificationData.targetType,
            targetId: notificationData.targetId,
        });

        if (!shouldSend) {
            logger.debug(`根据用户 ${notificationData.userId} 的设置，已跳过通知创建`);
            return null; // or some indicator that it was skipped
        }


        const template = NotificationTemplates[notificationType] || {
            title: notificationType,
            icon: 'notification',
            requiresActor: false,
        };

        const data = notificationData.data || {};
        const normalizeNotificationText = (value) => {
            if (value === null || value === undefined) return '';
            return String(value).trim();
        };

        // 通知文案以调用方传入为准，不再走集中模板渲染。
        const title =
            normalizeNotificationText(notificationData.title) ||
            normalizeNotificationText(data.notification_title) ||
            normalizeNotificationText(data.custom_title) ||
            '通知';

        const content =
            normalizeNotificationText(notificationData.content) ||
            normalizeNotificationText(data.notification_content) ||
            normalizeNotificationText(data.custom_content) ||
            normalizeNotificationText(data.content) ||
            '您有一条新通知';

        const link =
            notificationData.link ||
            generateTargetLink(notificationData.targetType, notificationData.targetId) ||
            null;

        // 默认推送渠道设置
        const defaultChannels = notificationData.hidden ? [] : ['browser'];
        const pushChannels = Array.isArray(notificationData.pushChannels)
            ? notificationData.pushChannels
            : defaultChannels;

        // 在数据库中创建通知
        const notificationCreateData = {
            title,
            content,
            link,
            metadata: {
                template_used: notificationType,
                ...data,
            },
            notification_type: notificationType,
            actor_id: notificationData.actorId ? Number(notificationData.actorId) : null,
            target_type: notificationData.targetType ? String(notificationData.targetType) : null,
            target_id: notificationData.targetId ? Number(notificationData.targetId) : null,
            data,
            high_priority: notificationData.highPriority || false,
            hidden: notificationData.hidden || false,
            push_channels: pushChannels,
            push_results: {},
            push_error: false,
            read: false,
        };

        // 如果有userId，则设置user_id字段
        if (notificationData.userId !== undefined && notificationData.userId !== null) {
            notificationCreateData.user_id = Number(notificationData.userId);
        }

        const notification = await prisma.ow_notifications.create({
            data: notificationCreateData
        });

        // 执行多渠道推送
        if (!notificationData.skipPush && pushChannels.length > 0) {
            await executeMultiChannelPush({
                notification,
                userId: notificationData.userId,
                title,
                content,
                link,
                template,
                pushChannels,
                notificationData: {
                    ...notificationData,
                    notificationType,
                    data
                }
            });
        }

        logger.debug('创建通知 ID ' + notification.id + ' 给用户 ' + notificationData.userId);
        return notification;
    } catch (error) {
        logger.error('创建通知出错:', error);
        throw error;
    }
}


/**
 * 获取用户的通知
 *
 * @param {Object} options - 查询选项
 * @param {number} options.userId - 用户ID
 * @param {boolean} [options.unreadOnly] - 是否只获取未读通知
 * @param {boolean} [options.includeHidden] - 是否包含隐藏通知
 * @param {number} [options.limit] - 返回的最大通知数量
 * @param {number} [options.offset] - 分页偏移量
 * @returns {Promise<Object>} 通知数组及分页信息
 */
export async function getUserNotifications(options) {
    const {userId, unreadOnly = false, includeHidden = false, limit = 20, offset = 0} = options;

    try {
        const whereConditions = {
            user_id: userId,
            ...(unreadOnly ? {read: false} : {}),
            ...(includeHidden ? {} : {hidden: false}),
        };

        const notifications = await prisma.ow_notifications.findMany({
            where: whereConditions,
            orderBy: {
                created_at: "desc",
            },
            select: {
                id: true,
                title: true,
                content: true,
                link: true,
                metadata: true,
                notification_type: true,
                read: true,
                created_at: true,
                read_at: true,
                high_priority: true,
                data: true,
                actor_id: true,
                actor: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        avatar: true,
                    },
                },
                target_type: true,
                target_id: true,
            },
            take: limit,
            skip: offset,
        });

        // 获取总数
        const totalCount = await prisma.ow_notifications.count({
            where: whereConditions,
        });
        const safeNotifications = await Promise.all(notifications.map(notification => sanitizeNotification(notification, userId)));
        const formattedNotifications = safeNotifications.map((notification) => ({
            id: Number(notification.id),
            title: notification.title,
            content: notification.content,
            link: notification.link,
            metadata: notification.metadata,
            type: notification.notification_type,
            read: notification.read,
            created_at: notification.created_at,
            read_at: notification.read_at,
            high_priority: notification.high_priority,
            data: notification.data || {},
            actor_id: notification.actor_id,
            actor: notification.actor,
            target_type: notification.target_type,
            target_id: notification.target_id,
        }));

        return {
            notifications: formattedNotifications,
            total: totalCount,
            limit,
            offset,
        };
    } catch (error) {
        logger.error("获取用户通知出错:", error);
        throw error;
    }
}

/**
 * 将通知标记为已读
 *
 * @param {Object} options - 选项
 * @param {number[]} options.notificationIds - 要标记的通知ID数组
 * @param {number} options.userId - 用户ID (用于安全验证)
 * @returns {Promise<number>} 更新的通知数量
 */
export async function markNotificationsAsRead(options) {
    const {notificationIds, userId} = options;

    try {
        if (!notificationIds || notificationIds.length === 0) {
            return 0;
        }

        const result = await prisma.ow_notifications.updateMany({
            where: {
                id: {in: notificationIds},
                user_id: userId,
            },
            data: {
                read: true,
                read_at: new Date(),
            },
        });

        return result.count;
    } catch (error) {
        logger.error("标记通知为已读出错:", error);
        throw error;
    }
}

/**
 * 获取用户未读通知数量
 *
 * @param {number} userId - 用户ID
 * @returns {Promise<number>} 未读通知总数
 */
export async function getUnreadNotificationCount(userId) {
    try {
        const count = await prisma.ow_notifications.count({
            where: {
                user_id: userId,
                read: false,
                hidden: false,
            },
        });
        return count;
    } catch (error) {
        logger.error("获取未读通知数量出错:", error);
        throw error;
    }
}

/**
 * 删除通知
 *
 * @param {Object} options - 选项
 * @param {number[]} options.notificationIds - 要删除的通知ID数组
 * @param {number} options.userId - 用户ID (用于安全验证)
 * @returns {Promise<number>} 删除的通知数量
 */
export async function deleteNotifications(options) {
    const {notificationIds, userId} = options;

    try {
        if (!notificationIds || notificationIds.length === 0) {
            return 0;
        }

        const result = await prisma.ow_notifications.deleteMany({
            where: {
                id: {in: notificationIds.map((id) => Number(id))},
                user_id: userId,
            },
        });

        return result.count;
    } catch (error) {
        logger.error("删除通知出错:", error);
        throw error;
    }
}

/**
 * 获取通知模板数据
 *
 * @returns {Object} 所有通知模板数据
 */
export function getNotificationTemplates() {
    return NotificationTemplates;
}

/**
 * 格式化通知以适应客户端期望的格式
 * 现在主要用于添加模板图标信息
 *
 * @param {Object} notification - 原始通知对象
 * @returns {Object} 格式化后的通知对象
 */
export async function formatNotificationForClient(notification) {
    // 基本通知信息
    const formattedNotification = {
        id: Number(notification.id),
        title: notification.title,
        content: notification.content,
        link: notification.link,
        metadata: notification.metadata,
        type: notification.type || notification.notification_type,
        read: notification.read,
        created_at: notification.created_at,
        read_at: notification.read_at,
        high_priority: notification.high_priority,
        data: notification.data || {},
        actor_id: notification.actor_id,
        actor: notification.actor,
        target_type: notification.target_type,
        target_id: notification.target_id,
    };

    // 获取模板信息（主要用于图标）
    const template = NotificationTemplates[formattedNotification.type] || {
        title: formattedNotification.type,
        icon: "notification",
        template: "通知内容",
        requiresActor: true,
    };

    formattedNotification.template_info = {
        title: template.title,
        icon: template.icon,
    };

    return formattedNotification;
}

/**
 * 增强版通知发送接口
 * 支持隐藏通知和多种推送渠道
 *
 * @param {Object} notificationData - 通知数据
 * @param {number} notificationData.userId - 接收通知的用户ID
 * @param {string} notificationData.title - 通知标题
 * @param {string} notificationData.content - 通知内容
 * @param {string} [notificationData.link] - 通知链接
 * @param {Array} [notificationData.pushChannels] - 推送渠道 ['email', 'browser', 'push']
 * @param {boolean} [notificationData.hidden] - 是否为隐藏通知
 * @param {number} [notificationData.actorId] - 行为者ID
 * @param {string} [notificationData.targetType] - 目标类型
 * @param {number} [notificationData.targetId] - 目标ID
 * @param {string} [notificationData.notificationRequirement] - 通知要求等级 BASIC|ENHANCED|ALL
 * @param {Object} [notificationData.metadata] - 元数据
 * @returns {Promise<Object>} 发送结果
 */
export async function sendEnhancedNotification(notificationData) {
    try {
        const {
            userId,
            title,
            content,
            link,
            pushChannels = ['browser'],
            hidden = false,
            actorId,
            targetType,
            targetId,
            notificationRequirement = 'BASIC',
            metadata = {}
        } = notificationData;
        if (!await notificationCanSend(notificationData, userId)) return { skipped: true, reason: 'content_unavailable' };

        // 处理特殊的 link 类型
        let finalLink = link;
        if (link === 'target' && targetType && targetId) {
            finalLink = generateTargetLink(targetType, targetId);
        }

        // 创建通知
        const notification = await createNotification({
            userId,
            title,
            content,
            link: finalLink,
            notificationType: 'enhanced_notification',
            notificationRequirement,
            actorId,
            targetType,
            targetId,
            hidden,
            pushChannels,
            data: {
                custom_title: title,
                custom_content: content,
                ...metadata
            },
            skipPush: false // 使用新的多渠道推送
        });

        return {
            success: true,
            notification,
            channels: pushChannels,
            hidden
        };
    } catch (error) {
        logger.error('发送增强通知失败:', error);
        throw error;
    }
}

/**
 * 发送通知的便捷接口
 * 支持多种通知渠道：browser（默认）、email 或留空
 *
 * @param {Object} notificationData - 通知数据
 * @param {number} notificationData.userId - 接收通知的用户ID
 * @param {string} notificationData.title - 通知标题
 * @param {string} notificationData.content - 通知内容
 * @param {string} [notificationData.link] - 通知链接
 * @param {string} [notificationData.channel] - 通知渠道：browser、email 或留空
 * @param {number} [notificationData.actorId] - 行为者ID
 * @param {string} [notificationData.targetType] - 目标类型，当link为'target'时使用
 * @param {number} [notificationData.targetId] - 目标ID，当link为'target'时使用
 * @param {string} [notificationData.notificationRequirement] - 通知要求等级 BASIC|ENHANCED|ALL
 * @param {Object} [notificationData.metadata] - 元数据
 * @returns {Promise<Object>} 发送结果
 */
export async function sendNotification(notificationData) {
    try {
        const {
            userId,
            title,
            content,
            link,
            channel = 'browser',
            actorId,
            targetType,
            targetId,
            notificationRequirement = 'BASIC',
            metadata = {}
        } = notificationData;
        if (!await notificationCanSend(notificationData, userId)) return { skipped: true, reason: 'content_unavailable' };

        // 处理特殊的 link 类型
        let finalLink = link;
        if (link === 'target' && targetType && targetId) {
            finalLink = generateTargetLink(targetType, targetId);
        }

        const result = { browser: null, email: null, push: null };

        // 发送浏览器通知（默认）
        if (channel === 'browser' || !channel) {
            const browserNotification = await createNotification({
                userId,
                title,
                content,
                link: finalLink,
                notificationType: 'custom_notification',
                notificationRequirement,
                actorId,
                targetType,
                targetId,
                data: { custom_title: title, custom_content: content },
                metadata,
                skipPush: true // 手动发送推送通知以获得更好的控制
            });
            result.browser = browserNotification;
            if (!browserNotification) return result;

            // 同时发送推送通知
            try {
                const pushResult = await sendPushNotificationToUser(userId, {
                    title,
                    body: content,
                    url: finalLink,
                    data: { notificationId: browserNotification.id, ...metadata }
                });
                result.push = pushResult;
            } catch (pushError) {
                logger.warn('发送推送通知失败:', pushError);
                result.push = { success: false, error: pushError.message };
            }
        }

        // 发送邮件通知
        if (channel === 'email') {
            const notification = await createNotification({
                ...notificationData, notificationType: 'custom_notification',
                link: finalLink, pushChannels: [], skipPush: true,
            });
            if (!notification) return result;
            result.email = await sendEmailNotification({
                userId,
                title,
                content,
                link: finalLink,
                notificationId: notification.id
            });
        }

        return result;
    } catch (error) {
        logger.error('发送通知失败:', error);
        throw error;
    }
}

/**
 * 发送邮件通知
 * @param {Object} emailData - 邮件数据
 * @param {number} emailData.userId - 用户ID
 * @param {string} emailData.title - 标题
 * @param {string} emailData.content - 内容
 * @param {string} [emailData.link] - 链接
 * @param {number} [emailData.notificationId] - 关联的通知ID
 * @returns {Promise<Object>} 发送结果
 */
async function sendEmailNotification(emailData) {
    try {
        const { userId, title, content, link, notificationId } = emailData;

        // 获取用户邮箱
        const user = await prisma.ow_users.findUnique({
            where: { id: Number(userId) },
            select: {
                email: true,
                display_name: true,
                username: true,
            },
        });

        if (!user || !user.email) {
            throw new Error('用户邮箱不存在');
        }

        // 获取前端地址配置
        const frontendUrl = await zcconfig.get("urls.frontend") || 'https://zerocat.top';

        // 构建邮件内容
        const notificationLink = notificationId
            ? `${frontendUrl}/app/notifications/${notificationId}`
            : (link ? (link.startsWith('http') ? link : `${frontendUrl}${link}`) : null);

        const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #007bff; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background: #f9f9f9; }
        .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
        .btn { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${title}</h1>
        </div>
        <div class="content">
            <p>您好 ${user.display_name || user.username}，</p>
            <p>${content}</p>
            ${notificationLink ? `<p><a href="${notificationLink}" class="btn">查看详情</a></p>` : ''}
        </div>
        <div class="footer">
            <p>此邮件由 ZeroCat 系统自动发送，请勿回复。</p>
            ${notificationLink ? `<p><a href="${notificationLink}">在浏览器中查看</a></p>` : ''}
        </div>
    </div>
</body>
</html>`;

        await sendEmail(user.email, title, emailHtml, { notificationId });

        return {
            success: true,
            email: user.email,
            notificationId
        };
    } catch (error) {
        logger.error('发送邮件通知失败:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * 管理员统一通知发送接口
 * 支持多种接收者类型、单发和批量发送、多渠道推送等
 *
 * @param {Object} unifiedData - 统一发送数据
 * @param {Array} unifiedData.recipients - 接收者列表
 * @param {string} unifiedData.recipientType - 接收者类型 'user_id' | 'username' | 'email'
 * @param {Object} unifiedData.notificationConfig - 通知配置
 * @param {number} unifiedData.adminId - 管理员ID
 * @returns {Promise<Object>} 发送结果
 */
export async function adminSendUnified(unifiedData) {
    try {
        const { recipients, recipientType = 'user_id', notificationConfig, adminId } = unifiedData;

        const results = {
            total: recipients.length,
            successful: [],
            failed: [],
            errors: [],
            config: {
                recipient_type: recipientType,
                push_channels: notificationConfig.pushChannels,
                hidden: notificationConfig.hidden,
                admin_id: adminId
            }
        };

        // 解析接收者为用户ID
        const resolvedUserIds = await resolveRecipients(recipients, recipientType);

        // 批量发送通知
        for (let i = 0; i < resolvedUserIds.length; i++) {
            const recipientInfo = resolvedUserIds[i];
            const originalRecipient = recipients[i];

            try {
                if (!recipientInfo.userId) {
                    throw new Error(recipientInfo.error || '无效的接收者');
                }

                // 发送增强通知
                const result = await sendEnhancedNotification({
                    userId: recipientInfo.userId,
                    title: notificationConfig.title,
                    content: notificationConfig.content,
                    link: notificationConfig.link,
                    notificationRequirement: notificationConfig.notificationRequirement || 'BASIC',
                    pushChannels: notificationConfig.pushChannels,
                    hidden: notificationConfig.hidden,
                    actorId: notificationConfig.actorId,
                    targetType: notificationConfig.targetType,
                    targetId: notificationConfig.targetId,
                    metadata: {
                        ...notificationConfig.metadata,
                        original_recipient: originalRecipient,
                        recipient_type: recipientType,
                        unified_send: true
                    }
                });

                results.successful.push({
                    original_recipient: originalRecipient,
                    user_id: recipientInfo.userId,
                    username: recipientInfo.username,
                    notification_id: result.notification.id,
                    channels: notificationConfig.pushChannels
                });

            } catch (error) {
                results.failed.push(originalRecipient);
                results.errors.push({
                    original_recipient: originalRecipient,
                    user_id: recipientInfo?.userId || null,
                    error: error.message
                });
                logger.warn(`向接收者 ${originalRecipient} 发送统一通知失败:`, error.message);
            }
        }

        logger.info(`管理员 ${adminId} 统一通知发送完成: 成功 ${results.successful.length}/${results.total}`);
        return results;

    } catch (error) {
        logger.error('管理员统一通知发送失败:', error);
        throw error;
    }
}

/**
 * 解析接收者为用户ID
 * @param {Array} recipients - 接收者列表
 * @param {string} recipientType - 接收者类型
 * @returns {Promise<Array>} 解析结果数组
 */
async function resolveRecipients(recipients, recipientType) {
    const field = { user_id: 'id', username: 'username', email: 'email' }[recipientType];
    if (!field) return recipients.map(() => ({ userId: null, error: `不支持的接收者类型: ${recipientType}` }));
    const keys = recipients.map(recipient => field === 'id' ? Number(recipient) : String(recipient));
    const validKeys = [...new Set(keys.filter(key => field !== 'id' || (Number.isInteger(key) && key >= -2147483648 && key <= 2147483647)))];
    if (!validKeys.length) return recipients.map(recipient => ({ userId: null, error: `找不到${recipientType}: ${recipient}` }));
    const userMap = new Map();
    const errors = new Map();
    for (let offset = 0; offset < validKeys.length; offset += 1000) {
        const batch = validKeys.slice(offset, offset + 1000);
        try {
            const users = await prisma.ow_users.findMany({
                where: { [field]: { in: batch } },
                select: { id: true, username: true, display_name: true, ...(field === 'email' ? { email: true } : {}) },
            });
            for (const user of users) {
                if (!userMap.has(user[field])) userMap.set(user[field], user);
            }
        } catch (error) {
            for (const key of batch) errors.set(key, error.message);
        }
    }
    return recipients.map((recipient, index) => {
        const key = keys[index];
        if (errors.has(key)) return { userId: null, error: `解析${recipientType} ${recipient}时出错: ${errors.get(key)}` };
        const user = userMap.get(key);
        return user ? {
            userId: user.id, username: user.username, displayName: user.display_name, email: user.email || null,
        } : { userId: null, error: `找不到${recipientType}: ${recipient}` };
    });
}

/**
 * 获取所有通知的增强管理视图（管理员权限）
 * 支持隐藏通知和推送错误过滤
 *
 * @param {Object} options - 查询选项
 * @param {number} [options.limit] - 返回的最大通知数量
 * @param {number} [options.offset] - 分页偏移量
 * @param {string} [options.userId] - 筛选特定用户的通知
 * @param {string} [options.notificationType] - 筛选特定类型的通知
 * @param {boolean} [options.unreadOnly] - 是否只获取未读通知
 * @param {boolean} [options.hiddenOnly] - 是否只获取隐藏通知
 * @param {boolean} [options.pushErrorOnly] - 是否只获取推送错误的通知
 * @param {string} [options.dateFrom] - 开始日期筛选
 * @param {string} [options.dateTo] - 结束日期筛选
 * @returns {Promise<Object>} 通知列表及统计信息
 */
export async function getAdminNotificationsListEnhanced(options) {
    try {
        const {
            limit = 50,
            offset = 0,
            userId,
            notificationType,
            unreadOnly = false,
            hiddenOnly = false,
            pushErrorOnly = false,
            dateFrom,
            dateTo
        } = options;

        // 构建查询条件
        const whereConditions = {};

        if (userId) {
            whereConditions.user_id = Number(userId);
        }

        if (notificationType) {
            whereConditions.notification_type = notificationType;
        }

        if (unreadOnly) {
            whereConditions.read = false;
        }

        if (hiddenOnly) {
            whereConditions.hidden = true;
        }

        if (pushErrorOnly) {
            whereConditions.push_error = true;
        }

        if (dateFrom || dateTo) {
            whereConditions.created_at = {};
            if (dateFrom) {
                whereConditions.created_at.gte = new Date(dateFrom);
            }
            if (dateTo) {
                whereConditions.created_at.lte = new Date(dateTo);
            }
        }

        // 获取通知列表
        const notifications = await prisma.ow_notifications.findMany({
            where: whereConditions,
            orderBy: {
                created_at: "desc",
            },
            select: {
                id: true,
                user_id: true,
                title: true,
                content: true,
                link: true,
                metadata: true,
                notification_type: true,
                read: true,
                created_at: true,
                read_at: true,
                high_priority: true,
                hidden: true,
                push_channels: true,
                push_results: true,
                push_error: true,
                data: true,
                actor_id: true,
                target_type: true,
                target_id: true,
                actor: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        avatar: true,
                    },
                },
            },
            take: limit,
            skip: offset,
        });

        // 获取用户信息（批量查询优化）
        const userIds = [...new Set(notifications.map(n => n.user_id))];
        const users = await prisma.ow_users.findMany({
            where: {
                id: { in: userIds }
            },
            select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
            }
        });
        const userMap = users.reduce((map, user) => {
            map[user.id] = user;
            return map;
        }, {});

        // 格式化通知数据
        const formattedNotifications = notifications.map((notification) => ({
            id: Number(notification.id),
            user_id: notification.user_id,
            user: userMap[notification.user_id] || null,
            title: notification.title,
            content: notification.content,
            link: notification.link,
            metadata: notification.metadata,
            type: notification.notification_type,
            read: notification.read,
            created_at: notification.created_at,
            read_at: notification.read_at,
            high_priority: notification.high_priority,
            hidden: notification.hidden,
            push_channels: notification.push_channels,
            push_results: notification.push_results,
            push_error: notification.push_error,
            data: notification.data || {},
            actor_id: notification.actor_id,
            actor: notification.actor,
            target_type: notification.target_type,
            target_id: notification.target_id,
        }));

        // 获取总数
        const totalCount = await prisma.ow_notifications.count({
            where: whereConditions,
        });

        // 获取增强统计信息
        const stats = await getEnhancedNotificationStats();

        return {
            notifications: formattedNotifications,
            total: totalCount,
            limit,
            offset,
            stats,
            filters: {
                userId,
                notificationType,
                unreadOnly,
                hiddenOnly,
                pushErrorOnly,
                dateFrom,
                dateTo
            }
        };
    } catch (error) {
        logger.error("获取增强管理员通知列表出错:", error);
        throw error;
    }
}

/**
 * 获取增强的通知统计信息
 *
 * @returns {Promise<Object>} 统计数据
 */
async function getNotificationCountSummary() {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [counts] = await prisma.$queryRaw`
        SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE read = false) AS unread,
            COUNT(*) FILTER (WHERE hidden = true) AS hidden,
            COUNT(*) FILTER (WHERE push_error = true) AS push_error,
            COUNT(*) FILTER (WHERE created_at >= ${today}) AS today,
            COUNT(*) FILTER (WHERE created_at >= ${week}) AS week
        FROM ow_notifications
    `;
    return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
}

function getNotificationTypeStats() {
    return prisma.ow_notifications.groupBy({
        by: ['notification_type'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
    });
}

export async function getEnhancedNotificationStats() {
    try {
        const [counts, typeStats, channelStats] = await Promise.all([
            getNotificationCountSummary(),
            getNotificationTypeStats(),
            prisma.ow_notifications.groupBy({
                by: ['push_channels'],
                _count: { _all: true },
            }),
        ]);
        const channelCount = new Map();
        for (const row of channelStats) {
            if (!Array.isArray(row.push_channels)) continue;
            for (const channel of row.push_channels) {
                const key = String(channel);
                channelCount.set(key, (channelCount.get(key) || 0) + row._count._all);
            }
        }
        return {
            ...counts,
            byType: typeStats.map(stat => ({ type: stat.notification_type, count: stat._count.id })),
            byChannel: [...channelCount].map(([channel, count]) => ({ channel, count })),
        };
    } catch (error) {
        logger.error("获取增强通知统计信息出错:", error);
        throw error;
    }
}

/**
 * 获取所有通知的管理视图（管理员权限）
 *
 * @param {Object} options - 查询选项
 * @param {number} [options.limit] - 返回的最大通知数量
 * @param {number} [options.offset] - 分页偏移量
 * @param {string} [options.userId] - 筛选特定用户的通知
 * @param {string} [options.notificationType] - 筛选特定类型的通知
 * @param {boolean} [options.unreadOnly] - 是否只获取未读通知
 * @param {string} [options.dateFrom] - 开始日期筛选
 * @param {string} [options.dateTo] - 结束日期筛选
 * @returns {Promise<Object>} 通知列表及统计信息
 */
export async function getAdminNotificationsList(options) {
    try {
        const {
            limit = 50,
            offset = 0,
            userId,
            notificationType,
            unreadOnly = false,
            dateFrom,
            dateTo
        } = options;

        // 构建查询条件
        const whereConditions = {};

        if (userId) {
            whereConditions.user_id = Number(userId);
        }

        if (notificationType) {
            whereConditions.notification_type = notificationType;
        }

        if (unreadOnly) {
            whereConditions.read = false;
        }

        if (dateFrom || dateTo) {
            whereConditions.created_at = {};
            if (dateFrom) {
                whereConditions.created_at.gte = new Date(dateFrom);
            }
            if (dateTo) {
                whereConditions.created_at.lte = new Date(dateTo);
            }
        }

        // 获取通知列表
        const notifications = await prisma.ow_notifications.findMany({
            where: whereConditions,
            orderBy: {
                created_at: "desc",
            },
            select: {
                id: true,
                user_id: true,
                title: true,
                content: true,
                link: true,
                metadata: true,
                notification_type: true,
                read: true,
                created_at: true,
                read_at: true,
                high_priority: true,
                data: true,
                actor_id: true,
                target_type: true,
                target_id: true,
                actor: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        avatar: true,
                    },
                },
            },
            take: limit,
            skip: offset,
        });

        // 获取用户信息（批量查询优化）
        const userIds = [...new Set(notifications.map(n => n.user_id))];
        const users = await prisma.ow_users.findMany({
            where: {
                id: { in: userIds }
            },
            select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
            }
        });
        const userMap = users.reduce((map, user) => {
            map[user.id] = user;
            return map;
        }, {});

        // 格式化通知数据
        const formattedNotifications = notifications.map((notification) => ({
            id: Number(notification.id),
            user_id: notification.user_id,
            user: userMap[notification.user_id] || null,
            title: notification.title,
            content: notification.content,
            link: notification.link,
            metadata: notification.metadata,
            type: notification.notification_type,
            read: notification.read,
            created_at: notification.created_at,
            read_at: notification.read_at,
            high_priority: notification.high_priority,
            data: notification.data || {},
            actor_id: notification.actor_id,
            actor: notification.actor,
            target_type: notification.target_type,
            target_id: notification.target_id,
        }));

        // 获取总数
        const totalCount = await prisma.ow_notifications.count({
            where: whereConditions,
        });

        // 获取统计信息
        const stats = await getNotificationStats();

        return {
            notifications: formattedNotifications,
            total: totalCount,
            limit,
            offset,
            stats,
            filters: {
                userId,
                notificationType,
                unreadOnly,
                dateFrom,
                dateTo
            }
        };
    } catch (error) {
        logger.error("获取管理员通知列表出错:", error);
        throw error;
    }
}

/**
 * 获取通知统计信息
 *
 * @returns {Promise<Object>} 统计数据
 */
export async function getNotificationStats() {
    try {
        const [counts, typeStats] = await Promise.all([
            getNotificationCountSummary(),
            getNotificationTypeStats(),
        ]);

        return {
            total: counts.total,
            unread: counts.unread,
            today: counts.today,
            week: counts.week,
            byType: typeStats.map(stat => ({
                type: stat.notification_type,
                count: stat._count.id
            }))
        };
    } catch (error) {
        logger.error("获取通知统计信息出错:", error);
        throw error;
    }
}

/**
 * 获取用户对特定目标的通知设置
 * @param {number} userId - 用户ID
 * @param {string} targetType - 目标类型
 * @param {string} targetId - 目标ID
 * @returns {Promise<Object|null>}
 */
export async function getNotificationSetting(userId, targetType, targetId) {
    const normalizedTargetType = normalizeTargetTypeForSettings(targetType);
    if (!userId || !normalizedTargetType || !targetId) {
        return null;
    }
    return prisma.ow_notification_settings.findUnique({
        where: {
            user_id_target_type_target_id: {
                user_id: userId,
                target_type: normalizedTargetType,
                target_id: String(targetId),
            },
        },
    });
}

/**
 * 更新或创建用户对特定目标的通知设置
 * @param {Object} settingData - 设置数据
 * @param {number} settingData.userId - 用户ID
 * @param {string} settingData.targetId - 目标ID
 * @param {string} settingData.targetType - 目标类型
 * @param {string} settingData.level - 通知级别
 * @returns {Promise<Object>}
 */
export async function updateNotificationSetting({ userId, targetId, targetType, level }) {
    // 1. 验证输入
    const normalizedTargetType = normalizeTargetTypeForSettings(targetType);
    if (!normalizedTargetType) {
        throw new Error(`无效的目标类型: ${targetType}`);
    }

    const normalizedLevel = normalizeNotificationLevel(level);
    if (NOTIFICATION_LEVEL_ORDER[normalizedLevel] === undefined) {
        throw new Error(`无效的通知级别: ${level}`);
    }

    // 2. 验证目标是否存在
    let targetExists = false;
    const numericTargetId = Number(targetId);
    if (isNaN(numericTargetId)) {
        throw new Error("目标ID必须是数字");
    }

    switch (normalizedTargetType) {
        case 'USER':
            const user = await prisma.ow_users.findUnique({ where: { id: numericTargetId } });
            if (user) targetExists = true;
            break;
        case 'PROJECT':
            const project = await prisma.ow_projects.findUnique({ where: { id: numericTargetId } });
            if (project) targetExists = true;
            break;
        default:
            throw new Error(`未处理的目标类型: ${targetType}`);
    }

    if (!targetExists) {
        throw new Error(`目标不存在: ${targetType} with ID ${targetId}`);
    }

    // 3. Upsert 设置
    const setting = await prisma.ow_notification_settings.upsert({
        where: {
            user_id_target_type_target_id: {
                user_id: userId,
                target_type: normalizedTargetType,
                target_id: String(targetId),
            },
        },
        update: {
            level: normalizedLevel,
        },
        create: {
            user_id: userId,
            target_id: String(targetId),
            target_type: normalizedTargetType,
            level: normalizedLevel,
        },
    });

    return setting;
}

/**
 * 获取用户的通知设置列表
 * @param {Object} options - 查询选项
 * @param {number} options.userId - 用户ID
 * @param {string} [options.targetType] - 目标类型过滤
 * @param {string[]} [options.targetIds] - 目标ID过滤
 * @param {number} [options.limit] - 返回条数
 * @param {number} [options.offset] - 偏移
 * @returns {Promise<Object>}
 */
export async function listNotificationSettings({ userId, targetType, targetIds, limit = 50, offset = 0 }) {
    const normalizedTargetType = normalizeTargetTypeForSettings(targetType);
    const where = {
        user_id: userId,
        ...(normalizedTargetType ? { target_type: normalizedTargetType } : {}),
        ...(Array.isArray(targetIds) && targetIds.length > 0
            ? { target_id: { in: targetIds.map((id) => String(id)) } }
            : {})
    };

    const [settings, total] = await Promise.all([
        prisma.ow_notification_settings.findMany({
            where,
            orderBy: { updated_at: "desc" },
            take: limit,
            skip: offset
        }),
        prisma.ow_notification_settings.count({ where })
    ]);

    return {
        settings,
        total,
        limit,
        offset
    };
}

/**
 * 获取用户已修改的通知设置（仅返回非默认等级）
 * @param {Object} options - 查询选项
 * @param {number} options.userId - 用户ID
 * @param {string} [options.targetType] - 目标类型过滤
 * @param {string[]} [options.targetIds] - 目标ID过滤
 * @returns {Promise<Object>}
 */
export async function listChangedNotificationSettings({ userId, targetType, targetIds }) {
    const normalizedTargetType = normalizeTargetTypeForSettings(targetType);
    const where = {
        user_id: userId,
        level: { notIn: ["BASIC", "DEFAULT"] },
        ...(normalizedTargetType ? { target_type: normalizedTargetType } : {}),
        ...(Array.isArray(targetIds) && targetIds.length > 0
            ? { target_id: { in: targetIds.map((id) => String(id)) } }
            : {})
    };

    const settings = await prisma.ow_notification_settings.findMany({
        where,
        orderBy: { updated_at: "desc" }
    });

    return {
        settings,
        total: settings.length
    };
}

/**
 * 获取通知设置元数据
 * @returns {Object}
 */
export function getNotificationSettingsMetadata() {
    return {
        target_types: ["USER", "PROJECT"],
        levels: ["NONE", "BASIC", "ENHANCED", "ALL"]
    };
}

export default {
    NotificationTemplates,
    createNotification,
    sendNotification,
    sendEnhancedNotification,
    getUserNotifications,
    markNotificationsAsRead,
    getUnreadNotificationCount,
    deleteNotifications,
    formatNotificationForClient,
    getNotificationTemplates,
    adminSendUnified,
    getAdminNotificationsList,
    getAdminNotificationsListEnhanced,
    getNotificationStats,
    getEnhancedNotificationStats,
    getNotificationSetting,
    updateNotificationSetting,
    listNotificationSettings,
    listChangedNotificationSettings,
    getNotificationSettingsMetadata,
};
