import logger from "../../services/logger.js";
import {prisma} from "../../services/prisma.js";
import crypto from "crypto";
import memoryCache from "../../services/memoryCache.js";
import {
    generateAuthUrl,
    handleOAuthCallback,
    handleOAuthSyncBind,
    OAUTH_PROVIDERS,
    resolveTwitterOAuthStateByRequestToken,
} from "../oauth.js";
import {getAtprotoAuthAppStateByCallbackState} from "../../services/social/atprotoAuthOAuth.js";
import zcconfig from "../../services/config/zcconfig.js";
import {
    createTemporaryToken,
    invalidateTemporaryToken,
    validateTemporaryToken,
} from "../../services/auth/verification.js";
import tokenUtils from "../../services/auth/tokenUtils.js";

const BLUESKY_SCOPE_LOGIN = 'atproto transition:email';
const BLUESKY_SCOPE_BIND = 'atproto transition:generic transition:email';
const OAUTH_TRANSACTION_TTL_SECONDS = 600;
const OAUTH_TRANSACTION_COOKIE_PREFIX = 'oauth_transaction_';
const OAUTH_LOGIN_TOKEN_COOKIE = 'oauth_login_token';
const OAUTH_COOKIE_PATH = '/account/oauth';
const OAUTH_LOGIN_TOKEN_PATH = '/account/oauth/validate-token';

function isLocalHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase();
    return !normalized || normalized === 'localhost' || normalized.endsWith('.localhost') ||
        normalized === '::1' || normalized === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isSecureCookieRequest(req) {
    const hostname = req?.hostname || String(req?.headers?.host || '').split(':')[0];
    // OAuth transactions require Secure cookies everywhere except explicit local development.
    return !isLocalHostname(hostname);
}

function transactionCookieName(state) {
    const stateDigest = crypto.createHash('sha256').update(String(state || '')).digest('hex');
    return `${OAUTH_TRANSACTION_COOKIE_PREFIX}${stateDigest}`;
}

function hashBrowserBinding(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function buildTransactionCookieOptions(req) {
    return {
        httpOnly: true,
        secure: isSecureCookieRequest(req),
        sameSite: 'lax',
        path: OAUTH_COOKIE_PATH,
    };
}

function buildLoginTokenCookieOptions(req) {
    const secure = isSecureCookieRequest(req);
    return {
        httpOnly: true,
        secure,
        // Cross-site frontend deployments need None; same-site and local deployments use Lax.
        sameSite: secure ? 'none' : 'lax',
        path: OAUTH_LOGIN_TOKEN_PATH,
    };
}

function createBrowserBoundTransaction(req, res, state) {
    const browserBinding = crypto.randomBytes(32).toString('hex');
    res.cookie(transactionCookieName(state), browserBinding, {
        ...buildTransactionCookieOptions(req),
        maxAge: OAUTH_TRANSACTION_TTL_SECONDS * 1000,
    });
    return hashBrowserBinding(browserBinding);
}

function clearBrowserBoundTransaction(req, res, state) {
    res.clearCookie(transactionCookieName(state), buildTransactionCookieOptions(req));
}

function prepareBrowserBoundTransactionForRedemption(req, res, state) {
    const cookieName = transactionCookieName(state);
    const browserBinding = req.cookies?.[cookieName];
    if (!browserBinding) return;

    const secure = isSecureCookieRequest(req);
    res.cookie(cookieName, browserBinding, {
        ...buildTransactionCookieOptions(req),
        // The frontend may be on another site and redeems through a credentialed request.
        sameSite: secure ? 'none' : 'lax',
        maxAge: OAUTH_TRANSACTION_TTL_SECONDS * 1000,
    });
}

function hasBrowserBinding(req, state, expectedHash) {
    if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) return false;

    const browserBinding = req.cookies?.[transactionCookieName(state)];
    if (typeof browserBinding !== 'string' || !browserBinding) return false;

    const actual = Buffer.from(hashBrowserBinding(browserBinding), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hasValidOAuthTransaction(req, cachedState, state, provider) {
    const flow = cachedState?.type === 'bind'
        ? 'bind'
        : cachedState?.type === 'login'
            ? 'login'
            : null;
    const currentRedirectUri = String(OAUTH_PROVIDERS[provider]?.redirectUri || '');

    return Boolean(
        flow &&
        cachedState?.flow === flow &&
        cachedState?.provider === provider &&
        cachedState?.redirectUri &&
        cachedState.redirectUri === currentRedirectUri &&
        hasBrowserBinding(req, state, cachedState.browserBindingHash)
    );
}

function hasValidOAuthLoginRedemption(req, transaction) {
    const provider = transaction?.provider;
    const currentRedirectUri = String(OAUTH_PROVIDERS[provider]?.redirectUri || '');
    return Boolean(
        transaction?.flow === 'login' &&
        transaction?.state &&
        transaction?.redirectUri &&
        transaction.redirectUri === currentRedirectUri &&
        hasBrowserBinding(req, transaction.state, transaction.browserBindingHash)
    );
}

function setOAuthLoginTokenCookie(req, res, token) {
    res.cookie(OAUTH_LOGIN_TOKEN_COOKIE, token, {
        ...buildLoginTokenCookieOptions(req),
        maxAge: OAUTH_TRANSACTION_TTL_SECONDS * 1000,
    });
}

function clearOAuthLoginTokenCookie(req, res) {
    res.clearCookie(OAUTH_LOGIN_TOKEN_COOKIE, buildLoginTokenCookieOptions(req));
}

function resolveBlueskyScope(flow) {
    return flow === 'bind' ? BLUESKY_SCOPE_BIND : BLUESKY_SCOPE_LOGIN;
}

/**
 * 获取支持的OAuth提供商列表
 */
export const getOAuthProviders = async (req, res) => {
    const providers = Object.values(OAUTH_PROVIDERS)
        .filter((provider) => provider.enabled) // 只返回已启用的提供商
        .map((provider) => ({
            id: provider.id,
            name: provider.name,
            type: provider.type,
            enabled: provider.enabled
        }));

    res.status(200).json({
        status: "success",
        data: providers,
    });
};

/**
 * 处理OAuth绑定请求
 */
export const bindOAuth = async (req, res) => {
    try {
        const {provider} = req.params;
        const identifier = provider === 'bluesky'
            ? String(req.query?.identifier || req.query?.account || req.query?.domain || req.query?.pds || '').trim()
            : '';
        const blueskyScope = provider === 'bluesky' ? resolveBlueskyScope('bind') : null;
        if (!OAUTH_PROVIDERS[provider]) {
            return res.status(400).json({
                status: "error",
                message: "不支持的 OAuth 提供商",
            });
        }

        const state =
            crypto.randomBytes(16).toString("hex") + `:bind:${res.locals.userid}`;
        const authUrl = await generateAuthUrl(provider, state, {
            ...(identifier ? { identifier } : {}),
            ...(blueskyScope ? { scope: blueskyScope } : {}),
            ...(provider === 'bluesky' ? { flow: 'auth' } : {}),
        });
        const browserBindingHash = createBrowserBoundTransaction(req, res, state);

        // 存储 state 与用户 ID 的映射，用于回调时识别绑定操作
        // 对 Bluesky：库会生成自己的内部 state，回调处理器通过 stateStore 解析出 appState 来查找此条目
        memoryCache.set(
            `oauth_state:${state}`,
            {
                type: 'bind',
                flow: 'bind',
                provider,
                redirectUri: OAUTH_PROVIDERS[provider].redirectUri,
                browserBindingHash,
                userId: res.locals.userid,
                context: {
                    ...(identifier ? { identifier } : {}),
                    ...(blueskyScope ? { scope: blueskyScope } : {}),
                },
            },
            600
        ); // 10分钟有效期

        res.redirect(authUrl);
    } catch (error) {
        logger.error("OAuth 绑定请求错误:", error);
        if (error?.code === 'ATPROTO_SERVICE_UNAVAILABLE') {
            return res.status(503).json({
                status: "error",
                message: "Bluesky 服务暂时不可达，请稍后重试",
            });
        }
        res.status(500).json({
            status: "error",
            message: "绑定请求失败",
        });
    }
};

/**
 * 处理OAuth登录请求
 */
export const authWithOAuth = async (req, res) => {
    try {
        const {provider} = req.params;
        const tokenPurpose = 'auth';
        const redirect = req.query?.redirect || null;
        const identifier = provider === 'bluesky'
            ? String(req.query?.identifier || req.query?.account || req.query?.domain || req.query?.pds || '').trim()
            : '';
        const blueskyScope = provider === 'bluesky' ? resolveBlueskyScope('login') : null;
        if (!OAUTH_PROVIDERS[provider]) {
            logger.error("不支持的 OAuth 提供商:", provider);
            return res.status(400).json({
                status: "error",
                message: "不支持的 OAuth 提供商",
            });
        }

        const state = crypto.randomBytes(16).toString("hex");
        const authUrl = await generateAuthUrl(provider, state, {
            ...(identifier ? { identifier } : {}),
            ...(blueskyScope ? { scope: blueskyScope } : {}),
            ...(provider === 'bluesky' ? { flow: 'auth' } : {}),
        });
        const browserBindingHash = createBrowserBoundTransaction(req, res, state);

        // 存储 state 用于验证回调
        // 对 Bluesky：库会生成自己的内部 state，回调处理器通过 stateStore 解析出 appState 来查找此条目
        memoryCache.set(
            `oauth_state:${state}`,
            {
                type: 'login',
                flow: 'login',
                provider,
                redirectUri: OAUTH_PROVIDERS[provider].redirectUri,
                browserBindingHash,
                context: {
                    tokenPurpose,
                    redirect,
                    ...(identifier ? { identifier } : {}),
                    ...(blueskyScope ? { scope: blueskyScope } : {}),
                },
            },
            600
        ); // 10分钟有效期

        res.redirect(authUrl);
    } catch (error) {
        logger.error("OAuth authorization error:", error);
        if (error?.code === 'ATPROTO_SERVICE_UNAVAILABLE') {
            return res.status(503).json({
                status: "error",
                message: "Bluesky 服务暂时不可达，请稍后重试",
            });
        }
        res.status(500).json({
            status: "error",
            message: "授权请求失败",
        });
    }
};

/**
 * 处理OAuth回调
 */
export const handleOAuthCallbackRequest = async (req, res) => {
    const frontendUrl = await zcconfig.get("urls.frontend");

    const redirectTo = (path, message) => {
        const url = message
            ? `${frontendUrl}${path}?message=${encodeURIComponent(message)}`
            : `${frontendUrl}${path}`;
        return res.redirect(url);
    };

    try {
        const {provider} = req.params;
        const {
            code,
            state,
            oauth_token: oauthToken,
            oauth_verifier: oauthVerifier,
            error,
            error_description: errorDescription,
        } = req.query;

        const authCode = provider === 'twitter' ? oauthVerifier : code;

        logger.debug(`[oauthController] 接收OAuth回调: provider=${provider}, code=${authCode?.substring(0, 10)}...`);

        let resolvedState = state;

        if (provider === 'twitter' && !resolvedState && oauthToken) {
            resolvedState = resolveTwitterOAuthStateByRequestToken(oauthToken);
            if (resolvedState) {
                logger.debug(`[oauthController] Twitter state resolved by oauth_token: ${oauthToken} -> ${resolvedState}`);
            }
        }

        if (!resolvedState) {
            logger.warn('[oauthController] 无效的OAuth回调请求: 缺少state');
            return redirectTo('/app/account/oauth/login/error', '无效的请求参数');
        }

        // 对 Bluesky：回调中的 state 是库内部生成的随机值，需先解析出业务 appState
        if (provider === 'bluesky') {
            const appState = await getAtprotoAuthAppStateByCallbackState(state);
            if (appState) {
                resolvedState = appState;
                logger.debug(`[oauthController] Bluesky state resolved: callbackState=${state} -> appState=${appState}`);
            }
        }

        if (error) {
            const reason = String(errorDescription || error || 'OAuth授权失败');
            const syncState = provider === 'bluesky' ? memoryCache.get(`bluesky_sync_state:${resolvedState}`) : null;
            const cachedStateForError = memoryCache.get(`oauth_state:${resolvedState}`);

            if (syncState) {
                memoryCache.delete(`bluesky_sync_state:${resolvedState}`);
                logger.warn(`[oauthController] Bluesky同步授权被拒绝: ${reason}`);
                return redirectTo('/app/account/social/sync/bluesky/error', reason);
            }

            if (cachedStateForError) {
                if (!hasValidOAuthTransaction(req, cachedStateForError, resolvedState, provider)) {
                    logger.warn(`[oauthController] OAuth拒绝回调的事务绑定验证失败: provider=${provider}`);
                    return redirectTo('/app/account/oauth/login/error', '无效的OAuth事务');
                }
                memoryCache.delete(`oauth_state:${resolvedState}`);
                clearBrowserBoundTransaction(req, res, resolvedState);
                const path = cachedStateForError.type === 'bind'
                    ? '/app/account/oauth/bind/error'
                    : '/app/account/oauth/login/error';
                logger.warn(`[oauthController] OAuth授权被拒绝: provider=${provider}, type=${cachedStateForError.type}, reason=${reason}`);
                return redirectTo(path, reason);
            }

            logger.warn(`[oauthController] OAuth授权被拒绝且state未命中缓存: provider=${provider}, state=${state}, reason=${reason}`);
            return redirectTo('/app/account/oauth/login/error', reason);
        }

        if (!authCode) {
            logger.warn('[oauthController] 无效的OAuth回调请求: 缺少code/verifier');
            return redirectTo('/app/account/oauth/login/error', '无效的请求参数');
        }

        const cachedState = memoryCache.get(`oauth_state:${resolvedState}`);

        // 检查是否为 Bluesky 同步授权回调（独立 state key，与登录/绑定隔离）
        if (!cachedState && provider === 'bluesky') {
            const syncState = memoryCache.get(`bluesky_sync_state:${resolvedState}`);
            if (syncState) {
                const userIdToSync = syncState.userId;
                logger.info(`[oauthController] 处理Bluesky同步令牌回调: userId=${userIdToSync}`);
                memoryCache.delete(`bluesky_sync_state:${resolvedState}`);

                try {
                    const syncResult = await handleOAuthSyncBind(provider, code, userIdToSync, {
                        identifier: syncState.identifier || syncState.pds || '',
                        state: String(state),
                        iss: req.query?.iss,
                        callbackQuery: req.query,
                        scope: syncState.scope,
                    });

                    if (syncResult.success) {
                        logger.info(`[oauthController] Bluesky同步令牌绑定成功: userId=${userIdToSync}`);
                        return redirectTo('/app/account/social/sync/bluesky/success');
                    } else {
                        logger.warn(`[oauthController] Bluesky同步令牌绑定失败: ${syncResult.message}`);
                        return redirectTo('/app/account/social/sync/bluesky/error', syncResult.message);
                    }
                } catch (error) {
                    logger.error(`[oauthController] Bluesky同步令牌绑定异常:`, error);
                    return redirectTo('/app/account/social/sync/bluesky/error', 'Bluesky同步绑定失败: ' + error.message);
                }
            }
        }

        if (!cachedState || !hasValidOAuthTransaction(req, cachedState, resolvedState, provider)) {
            logger.warn(`[oauthController] state或事务绑定验证失败: state=${state}, resolvedState=${resolvedState}, provider=${provider}`);
            return redirectTo('/app/account/oauth/login/error', '无效的state');
        }

        // state 一次性消费；登录事务 Cookie 保留到前端兑换临时令牌时再次验证。
        memoryCache.delete(`oauth_state:${resolvedState}`);

        // 根据 state 的类型处理不同的逻辑
        if (cachedState.type === "bind") {
            // ---- 身份绑定（创建/更新 oauth 联系方式，保存 auth 令牌）----
            const userIdToBind = cachedState.userId;
            logger.info(`[oauthController] 处理OAuth身份绑定回调: provider=${provider}, userId=${userIdToBind}`);
            clearBrowserBoundTransaction(req, res, resolvedState);

            try {
                const bindingResult = await handleOAuthCallback(
                    provider,
                    authCode,
                    userIdToBind,
                    {
                        ...(cachedState?.context || {}),
                        state: String(resolvedState),
                        ...(provider === 'twitter' && oauthToken ? { oauthToken: String(oauthToken) } : {}),
                        iss: req.query?.iss,
                        callbackQuery: req.query,
                    }
                );

                if (bindingResult.success) {
                    logger.info(`[oauthController] OAuth身份绑定成功: provider=${provider}, userId=${userIdToBind}`);
                    return redirectTo('/app/account/oauth/bind/success');
                } else {
                    logger.warn(`[oauthController] OAuth身份绑定失败: ${bindingResult.message}`);
                    return redirectTo('/app/account/oauth/bind/error', bindingResult.message);
                }
            } catch (error) {
                logger.error(`[oauthController] OAuth身份绑定过程发生异常:`, error);
                return redirectTo('/app/account/oauth/bind/error', 'OAuth绑定失败: ' + error.message);
            }
        } else {
            // 登录/注册操作
            logger.info(`[oauthController] 处理OAuth登录/注册回调: provider=${provider}`);

            try {
                const callbackResult = await handleOAuthCallback(
                    provider,
                    authCode,
                    null,
                    {
                        ...(cachedState?.context || {}),
                        state: String(resolvedState),
                        ...(provider === 'twitter' && oauthToken ? { oauthToken: String(oauthToken) } : {}),
                        iss: req.query?.iss,
                        callbackQuery: req.query,
                    }
                );

                if (callbackResult && callbackResult.user && callbackResult.contact) {
                    const {user, contact} = callbackResult;

                    // contact 已经是主邮箱联系方式（由 handleOAuthCallback 返回）
                    const email = contact.contact_type === 'email' ? contact.contact_value : null;

                    // 准备要存储的用户数据
                    const userData = {
                        userid: parseInt(user.id),
                        username: user.username,
                        display_name: user.display_name,
                        avatar: user.avatar,
                        email: email
                    };

                    // 创建临时令牌，用途为oauth_login
                    let tempToken;
                    try {
                        const oauthTransaction = {
                            state: String(resolvedState),
                            provider,
                            flow: 'login',
                            redirectUri: cachedState.redirectUri,
                            browserBindingHash: cachedState.browserBindingHash,
                        };
                        const tokenResult = await createTemporaryToken(
                            user.id,
                            'oauth_login',
                            {userData, oauthTransaction},
                            OAUTH_TRANSACTION_TTL_SECONDS
                        );
                        if (!tokenResult.success) {
                            logger.error(`[oauthController] 创建临时令牌失败: ${tokenResult.message}`);
                            clearBrowserBoundTransaction(req, res, resolvedState);
                            return redirectTo('/app/account/oauth/login/error', '创建会话令牌失败');
                        }
                        tempToken = tokenResult.token;
                    } catch (tokenError) {
                        logger.error(`[oauthController] 创建临时令牌异常:`, tokenError);
                        clearBrowserBoundTransaction(req, res, resolvedState);
                        return redirectTo('/app/account/oauth/login/error', '会话创建失败');
                    }

                    logger.info(`[oauthController] OAuth登录/注册成功: userId=${user.id}, username=${user.username}, provider=${provider}`);

                    // 临时令牌仅通过 HttpOnly Cookie 传递，不进入浏览器历史或回调 URL。
                    prepareBrowserBoundTransactionForRedemption(req, res, resolvedState);
                    setOAuthLoginTokenCookie(req, res, tempToken);
                    let callbackUrl = `${frontendUrl}/app/account/oauth/callback`;
                    const savedRedirect = cachedState?.context?.redirect;
                    if (savedRedirect) {
                        callbackUrl += `?redirect=${encodeURIComponent(savedRedirect)}`;
                    }
                    return res.redirect(callbackUrl);
                } else {
                    logger.error(`[oauthController] OAuth回调结果无效:`, callbackResult);
                    clearBrowserBoundTransaction(req, res, resolvedState);
                    return redirectTo('/app/account/oauth/login/error', '登录失败: 无效的OAuth响应');
                }
            } catch (error) {
                logger.error(`[oauthController] OAuth登录/注册过程发生异常:`, error);
                clearBrowserBoundTransaction(req, res, resolvedState);
                const errorMsg = error.message || '登录失败';
                return redirectTo('/app/account/oauth/login/error', 'OAuth登录失败: ' + errorMsg);
            }
        }
    } catch (error) {
        logger.error("[oauthController] OAuth 回调处理发生未预期的错误:", error);
        logger.error(`[oauthController] 错误堆栈: ${error.stack}`);
        try {
            return res.redirect(
                `${frontendUrl}/app/account/oauth/login/error?message=${encodeURIComponent('系统错误: OAuth处理失败')}`
            );
        } catch (redirectError) {
            res.status(500).json({
                status: "error",
                message: "OAuth处理失败"
            });
        }
    }
};

/**
 * 使用同一浏览器的 OAuth 事务 Cookie 兑换一次性登录令牌。
 */
export const validateOAuthLoginToken = async (req, res) => {
    const token = req.cookies?.[OAUTH_LOGIN_TOKEN_COOKIE];

    if (!token) {
        logger.warn('OAuth登录请求中未提供临时令牌Cookie');
        return res.status(400).json({
            status: "error",
            message: "未提供令牌"
        });
    }

    try {
        let tokenResult;
        try {
            tokenResult = await validateTemporaryToken(token, 'oauth_login');
        } catch (validationError) {
            logger.error(`OAuth临时令牌验证函数抛出异常: ${validationError.message}`);
            return res.status(500).json({
                status: "error",
                message: "令牌验证处理异常"
            });
        }

        if (!tokenResult.success) {
            clearOAuthLoginTokenCookie(req, res);
            logger.warn(`OAuth临时令牌验证失败: ${tokenResult.message}`);
            return res.status(401).json({
                status: "error",
                message: tokenResult.message || "令牌验证失败"
            });
        }

        const oauthTransaction = tokenResult.data?.oauthTransaction;
        if (!hasValidOAuthLoginRedemption(req, oauthTransaction)) {
            clearOAuthLoginTokenCookie(req, res);
            if (oauthTransaction?.state) {
                clearBrowserBoundTransaction(req, res, oauthTransaction.state);
            }
            logger.warn('OAuth临时令牌的浏览器事务绑定验证失败');
            return res.status(401).json({
                status: "error",
                message: "无效的OAuth事务"
            });
        }

        if (!tokenResult.data?.userData) {
            clearOAuthLoginTokenCookie(req, res);
            clearBrowserBoundTransaction(req, res, oauthTransaction.state);
            logger.error('OAuth临时令牌数据中缺少userData字段');
            return res.status(500).json({
                status: "error",
                message: "令牌数据格式错误"
            });
        }

        const userData = tokenResult.data.userData;
        let user;
        try {
            user = await prisma.ow_users.findUnique({
                where: {id: userData.userid}
            });
        } catch (dbError) {
            logger.error(`查询OAuth登录用户错误: ${dbError.message}`);
            return res.status(500).json({
                status: "error",
                message: "查询用户信息失败"
            });
        }

        if (!user) {
            clearOAuthLoginTokenCookie(req, res);
            clearBrowserBoundTransaction(req, res, oauthTransaction.state);
            logger.error(`找不到OAuth临时令牌对应的用户: ${userData.userid}`);
            return res.status(404).json({
                status: "error",
                message: "用户不存在"
            });
        }

        let loginTokenResult;
        try {
            const userInfo = await tokenUtils.getUserInfoForToken(user, userData.email);
            loginTokenResult = await tokenUtils.createUserLoginTokens(
                user.id,
                userInfo,
                req.ip,
                req.headers['user-agent'],
                {
                    recordLoginEvent: true,
                    loginMethod: 'oauth'
                }
            );

            if (!loginTokenResult.success) {
                logger.error(`创建OAuth登录令牌失败: ${loginTokenResult.message}`);
                return res.status(500).json({
                    status: "error",
                    message: "创建登录令牌失败"
                });
            }
        } catch (tokenError) {
            logger.error(`创建OAuth会话令牌失败: ${tokenError.message}`, tokenError);
            return res.status(500).json({
                status: "error",
                message: "创建会话令牌失败"
            });
        }

        try {
            await invalidateTemporaryToken(token);
        } catch (invalidateError) {
            logger.warn(`OAuth临时令牌失效处理出错(非致命): ${invalidateError.message}`);
        }

        clearOAuthLoginTokenCookie(req, res);
        clearBrowserBoundTransaction(req, res, oauthTransaction.state);
        logger.info(`用户 ${user.id} 使用浏览器绑定的OAuth临时令牌登录成功`);

        const response = tokenUtils.generateLoginResponse(user, loginTokenResult, userData.email);
        return tokenUtils.respondWithBrowserAuthTokens(res, response);
    } catch (error) {
        logger.error(`处理OAuth临时令牌请求时出错: ${error.message}`, error);
        return res.status(500).json({
            status: "error",
            message: "令牌验证过程中发生错误"
        });
    }
};

/**
 * 获取用户绑定的OAuth账号
 */
export const getBoundOAuthAccounts = async (req, res) => {
    try {
        const userId = res.locals.userid;

        // 查找用户的所有 OAuth 联系方式
        const oauthContacts = await prisma.ow_users_contacts.findMany({
            where: {
                user_id: userId,
                contact_type: {
                    in: [
                        "oauth_google",
                        "oauth_houlang",
                        "oauth_microsoft",
                        "oauth_github",
                        "oauth_linuxdo",
                        "oauth_40code",
                        "oauth_twitter",
                        "oauth_bluesky",
                    ], // 只查找 OAuth 联系方式
                },
            },
            select: {
                contact_id: true,
                contact_type: true,
                is_primary: true,
                verified: true,
                created_at: true,
                updated_at: true,
                metadata: true,
            },
        });

        return res.status(200).json({
            status: "success",
            data: oauthContacts,
        });
    } catch (error) {
        logger.error("获取绑定的 OAuth 账号时出错:", error);
        return res.status(500).json({
            status: "error",
            message: "获取绑定的 OAuth 账号失败",
        });
    }
};

/**
 * 解绑OAuth账号
 */
export const unlinkOAuth = async (req, res) => {
    try {
        const {provider} = req.body;

        if (!provider) {
            return res.status(200).json({
                status: "error",
                message: "OAuth 提供商是必需的",
            });
        }

        // 查找 OAuth 联系方式
        const contact = await prisma.ow_users_contacts.findFirst({
            where: {
                user_id: res.locals.userid,
                contact_type: provider,
            },
        });

        if (!contact) {
            return res.status(200).json({
                status: "error",
                message: "未找到此 OAuth 联系方式",
            });
        }

        // 删除 OAuth 联系方式
        await prisma.ow_users_contacts.delete({
            where: {contact_id: contact.contact_id},
        });

        return res.status(200).json({
            status: "success",
            message: "成功解绑 OAuth 账号",
        });
    } catch (error) {
        logger.error("解绑 OAuth 账号时出错:", error);
        return res.status(200).json({
            status: "error",
            message: error.message || "解绑失败",
        });
    }
};
