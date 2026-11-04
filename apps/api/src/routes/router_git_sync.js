import { Router } from 'express';
import crypto from 'crypto';
import { needLogin } from '../middleware/auth.js';
import { requireResource, requireScope } from '../middleware/scope.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import redisClient from '../services/redis.js';
import logger from '../services/logger.js';
import { prisma } from '../services/prisma.js';
import zcconfig from '../services/config/zcconfig.js';
import { buildInstallUrl, buildUserTokenAuthUrl, createInstallationToken, exchangeUserToken, getInstallationInfo } from '../services/gitSync/githubApp.js';
import { createOrgRepo, createUserRepo, getAuthenticatedUser, getContent, getRepo, listBranches, listInstallationRepos, searchRepos } from '../services/gitSync/githubApi.js';
import { addUserGitLink, findUserGitHubUserToken, findUserGitLink, getProjectGitSyncSettings, getProjectGitSyncState, getUserGitHubUserTokens, getUserGitLinks, removeUserGitHubUserToken, removeUserGitLink, setProjectGitSyncState, updateProjectGitSyncSettings, upsertUserGitHubUserToken } from '../services/gitSync/storage.js';
import blogSyncService, { getBlogSettings, setBlogSettings, disableBlogSettings, getBlogState } from '../services/gitSync/blogSyncService.js';
import queueManager from '../services/queue/queueManager.js';
import { authorize } from '../services/auth/authorization.js';
import { canViewContent } from '../services/moderation/visibility.js';
import { ModerationError } from '../services/moderation/policy.js';

const requestAuthorization = (res) => ({ tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] });
async function assertGitCallbackAuthorized(stateData) {
    const decision = await authorize({
        actorId: stateData.userId, ...stateData.authorizationContext, requiredScope: 'git_sync:manage',
    });
    if (!decision.allowed) throw new ModerationError(decision.status, decision.code, decision.message);
}

const router = Router();

const gitSyncRateLimit = createRateLimit({
    windowMs: 60 * 1000,
    max: 20,
    prefix: 'rate_limit:git_sync:',
    message: {
        status: 'error',
        message: 'Git同步请求过于频繁，请稍后再试',
    },
});

const parseBooleanInput = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
    if (typeof value !== 'string') return null;

    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) return false;
    return null;
};

const normalizeRepoValue = (value) => String(value || '').trim();

const sanitizeFilenameInput = (value) => {
    const name = String(value || '').trim();
    if (!name) return null;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return null;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return null;
    if (name.includes('\\')) return null;
    return name;
};

const sanitizeRepoPathInput = (value) => {
    const name = String(value || '').trim();
    if (!name) return '';
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return null;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return null;
    if (name.includes('\\')) return null;
    return name.replace(/\/+$/, '');
};

const sanitizeRepoNameInput = (value) => {
    const name = String(value || '').trim();
    if (!name) return null;
    if (name.length > 100) return null;
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    if (!/^[0-9A-Za-z._-]+$/.test(name)) return null;
    return name;
};

const sanitizeRepoOwnerInput = (value) => {
    const name = String(value || '').trim();
    if (!name) return null;
    if (name.length > 39) return null;
    if (!/^[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?$/.test(name)) return null;
    if (name.includes('--')) return null;
    return name;
};

const sanitizeBranchInput = (value) => {
    const name = String(value || '').trim();
    if (!name) return null;
    if (name.length > 255) return null;
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) return null;
    if (name.endsWith('/') || name.endsWith('.')) return null;
    if (name.includes('@{')) return null;
    if (!/^[0-9A-Za-z._/-]+$/.test(name)) return null;
    return name;
};

const sanitizeDescriptionInput = (value) => {
    const description = String(value || '').trim();
    if (!description) return null;
    return description.slice(0, 200);
};

const normalizeAccountType = (value) => String(value || '').trim().toLowerCase();

const buildExpiresAt = (expiresIn) => {
    const seconds = Number(expiresIn);
    if (!seconds || Number.isNaN(seconds)) return null;
    return new Date(Date.now() + seconds * 1000).toISOString();
};

const isEmptyRepoError = (error) => {
    if (!error) return false;
    if (error.isEmptyRepo) return true;
    if (error.status === 409) return true;
    const message = String(error.message || '');
    return message.includes('Git Repository is empty');
};

const handleGitHubAuthError = async (error, res, context = {}) => {
    if (error?.status !== 401) return false;
    const tokenSource = context.tokenSource || '';
    if (tokenSource === 'user') {
        if (context.userId) {
            await removeUserGitHubUserToken(
                context.userId,
                context.accountId,
                context.accountLogin
            );
        }
        res.status(401).send({
            status: 'error',
            code: 'user_token_required',
            message: 'App User Token 已失效，请重新授权',
        });
        return true;
    }

    res.status(401).send({
        status: 'error',
        code: 'installation_token_invalid',
        message: 'GitHub App 安装授权失效，请重新安装',
    });
    return true;
};


const resolveFrontendBaseUrl = async () => {
    const frontendUrl = await zcconfig.get('urls.frontend');
    if (!frontendUrl) return null;
    try {
        return new URL(frontendUrl);
    } catch (error) {
        logger.warn(`[git-sync] Invalid frontend URL: ${frontendUrl}`);
        return null;
    }
};

const resolveFrontendRedirect = async (redirectUrl, fallbackPath, fallbackParams) => {
    const base = await resolveFrontendBaseUrl();
    if (!base) return null;

    if (redirectUrl) {
        try {
            if (redirectUrl.startsWith('/')) {
                return new URL(redirectUrl, base).toString();
            }
            const candidate = new URL(redirectUrl);
            if (candidate.origin === base.origin) {
                return candidate.toString();
            }
        } catch (error) {
            logger.warn(`[git-sync] Invalid redirect URL: ${redirectUrl}`);
        }
    }

    const fallback = new URL(fallbackPath || '/', base);
    if (fallbackParams) {
        Object.entries(fallbackParams).forEach(([key, value]) => {
            if (value != null && value !== '') {
                fallback.searchParams.set(key, String(value));
            }
        });
    }
    return fallback.toString();
};

const buildCompleteRedirect = async (params) => {
    return resolveFrontendRedirect(null, '/app/oauth/github/complete', params);
};

const listAllInstallationRepos = async (token) => {
    const perPage = 100;
    const maxPages = 10;
    let page = 1;
    let total = null;
    const repos = [];

    while (page <= maxPages) {
        const result = await listInstallationRepos(token, { perPage, page });
        const batch = Array.isArray(result?.repositories) ? result.repositories : [];
        repos.push(...batch);
        total = typeof result?.total_count === 'number' ? result.total_count : total;
        if (!batch.length) break;
        if (total != null && repos.length >= total) break;
        if (batch.length < perPage) break;
        page += 1;
    }

    return repos;
};

const ensureProjectOwner = async (projectId, userId, res, action = 'read') => {
    const project = await prisma.ow_projects.findFirst({
        where: { id: Number(projectId) },
        select: { id: true, authorid: true, default_branch: true, type: true, name: true, title: true, state: true,
            is_shadowbanned: true, shadowban_expires_at: true, deleted_at: true },
    });
    if (!project || !await canViewContent('project', project, userId)) {
        const error = new Error('项目不存在');
        error.status = 404;
        throw error;
    }
    if (Number(project.authorid) !== Number(userId)) {
        const error = new Error('无权操作该项目');
        error.status = 403;
        throw error;
    }
    if (project.type === 'article') {
        const decision = await authorize({ actorId: userId, ...requestAuthorization(res),
            requiredScope: `blog:${project.id}:${action}`, action, category: 'blog' });
        if (!decision.allowed) throw new ModerationError(decision.status, decision.code, decision.message);
    }
    return project;
};

router.get('/links', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const [links, tokens] = await Promise.all([
            getUserGitLinks(res.locals.userid),
            getUserGitHubUserTokens(res.locals.userid),
        ]);

        const tokenList = Array.isArray(tokens) ? tokens : [];

        const enhancedLinks = links.map((link) => {
            const accountId = String(link?.account?.id || '').trim();
            const accountLogin = String(link?.account?.login || '').trim();
            const token = tokenList.find((item) => (
                (accountId && String(item?.accountId || '').trim() === accountId)
                || (accountLogin && String(item?.accountLogin || '').trim().toLowerCase() === accountLogin.toLowerCase())
            ));
            return {
                ...link,
                userTokenBound: Boolean(token),
            };
        });

        res.status(200).send({ status: 'success', links: enhancedLinks });
    } catch (error) {
        next(error);
    }
});

router.delete('/links/:linkId', needLogin, requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const removed = await removeUserGitLink(res.locals.userid, req.params.linkId);
        if (!removed) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }
        res.status(200).send({ status: 'success' });
    } catch (error) {
        next(error);
    }
});

router.post('/github/app/install-url', needLogin, requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const state = crypto.randomUUID();
        const stateKey = `git-sync:github:state:${state}`;
        const redirectUrl = typeof req.body?.redirectUrl === 'string' ? req.body.redirectUrl.trim() : '';
        const parsedAutoUserToken = parseBooleanInput(req.body?.autoUserToken);
        const stored = await redisClient.set(stateKey, {
            userId: res.locals.userid,
            authorizationContext: requestAuthorization(res),
            createdAt: new Date().toISOString(),
            redirectUrl: redirectUrl || null,
            autoUserToken: parsedAutoUserToken === null ? false : parsedAutoUserToken,
        }, 600);
        if (!stored) {
            return res.status(500).send({ status: 'error', message: '无法创建安装状态' });
        }

        const url = await buildInstallUrl(state);
        res.status(200).send({ status: 'success', url, state });
    } catch (error) {
        next(error);
    }
});

router.post('/github/app/user-token-url', needLogin, requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const state = crypto.randomUUID();
        const stateKey = `git-sync:github:user-token:state:${state}`;
        const redirectUrl = typeof req.body?.redirectUrl === 'string' ? req.body.redirectUrl.trim() : '';
        const linkId = String(req.body?.linkId || '').trim();

        let link = null;
        if (linkId) {
            link = await findUserGitLink(res.locals.userid, linkId);
            if (!link) {
                return res.status(404).send({ status: 'error', message: '链接不存在' });
            }
        }

        const stored = await redisClient.set(stateKey, {
            userId: res.locals.userid,
            authorizationContext: requestAuthorization(res),
            createdAt: new Date().toISOString(),
            redirectUrl: redirectUrl || null,
            linkId: link?.id || null,
        }, 600);

        if (!stored) {
            return res.status(500).send({ status: 'error', message: '无法创建授权状态' });
        }

        const url = await buildUserTokenAuthUrl(state, {
            login: link?.account?.login || undefined,
        });
        res.status(200).send({ status: 'success', url, state });
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/callback', gitSyncRateLimit, async (req, res, next) => {
    try {
        const installationId = Number(req.query.installation_id || req.query.installationId);
        const state = String(req.query.state || '').trim();

        if (!installationId || !state) {
            const redirectUrl = await buildCompleteRedirect({ status: 'error', message: '缺少安装参数' });
            if (redirectUrl) return res.redirect(redirectUrl);
            return res.status(400).send({ status: 'error', message: '缺少安装参数' });
        }

        const stateKey = `git-sync:github:state:${state}`;
        const stateData = await redisClient.get(stateKey);
        await redisClient.delete(stateKey);

        if (!stateData?.userId) {
            const redirectUrl = await buildCompleteRedirect({ status: 'error', message: '安装状态已过期' });
            if (redirectUrl) return res.redirect(redirectUrl);
            return res.status(400).send({ status: 'error', message: '安装状态已过期' });
        }

        await assertGitCallbackAuthorized(stateData);
        const installation = await getInstallationInfo(installationId);
        const account = installation?.account || {};
        const link = await addUserGitLink(stateData.userId, {
            provider: 'github',
            kind: 'app',
            installationId,
            account: {
                id: account.id || null,
                login: account.login || null,
                type: account.type || null,
                avatar_url: account.avatar_url || null,
            },
            meta: {
                appId: installation?.app_id || null,
                targetType: installation?.target_type || null,
            },
        });

        const accountType = normalizeAccountType(account?.type);
        const shouldAutoUserToken = parseBooleanInput(stateData?.autoUserToken) !== false;
        if (shouldAutoUserToken && accountType && accountType !== 'organization') {
            const existingToken = await findUserGitHubUserToken(
                stateData.userId,
                account?.id,
                account?.login
            );

            if (!existingToken) {
                const userTokenState = crypto.randomUUID();
                const userTokenStateKey = `git-sync:github:user-token:state:${userTokenState}`;
                const storedUserToken = await redisClient.set(userTokenStateKey, {
                    userId: stateData.userId,
                    authorizationContext: stateData.authorizationContext,
                    createdAt: new Date().toISOString(),
                    redirectUrl: stateData.redirectUrl || null,
                    linkId: link?.id || null,
                    installCompleted: true,
                }, 600);

                if (storedUserToken) {
                    try {
                        const userTokenUrl = await buildUserTokenAuthUrl(userTokenState, {
                            login: account?.login || undefined,
                        });
                        return res.redirect(userTokenUrl);
                    } catch (error) {
                        logger.warn(`[git-sync] auto user token auth failed: ${error.message}`);
                    }
                }
            }
        }

        const redirectUrl = await resolveFrontendRedirect(null, '/app/oauth/github/complete', {
            status: 'success',
            step: 'install',
            redirect: stateData.redirectUrl || '',
        });
        if (redirectUrl) return res.redirect(redirectUrl);
        res.status(200).send({ status: 'success', link });
    } catch (error) {
        const redirectUrl = await buildCompleteRedirect({ status: 'error', message: 'GitHub App绑定失败' });
        if (redirectUrl) return res.redirect(redirectUrl);
        next(error);
    }
});

router.get('/github/app/user-token/callback', gitSyncRateLimit, async (req, res, next) => {
    try {
        const authCode = String(req.query.code || '').trim();
        const state = String(req.query.state || '').trim();
        const errorReason = String(req.query.error_description || req.query.error || '').trim();

        if (errorReason) {
            const redirectUrl = await buildCompleteRedirect({ status: 'error', message: errorReason });
            if (redirectUrl) return res.redirect(redirectUrl);
            return res.status(400).send({ status: 'error', message: errorReason });
        }

        if (!authCode || !state) {
            const redirectUrl = await buildCompleteRedirect({ status: 'error', message: '缺少授权参数' });
            if (redirectUrl) return res.redirect(redirectUrl);
            return res.status(400).send({ status: 'error', message: '缺少授权参数' });
        }

        const stateKey = `git-sync:github:user-token:state:${state}`;
        const stateData = await redisClient.get(stateKey);
        await redisClient.delete(stateKey);

        if (!stateData?.userId) {
            const redirectUrl = await buildCompleteRedirect({ status: 'error', message: '授权状态已过期' });
            if (redirectUrl) return res.redirect(redirectUrl);
            return res.status(400).send({ status: 'error', message: '授权状态已过期' });
        }

        await assertGitCallbackAuthorized(stateData);
        const tokenData = await exchangeUserToken(authCode);
        if (!tokenData?.access_token) {
            throw new Error('GitHub未返回有效的用户令牌');
        }

        const account = await getAuthenticatedUser(tokenData.access_token);
        const accountId = account?.id ? String(account.id) : '';
        const accountLogin = String(account?.login || '').trim();
        if (!accountId && !accountLogin) {
            throw new Error('无法获取GitHub账号信息');
        }

        if (stateData.linkId) {
            const link = await findUserGitLink(stateData.userId, stateData.linkId);
            if (!link) {
                throw new Error('目标账号不存在');
            }
            const linkAccountId = String(link?.account?.id || '').trim();
            const linkAccountLogin = String(link?.account?.login || '').trim().toLowerCase();
            const matches = (linkAccountId && linkAccountId === accountId)
                || (linkAccountLogin && accountLogin && linkAccountLogin === accountLogin.toLowerCase());
            if (!matches) {
                throw new Error('授权账号与目标账号不一致');
            }
        }

        await upsertUserGitHubUserToken(stateData.userId, {
            accountId,
            accountLogin,
            accessToken: tokenData.access_token,
            tokenType: tokenData.token_type || 'Bearer',
            scope: tokenData.scope || null,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: buildExpiresAt(tokenData.expires_in),
        });

        const redirectUrl = await buildCompleteRedirect({ status: 'success', step: 'user-token', redirect: stateData.redirectUrl || '' });
        if (redirectUrl) return res.redirect(redirectUrl);
        res.status(200).send({ status: 'success' });
    } catch (error) {
        const redirectUrl = await buildCompleteRedirect({
            status: 'error',
            message: `App User Token绑定失败: ${error.message}`,
        });
        if (redirectUrl) return res.redirect(redirectUrl);
        next(error);
    }
});

router.get('/github/app/installations/:linkId/repos', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const link = await findUserGitLink(res.locals.userid, req.params.linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const token = (await createInstallationToken(link.installationId)).token;
        if (!token) {
            return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
        }

        const repositories = await listAllInstallationRepos(token);
        res.status(200).send({ status: 'success', repositories });
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/repos', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const links = await getUserGitLinks(res.locals.userid);
        if (!links.length) {
            return res.status(200).send({ status: 'success', repositories: [] });
        }

        const repoBatches = await Promise.all(links.map(async (link) => {
            if (!link?.installationId) return [];
            try {
                const token = (await createInstallationToken(link.installationId)).token;
                if (!token) return [];
                const repositories = await listAllInstallationRepos(token);
                return repositories.map((repo) => ({
                    ...repo,
                    gitLinkId: link.id,
                    gitInstallationId: link.installationId,
                    gitAccount: link.account || null,
                }));
            } catch (error) {
                logger.warn(`[git-sync] list repos failed for link ${link.id}: ${error.message}`);
                return [];
            }
        }));

        const merged = [];
        const seen = new Set();
        for (const batch of repoBatches) {
            for (const repo of batch) {
                const key = repo?.full_name || repo?.name;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(repo);
            }
        }

        res.status(200).send({ status: 'success', repositories: merged });
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/repos/tree', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const linkId = String(req.query.linkId || '').trim();
        const repoOwner = sanitizeRepoOwnerInput(req.query.owner || req.query.repoOwner);
        const repoName = sanitizeRepoNameInput(req.query.repo || req.query.repoName);
        const rawBranch = req.query.branch;
        const branch = rawBranch ? sanitizeBranchInput(rawBranch) : '';
        const rawPath = req.query.path || req.query.dir;
        const repoPath = rawPath ? sanitizeRepoPathInput(rawPath) : '';

        if (!linkId || !repoOwner || !repoName) {
            return res.status(400).send({ status: 'error', message: '缺少仓库参数' });
        }

        if (rawBranch && !branch) {
            return res.status(400).send({ status: 'error', message: '分支名称不合法' });
        }

        if (rawPath && repoPath == null) {
            return res.status(400).send({ status: 'error', message: '路径不合法' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const accountLogin = normalizeRepoValue(link?.account?.login);
        if (accountLogin && accountLogin.toLowerCase() !== repoOwner.toLowerCase()) {
            return res.status(403).send({ status: 'error', message: '只能访问已绑定账号下的仓库' });
        }

        const accountType = normalizeAccountType(link?.account?.type);
        const tokenSource = accountType === 'organization' ? 'installation' : 'user';
        const authContext = {
            tokenSource,
            userId: res.locals.userid,
            accountId: link?.account?.id,
            accountLogin: link?.account?.login,
        };
        let token = null;

        if (accountType === 'organization') {
            const installationToken = (await createInstallationToken(link.installationId)).token;
            if (!installationToken) {
                return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
            }
            token = installationToken;
        } else {
            const userToken = await findUserGitHubUserToken(
                res.locals.userid,
                link?.account?.id,
                link?.account?.login
            );
            if (!userToken?.accessToken) {
                return res.status(400).send({
                    status: 'error',
                    code: 'user_token_required',
                    message: '个人仓库查看需要授权 App User Token',
                });
            }
            token = userToken.accessToken;
        }

        let repoInfo = null;
        let targetBranch = branch || 'main';
        let entries = [];
        let limitExceeded = false;
        const maxChildren = 100;

        try {
            repoInfo = await getRepo(token, repoOwner, repoName);
            targetBranch = branch || repoInfo?.default_branch || 'main';
            try {
                const content = await getContent(token, repoOwner, repoName, repoPath, targetBranch);
                if (Array.isArray(content)) {
                    limitExceeded = content.length > maxChildren;
                    entries = limitExceeded ? content.slice(0, maxChildren) : content;
                } else if (content?.type === 'file') {
                    return res.status(400).send({ status: 'error', message: '路径指向文件，请选择文件夹' });
                } else {
                    entries = [];
                }
            } catch (error) {
                if (isEmptyRepoError(error) || error?.status === 404) {
                    entries = [];
                } else {
                    throw error;
                }
            }
        } catch (error) {
            if (await handleGitHubAuthError(error, res, authContext)) return;
            throw error;
        }

        res.status(200).send({
            status: 'success',
            branch: targetBranch,
            path: repoPath || '',
            limit: maxChildren,
            limitExceeded,
            entries: entries.map((item) => ({
                path: item?.path || '',
                name: item?.name || item?.path || '',
                type: item?.type || '',
                size: item?.size || null,
            })),
        });
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/repos/check', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const linkId = String(req.query.linkId || '').trim();
        const repoName = sanitizeRepoNameInput(req.query.name);
        if (!linkId || !repoName) {
            return res.status(400).send({ status: 'error', message: '缺少仓库名称或账号' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const accountLogin = normalizeRepoValue(link?.account?.login);
        if (!accountLogin) {
            return res.status(400).send({ status: 'error', message: '缺少账号信息' });
        }

        const accountType = normalizeAccountType(link?.account?.type);
        const tokenSource = accountType === 'organization' ? 'installation' : 'user';
        const authContext = {
            tokenSource,
            userId: res.locals.userid,
            accountId: link?.account?.id,
            accountLogin: link?.account?.login,
        };
        let token = null;

        if (accountType === 'organization') {
            const installationToken = (await createInstallationToken(link.installationId)).token;
            if (!installationToken) {
                return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
            }
            token = installationToken;
        } else {
            const userToken = await findUserGitHubUserToken(
                res.locals.userid,
                link?.account?.id,
                link?.account?.login
            );
            if (!userToken?.accessToken) {
                return res.status(400).send({
                    status: 'error',
                    code: 'user_token_required',
                    message: '个人仓库检查需要授权 App User Token',
                });
            }
            token = userToken.accessToken;
        }

        try {
            await getRepo(token, accountLogin, repoName);
            return res.status(200).send({ status: 'success', available: false });
        } catch (error) {
            if (error?.status === 404) {
                return res.status(200).send({ status: 'success', available: true });
            }
            if (await handleGitHubAuthError(error, res, authContext)) return;
            throw error;
        }
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/repos/branches', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const linkId = String(req.query.linkId || '').trim();
        const repoOwner = sanitizeRepoOwnerInput(req.query.owner || req.query.repoOwner);
        const repoName = sanitizeRepoNameInput(req.query.repo || req.query.repoName);

        if (!linkId || !repoOwner || !repoName) {
            return res.status(400).send({ status: 'error', message: '缺少仓库参数' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const accountLogin = normalizeRepoValue(link?.account?.login);
        if (accountLogin && accountLogin.toLowerCase() !== repoOwner.toLowerCase()) {
            return res.status(403).send({ status: 'error', message: '只能访问已绑定账号下的仓库' });
        }

        const accountType = normalizeAccountType(link?.account?.type);
        const tokenSource = accountType === 'organization' ? 'installation' : 'user';
        const authContext = {
            tokenSource,
            userId: res.locals.userid,
            accountId: link?.account?.id,
            accountLogin: link?.account?.login,
        };

        let token = null;
        if (accountType === 'organization') {
            const installationToken = (await createInstallationToken(link.installationId)).token;
            if (!installationToken) {
                return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
            }
            token = installationToken;
        } else {
            const userToken = await findUserGitHubUserToken(
                res.locals.userid,
                link?.account?.id,
                link?.account?.login
            );
            if (!userToken?.accessToken) {
                return res.status(400).send({
                    status: 'error',
                    code: 'user_token_required',
                    message: '个人仓库查看需要授权 App User Token',
                });
            }
            token = userToken.accessToken;
        }

        try {
            const branches = await listBranches(token, repoOwner, repoName, { perPage: 100 });
            const list = Array.isArray(branches) ? branches : [];
            return res.status(200).send({
                status: 'success',
                branches: list.map((branch) => ({
                    name: branch?.name || '',
                    commitSha: branch?.commit?.sha || null,
                })).filter((item) => item.name),
            });
        } catch (error) {
            if (isEmptyRepoError(error)) {
                return res.status(200).send({ status: 'success', branches: [] });
            }
            if (await handleGitHubAuthError(error, res, authContext)) return;
            throw error;
        }
    } catch (error) {
        next(error);
    }
});

router.get('/github/app/repos/search', needLogin, requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        if (!query) {
            return res.status(400).send({ status: 'error', message: '缺少搜索关键词' });
        }

        const perPage = Math.min(50, Math.max(1, Number(req.query.per_page) || 20));
        const page = Math.max(1, Number(req.query.page) || 1);

        const links = await getUserGitLinks(res.locals.userid);
        if (!links.length) {
            return res.status(200).send({ status: 'success', repositories: [] });
        }

        const repoBatches = await Promise.all(links.map(async (link) => {
            if (!link?.installationId) return [];
            try {
                const token = (await createInstallationToken(link.installationId)).token;
                if (!token) return [];
                const allowedRepos = await listAllInstallationRepos(token);
                const allowedMap = new Map(allowedRepos.map((repo) => [repo.full_name, repo]));
                const accountLogin = link?.account?.login;
                const accountType = String(link?.account?.type || '').toLowerCase();
                const scopedQuery = accountLogin
                    ? `${query} ${accountType === 'organization' ? `org:${accountLogin}` : `user:${accountLogin}`}`
                    : query;

                const result = await searchRepos(token, scopedQuery, { perPage, page });
                const items = Array.isArray(result?.items) ? result.items : [];
                const filtered = items.map((item) => {
                    const key = item?.full_name || (item?.owner?.login && item?.name ? `${item.owner.login}/${item.name}` : null);
                    if (!key || !allowedMap.has(key)) return null;
                    const repo = allowedMap.get(key);
                    return {
                        ...repo,
                        gitLinkId: link.id,
                        gitInstallationId: link.installationId,
                        gitAccount: link.account || null,
                    };
                }).filter(Boolean);

                return filtered;
            } catch (error) {
                logger.warn(`[git-sync] search repos failed for link ${link.id}: ${error.message}`);
                return [];
            }
        }));

        const merged = [];
        const seen = new Set();
        for (const batch of repoBatches) {
            for (const repo of batch) {
                const key = repo?.full_name || repo?.name;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(repo);
            }
        }

        res.status(200).send({ status: 'success', repositories: merged });
    } catch (error) {
        next(error);
    }
});

router.post('/github/app/repos/create', needLogin, requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const { linkId, name, description, private: isPrivate } = req.body || {};
        const repoName = sanitizeRepoNameInput(name);
        if (!linkId || !repoName) {
            return res.status(400).send({ status: 'error', message: '缺少仓库名称或账号' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const payload = {
            name: repoName,
        };

        const parsedPrivate = parseBooleanInput(isPrivate);
        if (parsedPrivate !== null) {
            payload.private = parsedPrivate;
        }

        payload.auto_init = true;

        const normalizedDescription = sanitizeDescriptionInput(description);
        if (normalizedDescription) {
            payload.description = normalizedDescription;
        }

        const accountType = normalizeAccountType(link?.account?.type);
        const tokenSource = accountType === 'organization' ? 'installation' : 'user';
        const authContext = {
            tokenSource,
            userId: res.locals.userid,
            accountId: link?.account?.id,
            accountLogin: link?.account?.login,
        };
        const accountLogin = link?.account?.login || '';
        let repository = null;

        if (accountType === 'organization') {
            if (!accountLogin) {
                return res.status(400).send({ status: 'error', message: '缺少组织信息' });
            }
            const token = (await createInstallationToken(link.installationId)).token;
            if (!token) {
                return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
            }
            try {
                repository = await createOrgRepo(token, accountLogin, payload);
            } catch (error) {
                if (await handleGitHubAuthError(error, res, authContext)) return;
                throw error;
            }
        } else {
            const userToken = await findUserGitHubUserToken(
                res.locals.userid,
                link?.account?.id,
                link?.account?.login
            );
            if (!userToken?.accessToken) {
                return res.status(400).send({
                    status: 'error',
                    code: 'user_token_required',
                    message: '个人仓库创建需要授权 App User Token',
                });
            }
            try {
                repository = await createUserRepo(userToken.accessToken, payload);
            } catch (error) {
                if (await handleGitHubAuthError(error, res, authContext)) return;
                throw error;
            }
        }

        res.status(200).send({
            status: 'success',
            repository: {
                ...repository,
                gitLinkId: link.id,
                gitInstallationId: link.installationId,
                gitAccount: link.account || null,
            },
        });
    } catch (error) {
        logger.warn(`[git-sync] create repo failed: ${error.message}`);
        next(error);
    }
});


router.post('/projects/:projectId/provision', needLogin, requireResource("project", "update", "projectId"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        const { linkId, name, description, private: isPrivate, branch, fileName, includeReadme } = req.body || {};

        const repoName = sanitizeRepoNameInput(name || project.name);
        if (!linkId || !repoName) {
            return res.status(400).send({ status: 'error', message: '缺少仓库名称或账号' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const accountType = normalizeAccountType(link?.account?.type);
        const accountLogin = link?.account?.login || '';
        if (!accountLogin) {
            return res.status(400).send({ status: 'error', message: '缺少账号信息' });
        }

        const payload = { name: repoName };
        const parsedPrivate = parseBooleanInput(isPrivate);
        payload.private = parsedPrivate === null ? (project.state === 'private') : parsedPrivate;
        payload.auto_init = true;
        const normalizedDescription = sanitizeDescriptionInput(description || project.description);
        if (normalizedDescription) payload.description = normalizedDescription;

        const authContext = {
            tokenSource: accountType === 'organization' ? 'installation' : 'user',
            userId: res.locals.userid,
            accountId: link?.account?.id,
            accountLogin: link?.account?.login,
        };

        let repository = null;
        try {
            if (accountType === 'organization') {
                const token = (await createInstallationToken(link.installationId)).token;
                if (!token) {
                    return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
                }
                repository = await createOrgRepo(token, accountLogin, payload);
            } else {
                const userToken = await findUserGitHubUserToken(
                    res.locals.userid,
                    link?.account?.id,
                    link?.account?.login
                );
                if (!userToken?.accessToken) {
                    return res.status(400).send({
                        status: 'error',
                        code: 'user_token_required',
                        message: '个人仓库创建需要授权 App User Token',
                    });
                }
                repository = await createUserRepo(userToken.accessToken, payload);
            }
        } catch (error) {
            if (await handleGitHubAuthError(error, res, authContext)) return;
            logger.warn(`[git-sync] provision create repo failed: ${error.message}`);
            return res.status(error?.status || 500).send({
                status: 'error',
                code: 'repo_create_failed',
                message: `仓库创建失败: ${error.message}`,
            });
        }

        const normalizedBranch = branch ? sanitizeBranchInput(branch) : '';
        const resolvedBranch = normalizedBranch || 'main';

        try {
            const finalSettings = await updateProjectGitSyncSettings(project.id, {
                enabled: true,
                provider: 'github',
                linkKind: 'app',
                linkId,
                repoOwner: repository?.owner?.login || accountLogin,
                repoName: repository?.name || repoName,
                branch: resolvedBranch,
                fileName: sanitizeFilenameInput(fileName) || undefined,
                includeReadme: parseBooleanInput(includeReadme) === false ? false : true,
                readmeFileName: undefined,
                disabledReason: null,
            });

            const currentState = await getProjectGitSyncState(project.id);
            await setProjectGitSyncState(project.id, {
                ...(currentState || {}),
                lastError: null,
                disabledReason: null,
            });

            return res.status(200).send({
                status: 'success',
                repository: {
                    ...repository,
                    gitLinkId: link.id,
                    gitInstallationId: link.installationId,
                    gitAccount: link.account || null,
                },
                settings: finalSettings,
            });
        } catch (error) {
            logger.error('[git-sync] provision bind failed:', error.message);
            return res.status(500).send({
                status: 'error',
                code: 'bind_failed',
                message: `仓库已创建，但绑定失败: ${error.message}`,
                repository,
            });
        }
    } catch (error) {
        next(error);
    }
});

router.get('/projects/:projectId', needLogin, requireResource("project", "read", "projectId"), requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        const settings = await getProjectGitSyncSettings(project.id);
        const state = await getProjectGitSyncState(project.id);
        res.status(200).send({
            status: 'success',
            settings,
            state,
            projectType: project.type,
            projectDefaultBranch: project.default_branch || 'main',
            projectName: project.name || '',
            projectTitle: project.title || '',
            projectState: project.state || 'private',
        });
    } catch (error) {
        next(error);
    }
});

router.post('/projects/:projectId/bind', needLogin, requireResource("project", "update", "projectId"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        const {
            linkId,
            repoOwner,
            repoName,
            branch,
            fileName,
            includeReadme,
            enabled,
        } = req.body || {};

        const normalizedOwner = sanitizeRepoOwnerInput(repoOwner);
        const normalizedRepo = sanitizeRepoNameInput(repoName);
        const normalizedBranch = branch ? sanitizeBranchInput(branch) : '';
        if (!linkId || !normalizedOwner || !normalizedRepo) {
            return res.status(400).send({ status: 'error', message: '缺少绑定参数' });
        }

        if (branch && !normalizedBranch) {
            return res.status(400).send({ status: 'error', message: '分支名称不合法' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }

        const accountLogin = normalizeRepoValue(link?.account?.login);
        if (accountLogin && accountLogin.toLowerCase() !== normalizedOwner.toLowerCase()) {
            return res.status(403).send({ status: 'error', message: '只能绑定已授权账号下的仓库' });
        }

        const token = (await createInstallationToken(link.installationId)).token;
        if (!token) {
            return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });
        }

        const repo = await getRepo(token, normalizedOwner, normalizedRepo);
        const parsedIncludeReadme = parseBooleanInput(includeReadme);
        const parsedEnabled = parseBooleanInput(enabled);
        const finalSettings = await updateProjectGitSyncSettings(project.id, {
            enabled: parsedEnabled === null ? true : parsedEnabled,
            provider: 'github',
            linkKind: 'app',
            linkId,
            repoOwner: normalizedOwner,
            repoName: normalizedRepo,
            branch: normalizedBranch || 'main',
            fileName: sanitizeFilenameInput(fileName) || undefined,
            includeReadme: parsedIncludeReadme === null ? true : parsedIncludeReadme,
            readmeFileName: undefined,
            disabledReason: null,
        });

        const currentState = await getProjectGitSyncState(project.id);
        await setProjectGitSyncState(project.id, {
            ...(currentState || {}),
            lastError: null,
            disabledReason: null,
        });

        res.status(200).send({ status: 'success', settings: finalSettings, repo });
    } catch (error) {
        logger.error('[git-sync] bind failed:', error.message);
        next(error);
    }
});

router.post('/projects/:projectId/unbind', needLogin, requireResource("project", "update", "projectId"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        const settings = await updateProjectGitSyncSettings(project.id, {
            enabled: false,
            disabledReason: 'manual_unbind',
        });
        res.status(200).send({ status: 'success', settings });
    } catch (error) {
        next(error);
    }
});

router.post('/projects/:projectId/sync', needLogin, requireResource("project", "update", "projectId"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        const latestCommit = await prisma.ow_projects_commits.findFirst({
            where: { project_id: project.id },
            orderBy: { commit_date: 'desc' },
            select: { id: true },
        });

        if (!latestCommit?.id) {
            return res.status(404).send({ status: 'error', message: '项目暂无提交' });
        }

        const result = await queueManager.enqueueGitSyncCommit(project.id, latestCommit.id, {
            triggeredBy: 'manual',
            actorId: res.locals.userid,
            authorizationContext: requestAuthorization(res),
        });

        res.status(200).send({ status: 'success', result });
    } catch (error) {
        next(error);
    }
});

const blogResyncRateLimit = createRateLimit({
    windowMs: 60 * 1000,
    max: 2,
    prefix: 'rate_limit:blog_sync_resync:',
    message: { status: 'error', message: '全量同步请求过于频繁，请稍后再试' },
});

router.get('/blog/settings', needLogin, requireScope("blog:read"), requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const settings = await getBlogSettings(res.locals.userid);
        const state = await getBlogState(res.locals.userid);
        res.status(200).send({ status: 'success', settings: settings || null, state });
    } catch (error) {
        next(error);
    }
});

router.put('/blog/settings', needLogin, requireScope("blog:update"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const body = req.body || {};
        const linkId = String(body.linkId || '').trim();
        const repoOwner = sanitizeRepoOwnerInput(body.repoOwner);
        const repoName = sanitizeRepoNameInput(body.repoName);
        const branch = body.branch ? sanitizeBranchInput(body.branch) : 'main';
        if (!linkId || !repoOwner || !repoName || !branch) {
            return res.status(400).send({ status: 'error', message: '缺少必要参数' });
        }

        const link = await findUserGitLink(res.locals.userid, linkId);
        if (!link?.installationId) {
            return res.status(404).send({ status: 'error', message: '链接不存在' });
        }
        const accountLogin = String(link?.account?.login || '').trim();
        if (accountLogin && accountLogin.toLowerCase() !== repoOwner.toLowerCase()) {
            return res.status(403).send({ status: 'error', message: '只能绑定已授权账号下的仓库' });
        }

        const token = (await createInstallationToken(link.installationId)).token;
        if (!token) return res.status(500).send({ status: 'error', message: '无法创建安装令牌' });

        let repo;
        try {
            repo = await getRepo(token, repoOwner, repoName);
        } catch (error) {
            if (error?.status === 404) {
                return res.status(404).send({ status: 'error', message: '仓库不存在或无权限访问' });
            }
            throw error;
        }

        const directory = typeof body.directory === 'string' ? body.directory.trim() : '';
        const sanitizedDir = sanitizeRepoPathInput(directory);
        if (sanitizedDir == null) {
            return res.status(400).send({ status: 'error', message: '目录不合法' });
        }

        const fileNameTemplate = String(body.fileNameTemplate || '{slug}.md').trim() || '{slug}.md';
        if (!/^[0-9A-Za-z._{}-]+$/.test(fileNameTemplate)) {
            return res.status(400).send({ status: 'error', message: '文件名模板不合法' });
        }

        const rawFramework = String(body.framework || 'hexo').toLowerCase();
        const framework = rawFramework === 'hugo'
            ? 'hugo'
            : rawFramework === 'valaxy'
                ? 'valaxy'
                : 'hexo';
        const enabled = parseBooleanInput(body.enabled);
        const excludeReadme = parseBooleanInput(body.excludeReadme);
        const allowPrivateToPublic = parseBooleanInput(body.allowPrivateToPublic);

        const fm = body.frontMatter || {};
        const frontMatter = {
            includeTitle: parseBooleanInput(fm.includeTitle) !== false,
            includeDate: parseBooleanInput(fm.includeDate) !== false,
            includeTags: parseBooleanInput(fm.includeTags) !== false,
            includeDescription: parseBooleanInput(fm.includeDescription) !== false,
            extra: fm.extra && typeof fm.extra === 'object' && !Array.isArray(fm.extra) ? fm.extra : {},
        };

        const saved = await setBlogSettings(res.locals.userid, {
            enabled: enabled === null ? true : enabled,
            provider: 'github',
            linkId,
            repoOwner,
            repoName,
            repoIsPublic: !repo.private,
            branch: branch || 'main',
            directory: sanitizedDir,
            framework,
            fileNameTemplate,
            excludeReadme: excludeReadme === null ? true : excludeReadme,
            allowPrivateToPublic: allowPrivateToPublic === true,
            frontMatter,
            disabledReason: null,
        });

        res.status(200).send({ status: 'success', settings: saved });
    } catch (error) {
        logger.error('[blog-sync] update settings failed:', error.message);
        next(error);
    }
});

router.delete('/blog/settings', needLogin, requireScope("blog:update"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const saved = await disableBlogSettings(res.locals.userid, 'manual');
        res.status(200).send({ status: 'success', settings: saved });
    } catch (error) {
        next(error);
    }
});

router.get('/blog/projects', needLogin, requireScope("blog:read"), requireScope("git_sync:read"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const projects = await blogSyncService.listArticleProjects(res.locals.userid);
        const state = await getBlogState(res.locals.userid);
        res.status(200).send({
            status: 'success',
            projects: projects.map((p) => ({
                ...p,
                syncState: state[String(p.id)] || null,
            })),
        });
    } catch (error) {
        next(error);
    }
});

router.post('/blog/resync', needLogin, requireScope("blog:update"), requireScope("git_sync:manage"), blogResyncRateLimit, async (req, res, next) => {
    try {
        const settings = await getBlogSettings(res.locals.userid);
        if (!settings?.enabled) {
            return res.status(400).send({ status: 'error', message: '博客同步未启用' });
        }
        const projects = await blogSyncService.listArticleProjects(res.locals.userid);
        const queued = [];
        if (projects.length) {
            const project = projects[0];
            try {
                const result = await queueManager.enqueueBlogSyncArticle(project.id, res.locals.userid, {
                    reason: 'manual-resync',
                    actorId: res.locals.userid,
                    authorizationContext: requestAuthorization(res),
                });
                queued.push({ projectId: project.id, queued: Boolean(result?.queued) });
            } catch (error) {
                queued.push({ projectId: project.id, queued: false, error: error.message });
            }
        }
        res.status(200).send({ status: 'success', total: projects.length, queued });
    } catch (error) {
        next(error);
    }
});

router.post('/blog/sync/:projectId', needLogin, requireResource("project", "update", "projectId"), requireResource("blog", "update", "projectId"), requireScope("git_sync:manage"), gitSyncRateLimit, async (req, res, next) => {
    try {
        const project = await ensureProjectOwner(req.params.projectId, res.locals.userid, res, req.method === 'GET' ? 'read' : 'update');
        if (String(project.type || '').toLowerCase() !== 'article') {
            return res.status(400).send({ status: 'error', message: '仅支持 article 类型项目' });
        }
        const result = await queueManager.enqueueBlogSyncArticle(project.id, res.locals.userid, {
            reason: 'manual',
            actorId: res.locals.userid,
            authorizationContext: requestAuthorization(res),
        });
        res.status(200).send({ status: 'success', result });
    } catch (error) {
        next(error);
    }
});

export default router;
