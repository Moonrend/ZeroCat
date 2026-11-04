import {prisma} from "../services/prisma.js";
import logger from "../services/logger.js";
import {createNotification} from "./notifications.js";
import {EventConfig} from "../config/eventConfig.js";
import { visibleSql, visibleWhere, sanitizeProfiles } from "../services/moderation/visibility.js";

// 重新导出这些常量供外部使用
export {EventConfig};
const DEFAULT_PRIMARY_BRANCH = "main";

const EVENT_NOTIFICATION_POLICIES = {
    post_create: { audience: "actor_subscribers", minLevel: "ENHANCED" },
    project_commit: { audience: "project_subscribers", minLevel: "ALL", includeOwner: true, respectBranch: true },
    project_update: { audience: "project_subscribers", minLevel: "ENHANCED", includeOwner: true },
    project_fork: { audience: "project_subscribers", minLevel: "ENHANCED", includeOwner: true },
    project_create: { audience: "actor_subscribers", minLevel: "ENHANCED" },
    comment_create: { includeOwner: true, includeThreadParticipants: true, includeMentions: true },
    project_rename: { audience: "project_subscribers", minLevel: "ENHANCED", includeOwner: true },
    project_info_update: { audience: "project_subscribers", minLevel: "ENHANCED", includeOwner: true },
    project_delete: { audience: "project_subscribers", minLevel: "ENHANCED", includeOwner: true },
    project_star: { includeOwner: true },
    project_like: { includeOwner: true },
    project_collect: { includeOwner: true },
    user_follow: { includeTargetUser: true },
    comment_reply: { includeCommentAuthor: true, includeMentions: true },
    comment_like: { includeCommentAuthor: true }
};

const PROJECT_EVENT_TYPES = new Set([
    "project_create",
    "project_commit",
    "project_update",
    "project_fork",
    "project_rename",
    "project_info_update",
    "project_delete",
    "project_star",
    "project_like",
    "project_collect"
]);

function normalizeText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function pickFirstText(...values) {
    for (const value of values) {
        const normalized = normalizeText(value);
        if (normalized) return normalized;
    }
    return "";
}

function truncateText(text, maxLength = 80) {
    const normalized = normalizeText(text);
    if (!normalized) return "";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}

function normalizeLinkTargetType(targetType) {
    return normalizeText(targetType).toLowerCase();
}

function generateTargetLinkByType(targetType, targetId) {
    if (!targetType || targetId === null || targetId === undefined) return null;
    const normalizedType = normalizeLinkTargetType(targetType);
    switch (normalizedType) {
        case "project":
            return `/app/link/project?id=${targetId}`;
        case "post":
            return `/app/posts/${targetId}`;
        case "user":
            return `/app/link/user?id=${targetId}`;
        default:
            return null;
    }
}

function appendQueryString(url, queryObject) {
    if (!url || !queryObject) return url;
    const params = new URLSearchParams();
    Object.entries(queryObject).forEach(([key, value]) => {
        const normalized = normalizeText(value);
        if (normalized) params.set(key, normalized);
    });
    const query = params.toString();
    if (!query) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function buildProjectNamespaceLink(target, eventData, actor) {
    const username = pickFirstText(
        eventData.project_author_username,
        target?.author?.username,
        actor?.username
    );

    const projectName = pickFirstText(
        eventData.project_name,
        target?.name,
        eventData.new_name,
        eventData.old_name
    );

    if (!username || !projectName) {
        return null;
    }

    return `/${encodeURIComponent(username)}/${encodeURIComponent(projectName)}`;
}

function buildEventNotificationLink(event, eventData, target, actor) {
    const explicitLink = pickFirstText(
        eventData.notification_link,
        eventData.link,
        eventData.target_url,
        eventData.url
    );
    if (explicitLink) {
        return explicitLink;
    }

    if (PROJECT_EVENT_TYPES.has(event.event_type)) {
        const projectLink = buildProjectNamespaceLink(target, eventData, actor);
        if (!projectLink) {
            return null;
        }

        if (event.event_type === "project_commit") {
            return appendQueryString(projectLink, {
                branch: eventData.branch,
                commitid: eventData.commit_id
            });
        }

        return projectLink;
    }

    if (event.event_type === "user_follow") {
        return generateTargetLinkByType("user", event.actor_id || event.target_id);
    }

    if (
        event.event_type === "comment_create" ||
        event.event_type === "comment_reply" ||
        event.event_type === "comment_like"
    ) {
        if (eventData.post_id) {
            return generateTargetLinkByType("post", eventData.post_id);
        }
        if (eventData.project_id) {
            return generateTargetLinkByType("project", eventData.project_id);
        }

        const commentUrl = pickFirstText(target?.url, target?.link);
        if (commentUrl) {
            return commentUrl;
        }

        if (target?.page_type && target?.page_id) {
            if (target.page_type === "post") {
                return generateTargetLinkByType("post", target.page_id);
            }
            if (target.page_type === "project") {
                return generateTargetLinkByType("project", target.page_id);
            }
        }
    }

    return generateTargetLinkByType(event.target_type, event.target_id);
}

function formatActorName(actor, eventData) {
    return pickFirstText(
        actor?.display_name,
        actor?.username,
        eventData.actor_name,
        eventData.actor_username,
        "有人"
    );
}

function formatProjectName(target, eventData) {
    return pickFirstText(
        eventData.project_title,
        eventData.project_name,
        target?.title,
        target?.name,
        "该项目"
    );
}

function formatSourceProjectName(eventData) {
    return pickFirstText(eventData.source_project_title, eventData.source_project_name, "该项目");
}

function formatCommentPreview(target, eventData) {
    const commentText = pickFirstText(eventData.comment_text, eventData.content, target?.text);
    if (!commentText) return "一条评论";
    return `评论「${truncateText(commentText, 40)}」`;
}

function buildDefaultEventNotificationCopy(event, eventData, actor, target) {
    const actorName = formatActorName(actor, eventData);
    const projectName = formatProjectName(target, eventData);
    const eventType = event.event_type;

    switch (eventType) {
        case "post_create": {
            return {
                title: `${actorName} 发布了新帖子`,
                content:  `${actorName} 发布了新帖子`
            };
        }
        case "project_create":
            return {
                title: `${actorName} 创建了新项目`,
                content: `${actorName} 创建了项目《${projectName}》`
            };
        case "project_commit": {
            const branch = pickFirstText(eventData.branch, "main");
            const commitSummary = pickFirstText(
                eventData.commit_message,
                eventData.message,
                normalizeText(eventData.commit_id).slice(0, 8),
                "一次代码提交"
            );
            return {
                title: `${actorName} 推送了 ${branch} 分支代码`,
                content: `项目《${projectName}》的 ${branch} 分支有新提交：${truncateText(commitSummary, 60)}`
            };
        }
        case "project_update":
        case "project_info_update": {
            const updatedFields = Array.isArray(eventData.updated_fields)
                ? eventData.updated_fields.filter((field) => normalizeText(field))
                : [];
            return {
                title: `${actorName} 更新了项目信息`,
                content: updatedFields.length > 0
                    ? `${actorName} 更新了项目《${projectName}》的 ${updatedFields.join("、")}`
                    : `${actorName} 更新了项目《${projectName}》的信息`
            };
        }
        case "project_rename": {
            const oldName = pickFirstText(eventData.old_name, projectName);
            const newName = pickFirstText(eventData.new_name, projectName);
            return {
                title: `${actorName} 重命名了项目`,
                content: `${actorName} 将项目《${oldName}》重命名为《${newName}》`
            };
        }
        case "project_fork": {
            const sourceProjectName = formatSourceProjectName(eventData);
            return {
                title: `${actorName} 派生了你的项目`,
                content: `${actorName} 将项目《${sourceProjectName}》派生为《${projectName}》`
            };
        }
        case "project_delete":
            return {
                title: `${actorName} 删除了项目`,
                content: `${actorName} 删除了项目《${projectName}》`
            };
        case "project_star":
            return {
                title: `${actorName} 收藏了你的项目`,
                content: `${actorName} 收藏了项目《${projectName}》`
            };
        case "project_like":
            return {
                title: `${actorName} 点赞了你的项目`,
                content: `${actorName} 点赞了项目《${projectName}》`
            };
        case "project_collect":
            return {
                title: `${actorName} 收藏了你的项目`,
                content: `${actorName} 收藏了项目《${projectName}》`
            };
        case "user_follow":
            return {
                title: `${actorName} 开始关注你`,
                content: `${actorName} 开始关注你`
            };
        case "comment_create": {
            const commentPreview = formatCommentPreview(target, eventData);
            return {
                title: `${actorName} 发表了新评论`,
                content: `${actorName} 发表了${commentPreview}`
            };
        }
        case "comment_reply": {
            const commentPreview = formatCommentPreview(target, eventData);
            return {
                title: `${actorName} 回复了你的评论`,
                content: `${actorName} 回复了你：${commentPreview}`
            };
        }
        case "comment_like": {
            const commentPreview = formatCommentPreview(target, eventData);
            return {
                title: `${actorName} 点赞了你的评论`,
                content: `${actorName} 点赞了你发布的${commentPreview}`
            };
        }
        default:
            return {
                title: `${actorName} 有新帖子`,
                content: `${actorName} 触发了 ${eventType} 事件`
            };
    }
}

function normalizeUserIds(values) {
    if (!values) return [];
    const list = Array.isArray(values) ? values : [values];
    return list
        .map((item) => {
            if (item === null || item === undefined) return null;
            if (typeof item === "object") {
                const candidate = item.id ?? item.user_id ?? item.userid;
                return Number(candidate);
            }
            return Number(item);
        })
        .filter((id) => Number.isFinite(id));
}

function getNotificationLevelsAtOrAbove(minLevel) {
    switch (minLevel) {
        case "ALL":
            return ["ALL"];
        case "ENHANCED":
            return ["ENHANCED", "ALL"];
        case "BASIC":
        default:
            return ["BASIC", "ENHANCED", "ALL"];
    }
}

async function getNotificationSubscribers(targetType, targetId, minLevel) {
    if (!targetType || !targetId) return [];
    const levels = getNotificationLevelsAtOrAbove(minLevel);
    const rows = await prisma.ow_notification_settings.findMany({
        where: {
            target_type: targetType,
            target_id: String(targetId),
            level: { in: levels }
        },
        select: { user_id: true }
    });
    return rows.map((row) => row.user_id).filter((id) => id !== null && id !== undefined);
}

async function getProjectOwnerAllSubscribers(projectId) {
    const ownerId = await getProjectOwnerId(projectId);
    if (!ownerId) return [];
    return getNotificationSubscribers("USER", ownerId, "ALL");
}

async function getProjectOwnerId(projectId) {
    if (!projectId) return null;
    const project = await prisma.ow_projects.findUnique({
        where: { id: Number(projectId) },
        select: { authorid: true }
    });
    return project?.authorid ?? null;
}

async function getCommentAuthorId(commentId) {
    if (!commentId) return null;
    const comment = await prisma.ow_comment.findUnique({
        where: { id: Number(commentId) },
        select: { user_id: true }
    });
    return comment?.user_id ?? null;
}

async function getThreadParticipantIds(threadRootId) {
    if (!threadRootId) return [];
    const participants = await prisma.ow_comment.findMany({
        where: { pid: Number(threadRootId) },
        select: { user_id: true }
    });
    return participants
        .map((row) => row.user_id)
        .filter((id) => id !== null && id !== undefined);
}

async function shouldNotifyProjectSubscribers(event, eventData) {
    if (event.event_type !== "project_commit") {
        return true;
    }

    const branch = normalizeText(eventData.branch);
    if (!branch) {
        return true;
    }

    let defaultBranch = normalizeText(eventData.default_branch || eventData.project_default_branch);
    if (!defaultBranch && event.target_type === "project") {
        const project = await prisma.ow_projects.findUnique({
            where: {id: Number(event.target_id)},
            select: {default_branch: true}
        });
        defaultBranch = normalizeText(project?.default_branch);
    }

    const normalizedBranch = branch.toLowerCase();
    const normalizedDefaultBranch = (defaultBranch || DEFAULT_PRIMARY_BRANCH).toLowerCase();
    if (normalizedBranch !== normalizedDefaultBranch) {
        logger.debug(
            `事件 ${event.event_type} 分支 ${branch} 非主分支 ${defaultBranch || DEFAULT_PRIMARY_BRANCH}，仅向核心受众发送通知`
        );
        return false;
    }

    return true;
}

async function resolveEventAudience(event, eventData) {
    if (eventData.NotificationTo) {
        return normalizeUserIds(eventData.NotificationTo);
    }

    const policy = EVENT_NOTIFICATION_POLICIES[event.event_type];
    if (!policy) {
        return [];
    }

    const audience = new Set();
    const actorId = Number(event.actor_id);
    const targetId = Number(event.target_id);

    if (policy.audience === "actor_subscribers") {
        const subscribers = await getNotificationSubscribers("USER", actorId, policy.minLevel || "BASIC");
        subscribers.forEach((id) => audience.add(id));
    }

    if (policy.audience === "project_subscribers") {
        // 用户对某个作者设置 ALL 时，等价于订阅该作者项目的全部通知。
        const ownerAllSubscribers = await getProjectOwnerAllSubscribers(targetId);
        ownerAllSubscribers.forEach((id) => audience.add(id));

        const shouldNotifySubscribers = policy.respectBranch
            ? await shouldNotifyProjectSubscribers(event, eventData)
            : true;
        if (shouldNotifySubscribers) {
            const subscribers = await getNotificationSubscribers("PROJECT", targetId, policy.minLevel || "BASIC");
            subscribers.forEach((id) => audience.add(id));
        }
    }

    if (policy.includeOwner && event.target_type === "project") {
        const ownerId = await getProjectOwnerId(targetId);
        if (ownerId) audience.add(ownerId);
    }

    if (policy.includeTargetUser) {
        if (event.target_type === "user") {
            if (targetId) audience.add(targetId);
        } else if (eventData.target_user) {
            normalizeUserIds(eventData.target_user).forEach((id) => audience.add(id));
        }
    }

    if (policy.includeCommentAuthor && event.target_type === "comment") {
        const authorId = await getCommentAuthorId(targetId);
        if (authorId) audience.add(authorId);
    }

    if (policy.includeThreadParticipants && event.target_type === "comment") {
        const threadRootId = eventData.thread_root_id || eventData.thread_id || targetId;
        const participants = await getThreadParticipantIds(threadRootId);
        participants.forEach((id) => audience.add(id));
    }

    if (policy.includeMentions) {
        normalizeUserIds(eventData.mentioned_users).forEach((id) => audience.add(id));
    }

    normalizeUserIds(eventData.custom_users).forEach((id) => audience.add(id));

    return Array.from(audience);
}

function getEventNotificationRequirement(eventType) {
    const policy = EVENT_NOTIFICATION_POLICIES[eventType];
    if (!policy) return "BASIC";
    if (policy.minLevel === "ALL") return "ALL";
    if (policy.minLevel === "ENHANCED") return "ENHANCED";
    if (policy.minLevel === "BASIC") return "BASIC";
    return "BASIC";
}

/**
 * 创建事件并异步发送通知
 * @param {string} eventType - 事件类型
 * @param {number} actorId - 行为者ID
 * @param {string} targetType - 目标类型
 * @param {number} targetId - 目标ID
 * @param {Object} eventData - 事件数据
 * @returns {Promise<Object|null>} 创建的事件对象
 */
export async function createEvent(eventType, actorId, targetType, targetId, eventData = {}) {
    try {
        const normalizedEventType = eventType.toLowerCase();
        const eventConfig = EventConfig[normalizedEventType];

        if (!eventConfig) {
            logger.warn(`未知的事件类型: ${eventType}`);
            return null;
        }

        // 创建事件记录
        const event = await prisma.ow_events.create({
            data: {
                event_type: normalizedEventType,
                actor_id: Number(actorId),
                target_type: targetType,
                target_id: Number(targetId),
                event_data: {
                    ...eventData,
                    actor_id: Number(actorId),
                    target_type: targetType,
                    target_id: Number(targetId)
                },
                public: eventConfig.public ? true : false
            }
        });

        // 异步处理通知 - 使用 setImmediate 确保事件创建完成后再处理通知
        if (EVENT_NOTIFICATION_POLICIES[normalizedEventType]) {
            setImmediate(() => {
                processNotifications(event, eventConfig, eventData)
                    .catch(error => logger.error('异步通知处理错误:', error));
            });
        }

        return event;
    } catch (error) {
        logger.error('事件创建错误:', error);
        return null;
    }
}

async function readVisibleEvents(filter, limit, offset, includePrivate, viewerId) {
    const params = [];
    const bind = value => { params.push(value); return `$${params.length}`; };
    const visibility = async (kind, alias) => {
        const fragment = await visibleSql(kind, alias, viewerId);
        const start = params.length;
        params.push(...fragment.values);
        return fragment.text.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + start}`);
    };
    const conditions = Object.entries(filter).map(([field, value]) => `e."${field}" = ${bind(value)}`);
    conditions.push(includePrivate && viewerId ? `e.actor_id = ${bind(Number(viewerId))}` : 'e.public = true');
    conditions.push(await visibility('activity', 'e'));
    conditions.push(`EXISTS (SELECT 1 FROM ow_users a WHERE a.id = e.actor_id AND ${await visibility('profile', 'a')})`);

    const targets = [];
    for (const [type, kind, table] of [
        ['project', 'project', 'ow_projects'], ['post', 'post', 'ow_posts'],
        ['user', 'profile', 'ow_users'], ['comment', 'comment', 'ow_comment'],
        ['list', 'list', 'ow_projects_lists'],
    ]) {
        const guard = await visibility(kind, 't');
        const parentGuard = type === 'comment' ? ` AND (
            (t.page_type IS DISTINCT FROM 'project' AND t.page_type IS DISTINCT FROM 'post')
            OR (t.page_type = 'project' AND EXISTS (SELECT 1 FROM ow_projects p WHERE p.id::text = t.page_id AND ${await visibility('project', 'p')}))
            OR (t.page_type = 'post' AND EXISTS (SELECT 1 FROM ow_posts p WHERE p.id::text = t.page_id AND ${await visibility('post', 'p')}))
        )` : '';
        targets.push(`(e.target_type = ${bind(type)} AND EXISTS (SELECT 1 FROM ${table} t WHERE t.id = e.target_id AND ${guard}${parentGuard}))`);
    }
    conditions.push(`(${targets.join(' OR ')})`);
    const take = bind(Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10)));
    const skip = bind(Math.max(0, Number.parseInt(offset, 10) || 0));
    return prisma.$queryRawUnsafe(`SELECT e.* FROM ow_events e WHERE ${conditions.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${take} OFFSET ${skip}`, ...params);
}

/**
 * 获取特定目标的事件
 */
export async function getTargetEvents(targetType, targetId, limit = 10, offset = 0, includePrivate = false, viewerId = null) {
    try {
        const events = await readVisibleEvents({ target_type: targetType, target_id: targetId }, limit, offset, includePrivate, viewerId);
        return await enrichEvents(events, viewerId);
    } catch (error) {
        logger.error('获取目标事件错误:', error);
        return [];
    }
}

/**
 * 获取特定行为者的事件
 */
export async function getActorEvents(actorId, limit = 10, offset = 0, includePrivate = false, viewerId = null) {
    try {
        const events = await readVisibleEvents({ actor_id: actorId }, limit, offset, includePrivate, viewerId);
        return await enrichEvents(events, viewerId);
    } catch (error) {
        logger.error('获取行为者事件错误:', error);
        return [];
    }
}

/**
 * 用行为者和目标信息丰富事件数据
 */
async function enrichEvents(events, viewerId = null) {
    if (!events.length) return [];
    try {
        const actors = await prisma.ow_users.findMany({
            where: {
                id: { in: [...new Set(events.map((event) => Number(event.actor_id)))] },
                AND: [await visibleWhere("profile", viewerId), await visibleWhere("profile", viewerId, { category: "activity" })],
            },
            select: { id: true, username: true, display_name: true, type: true },
        });
        const actorMap = new Map(actors.map((actor) => [actor.id, actor]));
        const definitions = {
            project: { model: "ow_projects", kind: "project", select: {
                id: true, name: true, title: true, state: true, authorid: true,
                author: { select: { id: true, username: true } },
            } },
            post: { model: "ow_posts", kind: "post", select: { id: true, author_id: true, post_type: true, content: true, created_at: true } },
            user: { model: "ow_users", kind: "profile", select: { id: true, username: true, display_name: true, avatar: true } },
            comment: { model: "ow_comment", kind: "comment", select: { id: true, text: true, user_id: true, page_type: true, page_id: true } },
            list: { model: "ow_projects_lists", kind: "list", select: { id: true, title: true, description: true, state: true, authorid: true } },
        };
        const targets = new Map();
        await Promise.all(Object.entries(definitions).map(async ([type, definition]) => {
            const ids = [...new Set(events.filter((event) => actorMap.has(Number(event.actor_id)) && event.target_type === type)
                .map((event) => Number(event.target_id)))];
            if (!ids.length) return;
            const rows = await prisma[definition.model].findMany({
                where: { id: { in: ids }, AND: [await visibleWhere(definition.kind, viewerId)] },
                select: definition.select,
            });
            for (const target of rows) targets.set(`${type}:${target.id}`, target);
        }));

        const parents = new Set();
        await Promise.all(["project", "post"].map(async (type) => {
            const ids = [...new Set([...targets.entries()]
                .filter(([key, target]) => key.startsWith("comment:") && target.page_type === type)
                .map(([, target]) => Number(target.page_id)).filter(Number.isSafeInteger))];
            if (!ids.length) return;
            const rows = await prisma[definitions[type].model].findMany({
                where: { id: { in: ids }, AND: [await visibleWhere(type, viewerId)] },
                select: { id: true },
            });
            for (const parent of rows) parents.add(`${type}:${parent.id}`);
        }));

        const targetEntries = [...targets];
        const authors = await sanitizeProfiles(targetEntries.map(([, target]) => target.author), viewerId);
        targetEntries.forEach(([key, target], index) => {
            if (target.author) targets.set(key, { ...target, author: authors[index] });
        });
        const enriched = events.map((event) => {
            const actor = actorMap.get(Number(event.actor_id));
            const target = targets.get(`${event.target_type}:${event.target_id}`);
            if (!actor || !target) return null;
            if (event.target_type === "comment" && ["project", "post"].includes(target.page_type)
                && !parents.has(`${target.page_type}:${Number(target.page_id)}`)) return null;
            return {
                ...event,
                event_data: {},
                actor,
                target: { type: event.target_type, id: event.target_id, info: target },
            };
        });
        return enriched.filter(Boolean);
    } catch (error) {
        logger.error('丰富事件数据错误:', error);
        return [];
    }
}

/**
 * 获取行为者信息
 */
async function getActor(actorId) {
    try {
        return await prisma.ow_users.findUnique({
            where: {id: Number(actorId)},
            select: {
                id: true,
                username: true,
                display_name: true,
                type: true
            }
        });
    } catch (error) {
        logger.error(`获取行为者 ${actorId} 错误:`, error);
        return null;
    }
}

/**
 * 获取目标信息
 */
async function getTarget(targetType, targetId) {
    try {
        switch (targetType) {
            case "project":
                return await prisma.ow_projects.findUnique({
                    where: {id: Number(targetId)},
                    select: {
                        id: true,
                        name: true,
                        title: true,
                        state: true,
                        authorid: true,
                        author: {
                            select: {
                                id: true,
                                username: true
                            }
                        }
                    }
                });
            case "post":
                return await prisma.ow_posts.findUnique({
                    where: {id: Number(targetId)},
                    select: { id: true, author_id: true, post_type: true, content: true, created_at: true },
                });
            case "user":
                return await prisma.ow_users.findUnique({
                    where: {id: Number(targetId)},
                    select: { id: true, username: true, display_name: true, avatar: true },
                });
            case "comment":
                return await prisma.ow_comment.findUnique({
                    where: {id: Number(targetId)},
                    select: { id: true, text: true, user_id: true, page_type: true, page_id: true },
                });
            case "list":
                return await prisma.ow_projects_lists.findUnique({
                    where: {id: Number(targetId)},
                    select: { id: true, title: true, description: true, state: true, authorid: true },
                });
            default:
                return null;
        }
    } catch (error) {
        logger.error(`获取目标 ${targetType}/${targetId} 错误:`, error);
        return null;
    }
}

/**
 * 处理事件通知
 * 根据事件配置向相关用户发送通知
 * @param {Object} event - 事件对象
 * @param {Object} eventConfig - 事件配置
 * @param {Object} eventData - 事件数据
 */
async function processNotifications(event, eventConfig, eventData) {
    try {
        const actorId = Number(event.actor_id);
        const targetId = Number(event.target_id);
        const notifyUsers = await resolveEventAudience(event, eventData);
        if (notifyUsers.length === 0) {
            logger.debug(`事件 ${event.event_type} 未配置可通知受众`);
            return;
        }

        const notificationRequirement = getEventNotificationRequirement(event.event_type);

        const [actor, target] = await Promise.all([
            getActor(actorId),
            getTarget(event.target_type, targetId)
        ]);

        const generatedCopy = buildDefaultEventNotificationCopy(event, eventData, actor, target);
        const finalTitle = normalizeText(eventData.notification_title) || generatedCopy.title;
        const finalContent = normalizeText(eventData.notification_content) || generatedCopy.content;
        const finalLink = buildEventNotificationLink(event, eventData, target, actor);

        // 收集所有需要通知的用户ID
        const notificationUsers = new Set();
        notifyUsers.forEach(userId => {
            if (userId && userId !== actorId) {
                notificationUsers.add(userId);
            }
        });

        if (notificationUsers.size === 0) {
            logger.debug(`事件 ${event.event_type} 无需要通知的用户`);
            return;
        }

        // 过滤黑名单用户
        const userIds = await filterBlacklistedUsers(actorId, Array.from(notificationUsers));
        if (userIds.length === 0) {
            logger.debug(`事件 ${event.event_type} 所有用户都在黑名单中`);
            return;
        }

        // 批量创建通知
        const notificationPromises = userIds.map(userId =>
            createNotification({
                userId,
                notificationType: event.event_type,
                notificationRequirement,
                actorId,
                targetType: event.target_type,
                targetId,
                ...(finalLink ? {link: finalLink} : {}),
                data: eventData,
                ...(finalTitle ? {title: finalTitle} : {}),
                ...(finalContent ? {content: finalContent} : {})
            }).catch(error => {
                logger.error(`为用户 ${userId} 创建通知失败:`, error);
                return null;
            })
        );

        const results = await Promise.allSettled(notificationPromises);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;

        logger.debug(`事件 ${event.event_type} 通知发送完成: ${successCount}/${userIds.length} 成功`);
    } catch (error) {
        logger.error('通知处理错误:', error);
    }
}

/**
 * 过滤黑名单用户
 */
async function filterBlacklistedUsers(actorId, userIds) {
    if (!userIds.length) return [];

    try {
        // 找出用户间的黑名单关系
        const blacklistRelations = await prisma.ow_user_relationships.findMany({
            where: {
                OR: [
                    // 用户将行为者拉黑
                    {
                        source_user_id: {in: userIds},
                        target_user_id: actorId,
                        relationship_type: 'block'
                    },
                    // 行为者将用户拉黑
                    {
                        source_user_id: actorId,
                        target_user_id: {in: userIds},
                        relationship_type: 'block'
                    }
                ]
            },
            select: {
                source_user_id: true,
                target_user_id: true
            }
        });

        // 创建黑名单用户集合
        const blacklistedUsers = new Set();

        blacklistRelations.forEach(relation => {
            // 如果是用户拉黑行为者，添加用户到黑名单
            if (relation.target_user_id === actorId) {
                blacklistedUsers.add(relation.source_user_id);
            }
            // 如果是行为者拉黑用户，添加用户到黑名单
            else if (relation.source_user_id === actorId) {
                blacklistedUsers.add(relation.target_user_id);
            }
        });

        // 过滤掉黑名单中的用户
        return userIds.filter(userId => !blacklistedUsers.has(userId));
    } catch (error) {
        logger.error('过滤黑名单用户错误:', error);
        return userIds; // 如果出错，返回原始列表
    }
}
