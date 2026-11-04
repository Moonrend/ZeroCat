import { createHash } from 'crypto';
import { prisma } from '../prisma.js';
import { loadArticleData } from './articleData.js';
import { createInstallationToken } from './githubApp.js';
import { assertSyncAuthorized, loadSyncProject, moderationRemovalProject, syncAuthorizationContext } from './authorization.js';
import { canViewContent, visibleWhere } from '../moderation/visibility.js';
import { ModerationError } from '../moderation/policy.js';
import {
    createBlob,
    createCommit,
    createRef,
    createTree,
    getCommit,
    getRef,
    getRepo,
    getTree,
    updateRef,
} from './githubApi.js';
import { findUserGitLink, readUserConfig, writeUserConfig } from './storage.js';

const BLOG_SETTINGS_KEY = 'blog.sync.settings';
const BLOG_STATE_KEY = 'blog.sync.state';

const DEFAULT_DIRECTORY = 'source/_posts';
const DEFAULT_BRANCH = 'main';

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const isEmptyRepoError = (error) => {
    if (!error) return false;
    if (error.isEmptyRepo) return true;
    if (error.status === 409) return true;
    const message = String(error.message || '');
    return message.includes('Git Repository is empty');
};

const safeSlug = (value) => {
    const name = String(value || '').trim();
    if (!name) return null;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return null;
    if (!/^[0-9A-Za-z._-]+$/.test(name)) return null;
    return name;
};

const safeDirectory = (value, fallback = DEFAULT_DIRECTORY) => {
    if (value === null || value === undefined) return fallback;
    const name = String(value || '').trim().replace(/^\/+|\/+$/g, '');
    if (!name) return '';
    if (name.includes('..') || name.includes('\\')) return fallback;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return fallback;
    return name;
};

const safeBranch = (value, fallback = DEFAULT_BRANCH) => {
    const name = String(value || '').trim();
    if (!name) return fallback;
    if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) return fallback;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return fallback;
    return name;
};

const normalizeFramework = (value) => {
    const f = String(value || '').toLowerCase();
    if (f === 'hugo') return 'hugo';
    if (f === 'valaxy') return 'valaxy';
    return 'hexo';
};

async function fetchArticleProjects(userId) {
    const numericUserId = Number(userId);
    if (!Number.isInteger(numericUserId)) return [];
    return prisma.ow_projects.findMany({
        where: { authorid: numericUserId, type: 'article' },
        select: {
            id: true,
            name: true,
            title: true,
            description: true,
            type: true,
            state: true,
            authorid: true,
            time: true,
            deleted_at: true,
            is_shadowbanned: true,
            shadowban_expires_at: true,
        },
        orderBy: { time: 'desc' },
    });
}

export async function getBlogSettings(userId) {
    if (!userId) return null;
    return readUserConfig(userId, BLOG_SETTINGS_KEY);
}

export async function setBlogSettings(userId, settings) {
    if (!userId) return null;
    const current = (await readUserConfig(userId, BLOG_SETTINGS_KEY)) || {};
    const merged = {
        ...current,
        ...(settings || {}),
        updatedAt: new Date().toISOString(),
    };
    await writeUserConfig(userId, BLOG_SETTINGS_KEY, merged);
    return merged;
}

export async function disableBlogSettings(userId, reason) {
    const current = (await readUserConfig(userId, BLOG_SETTINGS_KEY)) || {};
    const merged = {
        ...current,
        enabled: false,
        disabledReason: reason || 'manual',
        updatedAt: new Date().toISOString(),
    };
    await writeUserConfig(userId, BLOG_SETTINGS_KEY, merged);
    return merged;
}

export async function getBlogState(userId) {
    return (await readUserConfig(userId, BLOG_STATE_KEY)) || {};
}

async function setBlogState(userId, state) {
    await writeUserConfig(userId, BLOG_STATE_KEY, state || {});
    return state || {};
}

function toYamlScalar(value) {
    if (value == null) return '""';
    const str = String(value);
    if (/^[\w\-./:]+$/.test(str) && !/^\d+$/.test(str)) return str;
    const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    return `"${escaped}"`;
}

function buildFrontMatter(framework, fields) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(fields)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
            if (!value.length) continue;
            lines.push(`${key}:`);
            for (const item of value) {
                lines.push(`  - ${toYamlScalar(item)}`);
            }
        } else {
            lines.push(`${key}: ${toYamlScalar(value)}`);
        }
    }
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

function formatDate(value) {
    if (!value) return null;
    try {
        return new Date(value).toISOString();
    } catch {
        return null;
    }
}

function buildArticleMarkdown({ project, commit, source, tags, framework, frontMatterOptions }) {
    const normalizedFramework = normalizeFramework(framework);
    const opts = frontMatterOptions || {};
    const fields = {};

    if (opts.includeTitle !== false) fields.title = project.title || project.name;
    const dateValue = formatDate(commit?.commit_date || project.time);
    if (opts.includeDate !== false && dateValue) {
        fields.date = dateValue;
        if (normalizedFramework === 'hugo') fields.lastmod = dateValue;
        else fields.updated = dateValue;
    }
    if (opts.includeDescription !== false && project.description) {
        fields.description = project.description;
    }
    if (opts.includeTags !== false && Array.isArray(tags) && tags.length) {
        fields.tags = tags.map((t) => t.name).filter(Boolean);
    }
    if (normalizedFramework === 'hugo') {
        fields.draft = project.state === 'private';
    }
    if (opts.extra && typeof opts.extra === 'object') {
        for (const [k, v] of Object.entries(opts.extra)) {
            if (v != null && !(k in fields)) fields[k] = v;
        }
    }

    const frontMatter = buildFrontMatter(normalizedFramework, fields);
    const body = typeof source === 'string' ? source : '';
    return `${frontMatter}\n${body.replace(/^\n+/, '')}\n`;
}

function buildFileName(template, { project, slug }) {
    const tmpl = String(template || '{slug}.md').trim() || '{slug}.md';
    const resolvedSlug = safeSlug(slug || project.name) || `project-${project.id}`;
    return tmpl
        .replace(/\{slug\}/g, resolvedSlug)
        .replace(/\{id\}/g, String(project.id))
        .replace(/\{name\}/g, resolvedSlug);
}

function buildFilePath(directory, fileName) {
    const dir = String(directory || '').trim().replace(/^\/+|\/+$/g, '');
    if (!dir) return fileName;
    return `${dir}/${fileName}`.split('/').filter(Boolean).join('/');
}

async function resolveBranchBase(token, owner, repo, branch, defaultBranch) {
    try {
        const ref = await getRef(token, owner, repo, branch);
        const commit = await getCommit(token, owner, repo, ref.object.sha);
        return {
            branchExists: true,
            baseCommitSha: ref.object.sha,
            baseTreeSha: commit?.tree?.sha || null,
        };
    } catch (error) {
        if (error?.status !== 404 && !isEmptyRepoError(error)) throw error;
    }
    if (defaultBranch && defaultBranch !== branch) {
        try {
            const ref = await getRef(token, owner, repo, defaultBranch);
            const commit = await getCommit(token, owner, repo, ref.object.sha);
            return {
                branchExists: false,
                baseCommitSha: ref.object.sha,
                baseTreeSha: commit?.tree?.sha || null,
            };
        } catch (error) {
            if (error?.status !== 404 && !isEmptyRepoError(error)) throw error;
        }
    }
    return { branchExists: false, baseCommitSha: null, baseTreeSha: null };
}

async function createGitBlobs(token, owner, repo, entries) {
    const treeEntries = [];
    for (const entry of entries) {
        const blob = await createBlob(token, owner, repo, entry.content, 'utf-8');
        treeEntries.push({
            path: entry.path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
        });
    }
    return treeEntries;
}

async function syncAllArticles({ userId, reason, triggerProjectId, actorId, authorizationContext } = {}) {
    const payload = { actorId, authorizationContext };
    await assertSyncAuthorized(payload, null, { blog: true });
    const numericUserId = Number(userId);
    if (syncAuthorizationContext(payload).actorId !== numericUserId) {
        throw new ModerationError(403, 'BLOG_SYNC_OWNER_REQUIRED', '只能同步自己的博客');
    }
    if (!Number.isInteger(numericUserId)) {
        throw new Error('blog-sync: invalid user');
    }

    const settings = await getBlogSettings(numericUserId);
    if (!settings?.enabled) return { skipped: true, reason: 'blog_sync_disabled' };
    if (!settings.linkId || !settings.repoOwner || !settings.repoName) {
        return { skipped: true, reason: 'repo_not_configured' };
    }

    const link = await findUserGitLink(numericUserId, settings.linkId);
    if (!link?.installationId) return { skipped: true, reason: 'link_missing' };

    const token = (await createInstallationToken(link.installationId)).token;
    if (!token) throw new Error('Failed to create installation token');

    let repo;
    try {
        repo = await getRepo(token, settings.repoOwner, settings.repoName);
    } catch (error) {
        if (error?.status === 404) {
            await disableBlogSettings(numericUserId, 'repo_missing');
            return { skipped: true, reason: 'repo_missing' };
        }
        throw error;
    }

    const branch = safeBranch(settings.branch || repo.default_branch || DEFAULT_BRANCH);
    const directory = safeDirectory(settings.directory, DEFAULT_DIRECTORY);
    const isRepoPublic = Boolean(settings.repoIsPublic);

    const user = await prisma.ow_users.findUnique({
        where: { id: numericUserId },
        select: { username: true },
    });
    const username = String(user?.username || '').trim().toLowerCase();

    const projects = await fetchArticleProjects(numericUserId);
    const state = await getBlogState(numericUserId);
    const nextState = { ...(state || {}) };
    const existingIds = new Set(projects.map((p) => String(p.id)));
    const deletionSet = new Set();

    for (const [id, entry] of Object.entries(nextState)) {
        if (!existingIds.has(id)) {
            if (entry?.filePath) {
                deletionSet.add(entry.filePath);
            }
            delete nextState[id];
        }
    }

    const eligibleProjects = [];
    for (const project of projects) {
        // Moderation removals use a separate job that cannot publish the other articles.
        if (!await canViewContent('project', project, null, { ignorePrivacy: true })) continue;
        await assertSyncAuthorized(payload, project);
        if (settings.excludeReadme !== false && username) {
            const projectName = String(project.name || '').trim().toLowerCase();
            if (projectName && projectName === username) {
                continue;
            }
        }

        if (project.state === 'private' && isRepoPublic && !settings.allowPrivateToPublic) {
            continue;
        }

        eligibleProjects.push(project);
    }

    const articleData = await loadArticleData(eligibleProjects.map(project => project.id));
    const fileEntries = [];
    for (const project of eligibleProjects) {
        const article = articleData.get(project.id);
        if (!article) continue;
        const { commit, source, tags } = article;

        const fileName = buildFileName(settings.fileNameTemplate, { project, slug: project.name });
        let filePath = buildFilePath(directory, fileName);
        if (!filePath) {
            filePath = `project-${project.id}.md`;
        }

        const markdown = buildArticleMarkdown({
            project,
            commit,
            source,
            tags,
            framework: settings.framework,
            frontMatterOptions: settings.frontMatter,
        });

        const fileHash = sha256(markdown);
        const prev = state[String(project.id)] || {};
        if (prev.filePath && prev.filePath !== filePath) {
            deletionSet.add(prev.filePath);
        }

        fileEntries.push({
            projectId: project.id,
            commitId: commit.id,
            fileHash,
            path: filePath,
            filePath,
            content: markdown,
        });
    }

    const validEntries = fileEntries.filter((entry) => entry.path && entry.filePath);
    const filePathSet = new Set(validEntries.map((entry) => entry.filePath));
    const deletionPaths = Array.from(deletionSet)
        .filter((path) => path)
        .filter((path) => !filePathSet.has(path));

    const { branchExists, baseCommitSha, baseTreeSha } = await resolveBranchBase(
        token,
        settings.repoOwner,
        settings.repoName,
        branch,
        repo.default_branch
    );

    let filteredDeletionPaths = deletionPaths;
    if (!baseTreeSha) {
        filteredDeletionPaths = [];
    } else if (deletionPaths.length) {
        try {
            const tree = await getTree(token, settings.repoOwner, settings.repoName, baseTreeSha, true);
            const items = Array.isArray(tree?.tree) ? tree.tree : [];
            const existingPaths = new Set(
                items
                    .filter((item) => item?.type === 'blob' && item?.path)
                    .map((item) => item.path)
            );
            filteredDeletionPaths = deletionPaths.filter((path) => existingPaths.has(path));
        } catch (error) {
            if (!isEmptyRepoError(error) && error?.status !== 404) throw error;
            filteredDeletionPaths = [];
        }
    }

    const recheckEntries = async () => {
        await assertSyncAuthorized(payload, null, { blog: true });
        for (const entry of validEntries) {
            await loadSyncProject({ ...payload, projectId: entry.projectId, userId: numericUserId }, { blog: true });
        }
    };
    await recheckEntries();
    const blobEntries = await createGitBlobs(token, settings.repoOwner, settings.repoName, validEntries);
    const deleteEntries = filteredDeletionPaths.map((path) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha: null,
    }));
    const treeEntries = [...blobEntries, ...deleteEntries];


    const newTree = await createTree(token, settings.repoOwner, settings.repoName, treeEntries, baseTreeSha);
    const postLabel = validEntries.length === 1 ? 'post' : 'posts';
    const commitMessage = `ZeroCat Blog Sync: ${validEntries.length} ${postLabel}`;
    const parents = baseCommitSha ? [baseCommitSha] : [];
    const newCommit = await createCommit(token, settings.repoOwner, settings.repoName, commitMessage, newTree.sha, parents);

    await recheckEntries();
    if (branchExists) {
        await updateRef(token, settings.repoOwner, settings.repoName, branch, newCommit.sha);
    } else {
        await createRef(token, settings.repoOwner, settings.repoName, branch, newCommit.sha);
    }

    const now = new Date().toISOString();
    for (const entry of validEntries) {
        const prev = nextState[String(entry.projectId)] || {};
        nextState[String(entry.projectId)] = {
            ...prev,
            fileHash: entry.fileHash,
            filePath: entry.filePath,
            lastCommitSha: newCommit.sha,
            lastCommitId: entry.commitId,
            lastSyncedAt: now,
            lastError: null,
        };
    }

    await setBlogState(numericUserId, nextState);

    return {
        synced: true,
        branch,
        commitSha: newCommit.sha,
        updated: validEntries.length,
        removed: filteredDeletionPaths.length,
        triggerProjectId: triggerProjectId || null,
        reason: reason || null,
    };
}

async function removeModeratedArticle(payload) {
    if (!await moderationRemovalProject(payload)) return { skipped: true, reason: 'content_visible' };
    const settings = await getBlogSettings(payload.userId);
    const state = await getBlogState(payload.userId);
    const entry = state[String(payload.projectId)];
    if (!entry?.filePath) return { skipped: true, reason: 'article_not_synced' };
    if (!settings?.linkId || !settings.repoOwner || !settings.repoName) return { skipped: true, reason: 'repo_not_configured' };
    if (Object.entries(state).some(([id, value]) => id !== String(payload.projectId) && value?.filePath === entry.filePath)) {
        return { skipped: true, reason: 'shared_file_path' };
    }
    const link = await findUserGitLink(payload.userId, settings.linkId);
    if (!link?.installationId) return { skipped: true, reason: 'link_missing' };
    const token = (await createInstallationToken(link.installationId)).token;
    if (!token) throw new Error('Failed to create installation token');
    const repo = await getRepo(token, settings.repoOwner, settings.repoName);
    const branch = safeBranch(settings.branch || repo.default_branch || DEFAULT_BRANCH);
    const { branchExists, baseCommitSha, baseTreeSha } = await resolveBranchBase(token, settings.repoOwner, settings.repoName, branch, repo.default_branch);
    if (!baseTreeSha) return { skipped: true, reason: 'article_not_synced' };
    const tree = await getTree(token, settings.repoOwner, settings.repoName, baseTreeSha, true);
    if (!await moderationRemovalProject(payload)) return { skipped: true, reason: 'content_visible' };
    const exists = tree?.tree?.some((item) => item.type === 'blob' && item.path === entry.filePath);
    let commitSha = null;
    if (exists) {
        const nextTree = await createTree(token, settings.repoOwner, settings.repoName,
            [{ path: entry.filePath, mode: '100644', type: 'blob', sha: null }], baseTreeSha);
        const commit = await createCommit(token, settings.repoOwner, settings.repoName,
            'ZeroCat Blog Sync: remove moderated article', nextTree.sha, baseCommitSha ? [baseCommitSha] : []);
        if (!await moderationRemovalProject(payload)) return { skipped: true, reason: 'content_visible' };
        if (branchExists) await updateRef(token, settings.repoOwner, settings.repoName, branch, commit.sha);
        else await createRef(token, settings.repoOwner, settings.repoName, branch, commit.sha);
        commitSha = commit.sha;
    }
    const nextState = await getBlogState(payload.userId);
    // A later sync may have moved the article to a new path while removal was running.
    if (nextState[String(payload.projectId)]?.filePath === entry.filePath) {
        delete nextState[String(payload.projectId)];
        await setBlogState(payload.userId, nextState);
    }
    return { removed: exists ? 1 : 0, commitSha, branch };
}

const blogSyncService = {
    async syncArticleProject({ projectId, userId, actorId, authorizationContext }) {
        const numericProjectId = Number(projectId);
        const numericUserId = Number(userId);
        if (!Number.isInteger(numericProjectId) || !Number.isInteger(numericUserId)) {
            throw new Error('blog-sync: invalid payload');
        }

        await loadSyncProject({ projectId: numericProjectId, userId: numericUserId, actorId, authorizationContext }, { blog: true });
        return syncAllArticles({
            userId: numericUserId,
            triggerProjectId: numericProjectId,
            actorId,
            authorizationContext,
            reason: 'project-commit',
        });
    },

    async removeArticleFromBlog({ projectId, userId, reason, actorId, authorizationContext, systemModeration = false }) {
        const numericProjectId = Number(projectId);
        const numericUserId = Number(userId);
        if (!Number.isInteger(numericProjectId) || !Number.isInteger(numericUserId)) {
            throw new Error('blog-sync: invalid remove payload');
        }

        const payload = { projectId: numericProjectId, userId: numericUserId, actorId, authorizationContext, systemModeration };
        if (systemModeration === true) return removeModeratedArticle(payload);
        await loadSyncProject(payload, { blog: true });
        return syncAllArticles({
            userId: numericUserId,
            triggerProjectId: numericProjectId,
            actorId,
            authorizationContext,
            reason: reason || 'removed',
        });
    },

    async listArticleProjects(userId) {
        return prisma.ow_projects.findMany({
            where: { authorid: Number(userId), type: 'article', AND: [await visibleWhere('project', userId)] },
            orderBy: { time: 'desc' },
        });
    },
};

export default blogSyncService;
