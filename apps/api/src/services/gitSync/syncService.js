import { createHash } from 'crypto';
import logger from '../logger.js';
import { prisma } from '../prisma.js';
import { readProjectFile } from '../projectFileStorage.js';
import zcconfig from '../config/zcconfig.js';
import { downloadFromS3 } from '../assets.js';
import { createNotification } from '../../controllers/notifications.js';
import { createInstallationToken } from './githubApp.js';
import { assertSyncAuthorized, loadSyncProject } from './authorization.js';
import { canViewContent } from '../moderation/visibility.js';
import { findProjectCommit } from '../projectCommitAccess.js';
import { createBlob, createCommit, createRef, createTree, getCommit, getContent, getRef, getRepo, getTree, updateRef } from './githubApi.js';
import { extractScratchAssetMd5ExtList, buildScratchAssetS3Key } from './scratchAssets.js';
import { findUserGitLink, getProjectGitSyncSettings, getProjectGitSyncState, setProjectGitSyncState, updateProjectGitSyncSettings } from './storage.js';

const DEFAULT_PROJECT_FILE = 'project.json';
const DEFAULT_README_FILE = 'README.md';

const isEmptyRepoError = (error) => {
    if (!error) return false;
    if (error.isEmptyRepo) return true;
    if (error.status === 409) return true;
    const message = String(error.message || '');
    return message.includes('Git Repository is empty');
};

const safeFilename = (value, fallback) => {
    const name = String(value || '').trim();
    if (!name) return fallback;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return fallback;
    if (name.includes('\\')) return fallback;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return fallback;
    return name;
};

const safeBranchName = (value, fallback) => {
    const name = String(value || '').trim();
    if (!name) return fallback;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return fallback;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return fallback;
    return name;
};

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const normalizeText = (value) => (value == null ? '' : String(value));

const buildProjectFileContent = (source, { formatJson = false } = {}) => {
    if (typeof source === 'string') {
        if (formatJson) {
            try {
                const parsed = JSON.parse(source);
                return `${JSON.stringify(parsed, null, 2)}\n`;
            } catch {
                return source;
            }
        }
        return source;
    }
    try {
        return `${JSON.stringify(source, null, 2)}\n`;
    } catch (error) {
        return String(source || '');
    }
};

const buildReadmeContent = (project) => {
    const description = normalizeText(project?.description).trim();
    if (!description) return '';
    return description;
};

const buildProjectLabel = (project) => project?.title || project?.name || String(project?.id || '');

const buildRepoLabel = (settings) => {
    const owner = String(settings?.repoOwner || '').trim();
    const repo = String(settings?.repoName || '').trim();
    if (!owner || !repo) return '';
    return `${owner}/${repo}`;
};

const shouldNotifyFinalAttempt = (job) => {
    if (!job) return true;
    const maxAttempts = Number(job?.opts?.attempts) || 1;
    const attemptsMade = Number(job?.attemptsMade) || 0;
    return attemptsMade + 1 >= maxAttempts;
};

const notifyGitSyncFailure = async ({ project, settings, commit, error, job, projectId, commitId }) => {
    if (!project?.authorid) return;
    if (!shouldNotifyFinalAttempt(job)) return;

    const projectLabel = buildProjectLabel(project);
    const repoLabel = buildRepoLabel(settings);
    const commitLabel = commit?.commit_message || commit?.id || commitId || '';
    const content = repoLabel
        ? `项目《${projectLabel}》同步到 ${repoLabel} 失败：${error.message}`
        : `项目《${projectLabel}》Git 同步失败：${error.message}`;

    try {
        await createNotification({
            userId: project.authorid,
            title: 'Git 同步失败',
            content,
            notificationRequirement: 'ALL',
            highPriority: true,
            targetType: 'project',
            targetId: project.id,
            actorId: job?.data?.actorId || null,
            pushChannels: ['browser', 'email'],
            data: {
                repo_owner: settings?.repoOwner || null,
                repo_name: settings?.repoName || null,
                branch: settings?.branch || null,
                commit_id: commit?.id || commitId || null,
                commit_message: commitLabel,
                error_message: error.message,
                type: 'git_sync_failed',
            },
        });
    } catch (notifyError) {
        logger.warn(`[git-sync] notify failed project=${project?.id || projectId}: ${notifyError.message}`);
    }
};

const isScratchLikeType = (type) => String(type || '').toLowerCase().startsWith('scratch');
const isScratchAssetName = (value) => /^[0-9a-f]{32}\.[A-Za-z0-9]+$/i.test(String(value || ''));

async function getRemoteFileHash(token, owner, repo, path, ref) {
    if (!path) return null;
    try {
        const file = await getContent(token, owner, repo, path, ref);
        if (!file || file.type !== 'file' || !file.content) return null;
        const encoding = file.encoding || 'base64';
        const buffer = Buffer.from(file.content, encoding);
        return sha256(buffer);
    } catch (error) {
        if (error?.status === 404 || isEmptyRepoError(error)) return null;
        throw error;
    }
}

async function getRemoteAssetSet(token, owner, repo, treeSha) {
    if (!treeSha) return new Set();
    try {
        const tree = await getTree(token, owner, repo, treeSha, true);
        const entries = Array.isArray(tree?.tree) ? tree.tree : [];
        const assets = new Set();
        for (const entry of entries) {
            if (entry?.type !== 'blob') continue;
            const path = entry?.path || '';
            if (!path || path.includes('/')) continue;
            if (!isScratchAssetName(path)) continue;
            assets.add(path);
        }
        return assets;
    } catch (error) {
        if (error?.status === 404 || isEmptyRepoError(error)) return new Set();
        throw error;
    }
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

    return {
        branchExists: false,
        baseCommitSha: null,
        baseTreeSha: null,
    };
}

async function createGitBlobs(token, owner, repo, entries) {
    const treeEntries = [];
    for (const entry of entries) {
        const encoding = entry.encoding || 'utf-8';
        const blob = await createBlob(token, owner, repo, entry.content, encoding);
        treeEntries.push({
            path: entry.path,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
        });
    }
    return treeEntries;
}

async function buildScratchAssets({
    projectJson,
    previousAssets,
    maxAssets,
    maxAssetBytes,
}) {
    const assetList = extractScratchAssetMd5ExtList(projectJson);
    const selected = [];
    const skipped = [];
    let limitReached = false;

    for (const md5ext of assetList) {
        const asset = await prisma.ow_assets.findUnique({ where: { md5: md5ext.split('.')[0] } });
        if (!asset || !await canViewContent('asset', asset, null)) {
            skipped.push(md5ext);
            continue;
        }
        if (previousAssets.has(md5ext)) {
            skipped.push(md5ext);
            continue;
        }

        if (selected.length >= maxAssets) {
            limitReached = true;
            break;
        }

        const key =buildScratchAssetS3Key(md5ext);
        if (!key) {
            skipped.push(md5ext);
            continue;
        }

        try {
            const { buffer, contentLength } = await downloadFromS3(key);
            if (!buffer || buffer.length === 0) {
                skipped.push(md5ext);
                continue;
            }

            const size = Number(contentLength || buffer.length);
            if (size > maxAssetBytes) {
                skipped.push(md5ext);
                continue;
            }

            selected.push({
                path: md5ext,
                content: buffer.toString('base64'),
                encoding: 'base64',
                size,
            });
        } catch (error) {
            skipped.push(md5ext);
        }
    }

    return {
        assetList,
        selected,
        skipped,
        limitReached,
    };
}

async function ensureRepoAccessible(token, owner, repo, projectId) {
    try {
        return await getRepo(token, owner, repo);
    } catch (error) {
        if (error?.status === 404) {
            await updateProjectGitSyncSettings(projectId, {
                enabled: false,
                disabledReason: 'repo_missing',
            });
        }
        throw error;
    }
}

const gitSyncService = {
    async syncProjectCommit(job) {
        const projectId = Number(job?.data?.projectId);
        const commitId = String(job?.data?.commitId || '').trim();
        if (!Number.isInteger(projectId) || !commitId) {
            throw new Error('Invalid project sync payload');
        }

        await assertSyncAuthorized(job?.data || {});
        let settings = null;
        let project = null;
        let commit = null;

        try {
            settings = await getProjectGitSyncSettings(projectId);
            if (!settings?.enabled) {
                return { skipped: true, reason: 'sync_disabled' };
            }

            if (settings.provider !== 'github' || settings.linkKind !== 'app') {
                return { skipped: true, reason: 'unsupported_provider' };
            }

            project = await prisma.ow_projects.findFirst({
                where: { id: projectId },
                select: {
                    id: true,
                    type: true,
                    title: true,
                    description: true,
                    authorid: true,
                    default_branch: true,
                    state: true,
                    deleted_at: true,
                    is_shadowbanned: true,
                    shadowban_expires_at: true,
                },
            });
            if (!project?.authorid) {
                return { skipped: true, reason: 'project_missing' };
            }

            await assertSyncAuthorized(job.data, project);
            commit = await findProjectCommit(projectId, commitId);
            if (!commit) {
                return { skipped: true, reason: 'commit_missing' };
            }

            const state = (await getProjectGitSyncState(projectId)) || {};

            const link = await findUserGitLink(project.authorid, settings.linkId);
            if (!link?.installationId) {
                return { skipped: true, reason: 'link_missing' };
            }

            const token = (await createInstallationToken(link.installationId)).token;
            if (!token) {
                throw new Error('Failed to create installation token');
            }

            const repoOwner = settings.repoOwner;
            const repoName = settings.repoName;
            if (!repoOwner || !repoName) {
                return { skipped: true, reason: 'repo_not_bound' };
            }

            let repo;
            try {
                repo = await ensureRepoAccessible(token, repoOwner, repoName, projectId);
            } catch (error) {
                if (error?.status === 404) {
                    await setProjectGitSyncState(projectId, {
                        ...state,
                        lastError: 'repo_missing',
                        disabledReason: 'repo_missing',
                        lastSyncedAt: new Date().toISOString(),
                    });
                }
                throw error;
            }

            const branch = safeBranchName(settings.branch || repo.default_branch || project.default_branch || 'main', 'main');

            const fileRecord = await readProjectFile(commit.commit_file);
            const sourceContent = buildProjectFileContent(fileRecord?.source, {
                formatJson: isScratchLikeType(project.type),
            });

            const projectFileName = safeFilename(settings.fileName || DEFAULT_PROJECT_FILE, DEFAULT_PROJECT_FILE);
            const readmeFileName = safeFilename(settings.readmeFileName || DEFAULT_README_FILE, DEFAULT_README_FILE);

            const { branchExists, baseCommitSha, baseTreeSha } = await resolveBranchBase(
                token,
                repoOwner,
                repoName,
                branch,
                repo.default_branch
            );

            const baseRef = branchExists ? branch : (repo.default_branch || branch);
            const previousFileHashes = {};
            const remoteProjectHash = await getRemoteFileHash(token, repoOwner, repoName, projectFileName, baseRef);
            if (remoteProjectHash) previousFileHashes[projectFileName] = remoteProjectHash;
            if (settings.includeReadme) {
                const remoteReadmeHash = await getRemoteFileHash(token, repoOwner, repoName, readmeFileName, baseRef);
                if (remoteReadmeHash) previousFileHashes[readmeFileName] = remoteReadmeHash;
            }

            const nextFileHashes = { ...previousFileHashes };
            const entries = [];

            const projectFileHash = sha256(sourceContent);
            nextFileHashes[projectFileName] = projectFileHash;
            if (previousFileHashes[projectFileName] !== projectFileHash) {
                entries.push({
                    path: projectFileName,
                    content: sourceContent,
                    encoding: 'utf-8',
                });
            }

            if (settings.includeReadme) {
                const readmeContent = buildReadmeContent(project);
                if (readmeContent) {
                    const readmeHash = sha256(readmeContent);
                    nextFileHashes[readmeFileName] = readmeHash;
                    if (previousFileHashes[readmeFileName] !== readmeHash) {
                        entries.push({
                            path: readmeFileName,
                            content: readmeContent,
                            encoding: 'utf-8',
                        });
                    }
                }
            }

            let scratchAssetList = [];
            let syncedScratchAssets = new Set();
            let assetLimitReached = false;

            if (isScratchLikeType(project.type)) {
                syncedScratchAssets = await getRemoteAssetSet(token, repoOwner, repoName, baseTreeSha);
                scratchAssetList = Array.from(syncedScratchAssets);
                let projectJson = null;
                try {
                    projectJson = JSON.parse(sourceContent);
                } catch {
                    projectJson = null;
                }

                if (projectJson) {
                    const maxAssets = Math.max(0, Number(await zcconfig.get('git.sync.scratch.max_assets', 200)) || 200);
                    const maxAssetBytes = Math.max(1024, Number(await zcconfig.get('git.sync.scratch.max_asset_bytes', 20 * 1024 * 1024)) || (20 * 1024 * 1024));

                    const scratchResult = await buildScratchAssets({
                        projectJson,
                        previousAssets: syncedScratchAssets,
                        maxAssets,
                        maxAssetBytes,
                    });

                    for (const asset of scratchResult.selected) {
                        entries.push({
                            path: asset.path,
                            content: asset.content,
                            encoding: asset.encoding,
                        });
                        syncedScratchAssets.add(asset.path);
                    }

                    assetLimitReached = scratchResult.limitReached;
                    if (!assetLimitReached) {
                        scratchAssetList = scratchResult.assetList;
                        syncedScratchAssets = new Set(scratchAssetList);
                    } else {
                        scratchAssetList = Array.from(syncedScratchAssets);
                    }
                }
            }

            if (entries.length === 0) {
                const nextState = {
                    ...state,
                    lastCommitId: commitId,
                    lastSyncedAt: new Date().toISOString(),
                    fileHashes: nextFileHashes,
                    scratchAssets: scratchAssetList,
                    lastError: null,
                    disabledReason: null,
                };
                await setProjectGitSyncState(projectId, nextState);
                return { skipped: true, reason: 'no_changes' };
            }

            project = await loadSyncProject(job.data);
            const treeEntries = await createGitBlobs(token, repoOwner, repoName, entries);
            const newTree = await createTree(token, repoOwner, repoName, treeEntries, baseTreeSha);

            const projectLabel = buildProjectLabel(project);
            const commitSummary = normalizeText(commit.commit_message).split('\n')[0].trim();
            const summary = commitSummary || commitId.slice(0, 8);
            const commitMessage = `ZeroCat Sync: ${projectLabel} - ${summary}`;
            const parents = baseCommitSha ? [baseCommitSha] : [];
            const newCommit = await createCommit(token, repoOwner, repoName, commitMessage, newTree.sha, parents);

            await loadSyncProject(job.data);
            if (branchExists) {
                await updateRef(token, repoOwner, repoName, branch, newCommit.sha);
            } else {
                await createRef(token, repoOwner, repoName, branch, newCommit.sha);
            }

            const nextState = {
                ...state,
                lastCommitId: commitId,
                lastSyncedAt: new Date().toISOString(),
                lastCommitSha: newCommit.sha,
                fileHashes: nextFileHashes,
                scratchAssets: scratchAssetList,
                lastError: null,
                disabledReason: null,
            };
            await setProjectGitSyncState(projectId, nextState);

            return {
                synced: true,
                commitSha: newCommit.sha,
                branch,
                assetsAdded: isScratchLikeType(project.type) ? entries.filter((item) => item.encoding === 'base64').length : 0,
                assetLimitReached,
            };
        } catch (error) {
            if (error.status === 403 || error.status === 404) throw error;
            logger.warn(`[git-sync] sync failed project=${projectId} commit=${commitId}: ${error.message}`);
            const state = (await getProjectGitSyncState(projectId)) || {};
            await setProjectGitSyncState(projectId, {
                ...state,
                lastError: error.message,
                lastErrorAt: new Date().toISOString(),
            });
            if (!project && Number.isInteger(projectId)) {
                try {
                    project = await prisma.ow_projects.findFirst({
                        where: { id: projectId },
                        select: { id: true, name: true, title: true, authorid: true },
                    });
                } catch (loadError) {
                    logger.debug(`[git-sync] load project failed project=${projectId}: ${loadError.message}`);
                }
            }
            if (!settings && Number.isInteger(projectId)) {
                try {
                    settings = await getProjectGitSyncSettings(projectId);
                } catch (loadError) {
                    logger.debug(`[git-sync] load settings failed project=${projectId}: ${loadError.message}`);
                }
            }
            if (!commit && commitId) {
                try {
                    commit = await prisma.ow_projects_commits.findFirst({
                        where: { id: commitId, project_id: projectId },
                    });
                } catch (loadError) {
                    logger.debug(`[git-sync] load commit failed project=${projectId} commit=${commitId}: ${loadError.message}`);
                }
            }
            await notifyGitSyncFailure({
                project,
                settings,
                commit,
                error,
                job,
                projectId,
                commitId,
            });
            throw error;
        }
    },
};

export default gitSyncService;
