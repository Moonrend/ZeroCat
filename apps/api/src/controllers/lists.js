import { prisma } from '../services/prisma.js'
import logger from "../services/logger.js";
import { visibleWhere, canViewContent, assertCanWrite, sanitizeProfiles } from "../services/moderation/visibility.js";
import { authorizeResourceOperation } from "../services/auth/resourceOperation.js";

async function ensureListOwner(userId, listId, action, authorizationContext) {
    const decision = await authorizeResourceOperation(userId, "list", listId, action, authorizationContext);
    if (decision.principalId !== Number(userId)) await assertCanWrite(decision.principalId, "lists", action);
    const list = await prisma.ow_projects_lists.findFirst({
        where: { id: Number(listId), ...(!decision.allowed || decision.delegationId != null ? { authorid: decision.principalId } : {}),
            AND: [await visibleWhere("list", userId, { ignorePrivacy: true })] },
    });
    if (!list) throw Object.assign(new Error("列表不存在或无权限"), { statusCode: 404, code: "NOT_FOUND" });
    return list;
}

/**
 * Get a project list by ID
 * @param {number} listId - The list ID
 * @param {number} userId - The current user ID
 * @returns {Promise<object>} - The list with projects
 */
export async function getProjectList(listId, userId, authorizationContext) {
    try {
        // Get the list
        const list = await prisma.ow_projects_lists.findUnique({
            where: {id: parseInt(listId)}
        });

        if (!list) return null;

        let decision;
        if (authorizationContext && (authorizationContext.delegationId !== undefined || list.state !== "public")) {
            decision = await authorizeResourceOperation(userId, "list", list.id, "read", authorizationContext);
        }
        if (list.state !== "public" && (!decision?.allowed || decision.delegationId != null)
            && list.authorid !== (decision?.principalId ?? Number(userId))) return null;
        if (!await canViewContent("list", list, userId, { ignorePrivacy: true })) return null;

        // Filter through list membership without loading the intermediate item rows.
        const projects = await prisma.ow_projects.findMany({
            where: {
                lists: { some: { listid: parseInt(listId) } },
                AND: [await visibleWhere("project", userId)],
                OR: [{ state: "public" }, ...(userId ? [{ authorid: Number(userId) }] : [])],
            },
            select: {
                id: true,
                title: true,
                description: true,
                authorid: true,
                state: true,
                view_count: true,
                like_count: true,
                star_count: true,
                time: true,
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        bio: true,

                        avatar: true,
                        regTime: true,
                    },
                },
            }
        });

        const authors = await sanitizeProfiles(projects.map(project => project.author), userId);
        projects.forEach((project, index) => { project.author = authors[index]; });
        return {
            ...list,
            projects
        };
    } catch (error) {
        logger.error("Error in getProjectList:", error);
        throw error;
    }
}

/**
 * Get a user's lists and check if a project is in any of them
 * @param {number} userId - The user ID
 * @param {number} projectId - The project ID
 * @returns {Promise<object>} - The user's lists with project status
 */
export async function getUserListInfoAndCheak(userId, projectId) {
    try {
        if (!userId) {
            return [];
        }

        return await prisma.$queryRaw`
            SELECT l.*, EXISTS (
                SELECT 1 FROM ow_projects_list_items i
                WHERE i.listid = l.id AND i.projectid = ${parseInt(projectId)}
            ) AS "hasProject"
            FROM ow_projects_lists l
            WHERE l.authorid = ${parseInt(userId)}
        `;
    } catch (error) {
        logger.error("Error in getUserListInfoAndCheak:", error);
        throw error;
    }
}

/**
 * Create a new list
 * @param {number} userId - The user ID
 * @param {string} title - The list title
 * @param {string} description - The list description
 * @returns {Promise<object>} - The created list
 */
export async function createList(userId, title, description) {
    await assertCanWrite(Number(userId), "lists", "create");
    try {
        const list = await prisma.ow_projects_lists.create({
            data: {
                authorid: parseInt(userId),
                title,
                description: description || "",
                state: "private",
                updateTime: new Date()
            }
        });

        return list;
    } catch (error) {
        logger.error("Error in createList:", error);
        throw error;
    }
}

/**
 * Delete a list
 * @param {number} userId - The user ID
 * @param {number} listId - The list ID
 * @returns {Promise<object>} - The deleted list
 */
export async function deleteList(userId, listId, authorizationContext) {
    await assertCanWrite(Number(userId), "lists", "delete");
    try {
        const list = await ensureListOwner(userId, listId, "delete", authorizationContext);

        // Delete all list items
        await prisma.ow_projects_list_items.deleteMany({
            where: {listid: parseInt(listId)}
        });

        // Delete the list
        const deletedList = await prisma.ow_projects_lists.delete({
            where: {id: parseInt(listId)}
        });

        return deletedList;
    } catch (error) {
        logger.error("Error in deleteList:", error);
        throw error;
    }
}

/**
 * Add a project to a list
 * @param {number} userId - The user ID
 * @param {number} listId - The list ID
 * @param {number} projectId - The project ID
 * @returns {Promise<object>} - The created list item
 */
export async function addProjectToList(userId, listId, projectId, authorizationContext) {
    await assertCanWrite(Number(userId), "lists", "update");
    const project = await prisma.ow_projects.findFirst({
        where: { id: Number(projectId), AND: [await visibleWhere("project", userId)], OR: [{ state: "public" }, { authorid: Number(userId) }] },
    });
    if (!project) throw Object.assign(new Error("项目不存在"), { statusCode: 404, code: "NOT_FOUND" });
    try {
        const list = await ensureListOwner(userId, listId, "update", authorizationContext);

        // Check if the project is already in the list
        const existingItem = await prisma.ow_projects_list_items.findFirst({
            where: {
                listid: parseInt(listId),
                projectid: parseInt(projectId)
            }
        });

        if (existingItem) {
            return existingItem;
        }

        // Add project to the list
        const listItem = await prisma.ow_projects_list_items.create({
            data: {
                listid: parseInt(listId),
                projectid: parseInt(projectId),
                createTime: new Date()
            }
        });

        // Update the list's update time
        await prisma.ow_projects_lists.update({
            where: {
                id: parseInt(listId)
            },
            data: {
                updateTime: new Date()
            }
        });

        return listItem;
    } catch (error) {
        logger.error("Error in addProjectToList:", error);
        throw error;
    }
}

/**
 * Remove a project from a list
 * @param {number} userId - The user ID
 * @param {number} listId - The list ID
 * @param {number} projectId - The project ID
 * @returns {Promise<object>} - The deleted list item
 */
export async function removeProjectFromList(userId, listId, projectId, authorizationContext) {
    await assertCanWrite(Number(userId), "lists", "update");
    try {
        const list = await ensureListOwner(userId, listId, "update", authorizationContext);

        // Remove the project from the list
        const deletedItem = await prisma.ow_projects_list_items.deleteMany({
            where: {
                listid: parseInt(listId),
                projectid: parseInt(projectId)
            }
        });

        // Update the list's update time
        await prisma.ow_projects_lists.update({
            where: {id: parseInt(listId)},
            data: {updateTime: new Date()}
        });

        return deletedItem;
    } catch (error) {
        logger.error("Error in removeProjectFromList:", error);
        throw error;
    }
}

/**
 * Get a user's lists
 * @param {number} userId - The user ID
 * @returns {Promise<Array>} - The user's lists
 */
export async function getUserListInfo(userId) {
    try {
        if (!userId) {
            return [];
        }

        const lists = await prisma.ow_projects_lists.findMany({
            where: {authorid: parseInt(userId)},
            select: {
                id: true,
                title: true,
                description: true,
                state: true,
                updateTime: true,
                createTime: true,
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        bio: true,

                        avatar: true,
                        regTime: true,
                    },
                },
            },
        });

        return lists;
    } catch (error) {
        logger.error("Error in getUserListInfo:", error);
        throw error;
    }
}

/**
 * Get a user's public lists
 * @param {number} userId - The user ID
 * @param {number} currentUserId - The current user ID
 * @returns {Promise<Array>} - The user's public lists
 */
export async function getUserListInfoPublic(userId, currentUserId) {
    try {
        const where = {authorid: parseInt(userId), AND: [await visibleWhere("list", currentUserId)]};

        // If not the owner, only show public lists
        if (parseInt(userId) !== parseInt(currentUserId)) {
            where.state = "public";
        }

        const lists = await prisma.ow_projects_lists.findMany({
            where, select: {
                id: true,
                title: true,
                description: true,
                state: true,
                updateTime: true,
                createTime: true,
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true,
                        bio: true,

                        avatar: true,
                        regTime: true,
                    },
                },
            }
        });

        const authors = await sanitizeProfiles(lists.map(list => list.author), currentUserId);
        return lists.map((list, index) => ({ ...list, author: authors[index] }));
    } catch (error) {
        logger.error("Error in getUserListInfoPublic:", error);
        throw error;
    }
}

/**
 * Update a list
 * @param {number} userId - The user ID
 * @param {number} listId - The list ID
 * @param {object} data - The update data
 * @returns {Promise<object>} - The updated list
 */
export async function updateList(userId, listId, data, authorizationContext) {
    await assertCanWrite(Number(userId), "lists", "update");
    try {
        const list = await ensureListOwner(userId, listId, "update", authorizationContext);

        // Update the list
        const updatedList = await prisma.ow_projects_lists.update({
            where: {id: parseInt(listId)},
            data: {
                title: data.title || list.title,
                description: data.description || list.description,
                state: data.state || list.state,
                updateTime: new Date()
            }
        });

        return updatedList;
    } catch (error) {
        logger.error("Error in updateList:", error);
        throw error;
    }
}