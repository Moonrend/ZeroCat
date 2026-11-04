import { prisma } from '../services/prisma.js';

import logger from "../services/logger.js";
import gorseService from "../services/gorse.js";
import queueManager from '../services/queue/queueManager.js';
import { visibleWhere, canViewContent, assertCanWrite } from '../services/moderation/visibility.js';


/**
 * Star a project for a user
 * @param {number} userId - The user ID
 * @param {number} projectId - The project ID
 * @returns {Promise<object>} - The created star record
 */
export async function starProject(userId, projectId) {
    await assertCanWrite(Number(userId), 'projects', 'interact');
    try {
        const parsedUserId = parseInt(userId);
        const parsedProjectId = parseInt(projectId);

        // 检查项目是否存在
        const project = await prisma.ow_projects.findUnique({
            where: {id: parsedProjectId}
        });

        if (!project || !await canViewContent('project', project, parsedUserId)) {
            throw Object.assign(new Error('项目不存在'), { statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
        }

        // 检查是否已经收藏
        const existingStar = await prisma.ow_projects_stars.findFirst({
            where: {
                userid: parsedUserId,
                projectid: parsedProjectId,
            }
        });

        if (existingStar) {
            return existingStar;
        }

        // 创建收藏
        const star = await prisma.ow_projects_stars.create({
            data: {
                userid: parsedUserId,
                projectid: parsedProjectId,
                createTime: new Date()
            }
        });

        // 更新项目收藏数
        await prisma.ow_projects.update({
            where: {id: parsedProjectId},
            data: {
                star_count: {
                    increment: 1
                }
            }
        });

        // Gorse 反馈：项目收藏
        queueManager.enqueueProjectGorseSync(parsedProjectId, { reason: 'project_star', delayMs: 0 }).catch(e => {
            logger.debug('[gorse] enqueue project gorse sync failed:', e.message);
        });

        gorseService.feedbackProjectStar(parsedUserId, parsedProjectId).catch(e => {
            logger.debug('[gorse] star feedback failed:', e.message);
        });

        return star;
    } catch (error) {
        logger.error("Error in starProject:", error);
        throw error;
    }
}

/**
 * Unstar a project for a user
 * @param {number} userId - The user ID
 * @param {number} projectId - The project ID
 * @returns {Promise<object>} - The deleted star record
 */
export async function unstarProject(userId, projectId) {
    await assertCanWrite(Number(userId), 'projects', 'interact');
    try {
        const parsedUserId = parseInt(userId);
        const parsedProjectId = parseInt(projectId);

        // 检查项目是否存在
        const project = await prisma.ow_projects.findUnique({
            where: {id: parsedProjectId}
        });

        if (!project || !await canViewContent('project', project, parsedUserId)) {
            throw Object.assign(new Error('项目不存在'), { statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
        }

        const star = await prisma.$transaction(async (tx) => {
            const deleted = await tx.ow_projects_stars.deleteMany({
                where: { userid: parsedUserId, projectid: parsedProjectId },
            });
            if (deleted.count > 0) {
                await tx.ow_projects.update({
                    where: { id: parsedProjectId },
                    data: { star_count: { decrement: deleted.count } },
                });
            }
            return deleted;
        });
        if (!star.count) return star;

        // Gorse 反馈：取消项目收藏
        queueManager.enqueueProjectGorseSync(parsedProjectId, { reason: 'project_unstar', delayMs: 0 }).catch(e => {
            logger.debug('[gorse] enqueue project gorse sync failed:', e.message);
        });

        gorseService.feedbackProjectUnstar(parsedUserId, parsedProjectId).catch(e => {
            logger.debug('[gorse] unstar feedback failed:', e.message);
        });

        return star;
    } catch (error) {
        logger.error("Error in unstarProject:", error);
        throw error;
    }
}

/**
 * Check if a user has starred a project
 * @param {number} userId - The user ID
 * @param {number} projectId - The project ID
 * @returns {Promise<boolean>} - True if the user has starred the project
 */
export async function getProjectStarStatus(userId, projectId) {
    try {
        if (!userId) {
            return false;
        }

        const parsedUserId = parseInt(userId);
        const parsedProjectId = parseInt(projectId);

        const star = await prisma.ow_projects_stars.findFirst({
            where: {
                userid: parsedUserId,
                projectid: parsedProjectId,
                project: { is: await visibleWhere('project', parsedUserId) },
            }
        });

        return !!star;
    } catch (error) {
        logger.error("Error in getProjectStarStatus:", error);
        throw error;
    }
}

/**
 * Get the number of stars for a project
 * @param {number} projectId - The project ID
 * @returns {Promise<number>} - The number of stars
 */
export async function getProjectStars(projectId, viewerId = null) {
    try {
        const parsedProjectId = parseInt(projectId);

        const count = await prisma.ow_projects_stars.count({
            where: {
                projectid: parsedProjectId,
                project: { is: await visibleWhere('project', viewerId) },
                user: { is: { AND: [await visibleWhere('profile', viewerId), await visibleWhere('profile', viewerId, { category: 'projects' })] } },
            }
        });

        return count;
    } catch (error) {
        logger.error("Error in getProjectStars:", error);
        throw error;
    }
}
