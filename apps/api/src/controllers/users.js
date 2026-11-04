import logger from "../services/logger.js";
import {prisma} from "../services/prisma.js";
import gorseService from "../services/gorse.js";
import { buildAvatarURL } from "../utils/avatarUrl.js";
import {validateUsername} from "../services/global.js";
import { visibleWhere, assertCanWrite } from "../services/moderation/visibility.js";

export async function sanitizeFeaturedProjectsBatch(users, viewerId = null) {
    const projectIds = [...new Set(users.filter(user => user?.featured_projects).map(user => Number(user.featured_projects)))];
    if (!projectIds.length) return users;
    const visibility = await visibleWhere("project", viewerId);
    const visibleIds = new Set();
    for (let offset = 0; offset < projectIds.length; offset += 1000) {
        const projects = await prisma.ow_projects.findMany({
            where: { id: { in: projectIds.slice(offset, offset + 1000) }, AND: [visibility] },
            select: { id: true },
        });
        for (const project of projects) visibleIds.add(project.id);
    }
    return users.map(user => user?.featured_projects
        ? { ...user, featured_projects: visibleIds.has(Number(user.featured_projects)) ? Number(user.featured_projects) : null }
        : user);
}

export async function sanitizeFeaturedProjects(user, viewerId = null) {
    if (!user?.featured_projects) return user;
    const project = await prisma.ow_projects.findFirst({
        where: { id: Number(user.featured_projects), AND: [await visibleWhere('project', viewerId)] },
        select: { id: true },
    });
    return { ...user, featured_projects: project?.id ?? null };
}

/**
 * Get users by list of IDs
 * @param {Array<number>} userIds - List of user IDs
 * @returns {Promise<Array<User>>}
 */
async function getUsersByList(userIds, viewerId = null) {
    const select = {
        id: true,
        username: true,
        display_name: true,
        status: true,
        regTime: true,
        bio: true,

        avatar: true,
    };

    // Get each user's info
    const users = await prisma.ow_users.findMany({
        where: {
            id: {in: userIds.map((id) => parseInt(id, 10))},
            AND: [await visibleWhere("profile", viewerId)],
        },
        select,
    });

    return await Promise.all(users.map(async (u) => ({
        ...u,
        avatarURL: await buildAvatarURL(u.avatar),
    })));
}

// 获取用户信息通过用户名
export async function getUserByUsername(username, viewerId = null) {
    try {
        const user = await prisma.ow_users.findFirst({
            where: {username, AND: [await visibleWhere("profile", viewerId)]},
            select: {
                id: true,
                username: true,
                display_name: true,
                status: true,
                regTime: true,
                bio: true,
                avatar: true,
            }
        });
        if (!user) return user;
        return { ...user, avatarURL: await buildAvatarURL(user.avatar) };
    } catch (err) {
        logger.error("Error fetching user by username:", err);
        throw err;
    }
}

export {getUsersByList};

/**
 * 用户选择字段
 * @returns {Object}
 */
export function userSelectionFields() {
    return {
        id: true,
        username: true,
        display_name: true,
        status: true,
        regTime: true,
        bio: true,
        avatar: true,
        location: true,
        region: true,
        url: true,
        custom_status: true,
    };
}

/**
 * 获取推荐用户
 * @param {number} userId - 当前用户ID
 * @param {Object} options - 选项
 * @param {number} options.limit - 返回数量，默认20
 * @param {number} options.offset - 偏移量，默认0
 * @returns {Promise<Object>} 推荐用户列表及分页信息
 */
export async function getRecommendedUsersForUser({ userId, limit = 20, offset = 0 }) {
    const nUserId = Number(userId);
    if (!Number.isInteger(nUserId) || nUserId <= 0) {
        throw new Error("无效的用户 ID");
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const ADMIN_USER_ID = 1; // 始终推荐的管理员用户ID
    let needToInsertAdmin = false;
    let adminUser = null;

    // 仅在第一页时检查是否需要插入管理员用户
    if (safeOffset === 0 && nUserId !== ADMIN_USER_ID) {
        // 检查当前用户是否已关注用户1
        const isFollowing = await prisma.ow_user_relationships.findFirst({
            where: {
                source_user_id: nUserId,
                target_user_id: ADMIN_USER_ID,
                relationship_type: "follow",
            },
        });

        if (!isFollowing) {
            // 获取管理员用户信息
            adminUser = await prisma.ow_users.findFirst({
                where: { id: ADMIN_USER_ID, AND: [await visibleWhere("profile", nUserId)] },
                select: userSelectionFields(),
            });

            if (adminUser && adminUser.status === "active") {
                needToInsertAdmin = true;
            }
        }
    }

    // 从 Gorse 获取推荐用户 ID
    // 如果需要插入管理员，减少请求数量以留出空间
    const requestLimit = needToInsertAdmin ? safeLimit - 1 : safeLimit;
    const recommendedUserIds = await gorseService.getRecommendedUserIds(nUserId, {
        limit: requestLimit,
        offset: safeOffset,
    });

    if (!recommendedUserIds || recommendedUserIds.length === 0) {
        // 如果 Gorse 没有推荐结果，但需要推荐管理员用户
        if (needToInsertAdmin && adminUser) {
            return {
                users: [{ ...adminUser, avatarURL: await buildAvatarURL(adminUser.avatar) }],
                total_candidates: 1,
                offset: safeOffset,
                limit: safeLimit,
                has_more: false,
            };
        }

        return {
            users: [],
            total_candidates: 0,
            offset: safeOffset,
            limit: safeLimit,
            has_more: false,
            message: "Gorse 暂无推荐结果",
        };
    }

    // 获取推荐用户的详细信息，排除当前用户
    const users = await prisma.ow_users.findMany({
        where: {
            id: { in: recommendedUserIds },
            AND: [await visibleWhere("profile", nUserId)],
            status: "active",
            NOT: { id: nUserId }, // 不包括当前用户
        },
        select: userSelectionFields(),
    });

    // 按 Gorse 推荐顺序排序
    const userMap = new Map(users.map((user) => [Number(user.id), user]));
    const ordered = recommendedUserIds
        .map((id) => userMap.get(Number(id)))
        .filter(Boolean);

    // 如果需要插入管理员用户，检查是否已经在列表中
    if (needToInsertAdmin && adminUser) {
        const adminExists = ordered.some((user) => user.id === ADMIN_USER_ID);
        if (!adminExists) {
            // 将管理员用户插入到列表开头
            ordered.unshift(adminUser);
        }
    }

    // 限制返回数量
    const pagedUsers = ordered.slice(0, safeLimit);

    const pagedUsersWithAvatarURL = await Promise.all(pagedUsers.map(async (u) => ({
        ...u,
        avatarURL: await buildAvatarURL(u.avatar),
    })));

    return {
        users: pagedUsersWithAvatarURL,
        total_candidates: pagedUsersWithAvatarURL.length,
        offset: safeOffset,
        limit: safeLimit,
        has_more: ordered.length > safeLimit,
    };
}

/**
 * 修改用户名
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export const changeUsername = async (req, res) => {
    try {
        const userId = res.locals.userid;
        await assertCanWrite(userId, "profile", "update");
        const { newUsername } = req.body;

        if (!newUsername || typeof newUsername !== "string" || newUsername.trim().length === 0) {
            return res.status(400).json({
                status: "error",
                message: "新用户名不能为空",
                code: "INVALID_USERNAME"
            });
        }

        const trimmedUsername = newUsername.trim().toLowerCase();

        // 验证用户名格式
        const validation = validateUsername(trimmedUsername);
        if (!validation.valid) {
            return res.status(400).json({
                status: "error",
                message: validation.message,
                code: "INVALID_USERNAME"
            });
        }

        // 检查用户名是否已被使用
        const existingUser = await prisma.ow_users.findFirst({
            where: { username: trimmedUsername }
        });

        if (existingUser) {
            return res.status(409).json({
                status: "error",
                message: "用户名已被使用",
                code: "USERNAME_TAKEN"
            });
        }

        // 更新用户名
        await prisma.ow_users.update({
            where: { id: userId },
            data: { username: trimmedUsername }
        });

        logger.info(`用户 ${userId} 修改用户名为: ${trimmedUsername}`);

        res.json({
            status: "success",
            message: "用户名修改成功"
        });
    } catch (error) {
        logger.error("修改用户名时出错:", error);
        res.status(error.statusCode || error.status || 500).json({
            status: "error",
            message: error.statusCode ? error.message : "修改用户名失败",
            code: error.code || "CHANGE_USERNAME_FAILED"
        });
    }
};
