import logger from "../services/logger.js";
import {prisma} from "../services/prisma.js";

import { readProjectFile, saveProjectFile } from "../services/projectFileStorage.js";
import {getUsersByList} from "./users.js";
import { visibleWhere, sanitizeProfiles } from "../services/moderation/visibility.js";

async function getProjectsByList(list, userid = null) {
    const select = projectSelectionFields();
    const projectIds = list.map(Number);
    const projects = await prisma.ow_projects.findMany({
        where: { AND: [{id: {in: projectIds}}, await visibleWhere("project", userid)] },
        select,
    });
    return sanitizeProjectAuthors(projects, userid);
}

async function getProjectById(projectId, userid = null) {
    const select = projectSelectionFields();
    const project = await prisma.ow_projects.findFirst({
        where: { AND: [{id: Number(projectId)}, await visibleWhere("project", userid)] },
        select,
    });
    if (!project) return null;
    return (await sanitizeProjectAuthors([project], userid))[0];
}

async function sanitizeProjectAuthors(projects, viewerId = null) {
    const forkIds = [...new Set(projects.filter((project) => project.fork).map((project) => Number(project.fork)))];
    const visibleForks = forkIds.length ? await prisma.ow_projects.findMany({
        where: { AND: [{ id: { in: forkIds } }, await visibleWhere("project", viewerId)] },
        select: { id: true },
    }) : [];
    const visibleForkIds = new Set(visibleForks.map((project) => project.id));
    const authors = await sanitizeProfiles(projects.map(project => project.author), viewerId);
    return projects.map((project, index) => ({
        ...project,
        ...(project.fork ? { fork: visibleForkIds.has(Number(project.fork)) ? project.fork : null } : {}),
        author: authors[index],
    }));
}

async function getProjectsAndUsersByProjectsList(list, userid = null) {
    const projects = await getProjectsByList(list, userid);
    const userslist = [...new Set(projects.map((project) => project.authorid))];
    const users = (await sanitizeProfiles(await getUsersByList(userslist, userid), userid)).filter(Boolean);
    return {projects, users};
}

function extractProjectData(body) {
    const fields = [
        "type",
        "license",
        "state",
        "title",
        "description",
        "history",
        "thumbnail",
    ];
    return fields.reduce(
        (acc, field) => (body[field] ? {...acc, [field]: body[field]} : acc),
        {}
    );
}

const extractProjectTags = (tags) =>
    // 如果某项为空，则删除
    Array.isArray(tags)
        ? tags.map(String).filter((tag) => tag)
        : tags
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag);

async function handleTagsChange(projectId, tags) {
    const existingTags = await prisma.ow_projects_tags.findMany({
        where: {projectid: projectId},
        select: {id: true, name: true},
    });
    tags = extractProjectTags(tags);

    const tagNames = new Set(tags);
    const deleteIds = [];
    for (const tag of existingTags) {
        if (!tagNames.delete(tag.name)) deleteIds.push(tag.id);
    }
    const writes = [];
    if (deleteIds.length) {
        writes.push(prisma.ow_projects_tags.deleteMany({ where: { id: { in: deleteIds } } }));
    }
    if (tagNames.size) {
        writes.push(prisma.ow_projects_tags.createMany({
            data: [...tagNames].map((name) => ({ projectid: projectId, name })),
        }));
    }
    if (writes.length) await prisma.$transaction(writes);
}

/**
 * Set project file
 * @param {string | Object} source - Project source
 * @returns {Promise<string>} - SHA256 of the source
 */
async function setProjectFile(source) {
    const sourcedata = isJson(source) ? JSON.stringify(source) : source;
    const file = await saveProjectFile(sourcedata);
    return file.sha256;
}

/**
 * Get project file
 * @param {string} sha256 - SHA256 of the source
 * @returns {Promise<{ source: string }>} - Project source
 */
async function getProjectFile(sha256) {
    const file = await readProjectFile(sha256);
    return file ? { source: file.source } : null;
}

/**
 * Handle error response
 * @param {Response} res - Response object
 * @param {Error} err - Error object
 * @param {string} msg - Error message
 * @returns {void}
 */
function handleError(res, err, msg) {
    logger.error(err);
    res.status(500).send({status: "error", msg, error: err});
}

/**
 * Select project information fields
 * @returns {Object} - Selected fields
 */
function projectSelectionFields() {
    return {
        id: true,
        name: true,
        default_branch: true,
        type: true,
        license: true,
        authorid: true,
        thumbnail: true,
        state: true,
        view_count: true,
        time: true,
        title: true,
        description: true,
        star_count: true,
        fork: true,
        author: {
            select: {
                id: true,
                username: true,
                display_name: true,
                status: true,
                bio: true,

                avatar: true,
                regTime: true,
            },
        },
        project_tags: {
            select: {
                id: true,
                name: true,
            },
        },
    };
}

/**
 * Select author information fields
 * @returns {Object} - Selected fields
 */
function authorSelectionFields() {
    return {
        id: true,
        username: true,
        display_name: true,
        status: true,
        regTime: true,
        bio: true,

        avatar: true,
    };
}

// 工具函数：判断是否为有效 JSON
function isJson(str) {
    try {
        JSON.stringify(str);
        return true;
    } catch (error) {
        logger.debug(error);
        return false;
    }
}

export {
    getProjectsByList,
    sanitizeProjectAuthors,
    getUsersByList,
    getProjectsAndUsersByProjectsList,
    extractProjectData,
    isJson,
    setProjectFile,
    getProjectFile,
    projectSelectionFields,
    authorSelectionFields,
    extractProjectTags,
    handleTagsChange,
    getProjectById,
};
