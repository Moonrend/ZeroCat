import {Router} from "express";
import {needLogin} from "../middleware/auth.js";
import { requireSudo } from "../middleware/sudo.js";
import { requireResource, requireScope } from "../middleware/scope.js";
import {tokenAuthMiddleware} from "../middleware.js";
import geetestMiddleware from "../middleware/geetest.js";
import {
    emailController,
    loginController,
    oauthController,
    registerController,
    tokenController,
    twoFactorController,
    passkeyController
} from "../controllers/auth/index.js";
import {initializeOAuthProviders} from "../controllers/oauth.js";
import logger from "../services/logger.js";
import zcconfig from "../services/config/zcconfig.js";
import { buildAtprotoAuthClientMetadata } from '../services/social/atprotoAuthOAuth.js';


// 初始化 OAuth 配置
initializeOAuthProviders();

const router = Router();

function requireInteractiveSession(req, res, next) {
    if (res.locals.tokenType !== "session") {
        return res.status(403).json({
            status: "error",
            message: "此操作需要使用网页登录会话",
            code: "ZC_ERROR_SESSION_REQUIRED",
        });
    }
    return next();
}

// 登录相关路由
router.post("/login", geetestMiddleware, loginController.loginWithPassword);
router.post("/send-login-code", geetestMiddleware, loginController.sendLoginCode);
router.post("/login-with-code", loginController.loginWithCode);
router.post("/magiclink/generate", geetestMiddleware, loginController.sendMagicLinkForLogin);
router.get("/magiclink/validate", loginController.validateMagicLinkAndLogin);
router.post("/logout", loginController.logout);
router.post("/logout-all-devices", tokenAuthMiddleware, requireScope("token:manage", { action: "security" }), requireSudo, loginController.logoutAllDevices);
router.get("/logout", (req, res) => {
    res.locals.userid = null;
    res.redirect("/");
});

// 注册和密码管理相关路由
router.get("/register/check", registerController.checkAvailability);
router.post("/register/begin", geetestMiddleware, registerController.beginRegister);
router.get("/register/validate-token", registerController.checkRegisterToken);
router.post("/register/complete", registerController.completeRegister);
router.post("/send-code", geetestMiddleware, registerController.retrievePassword);
router.post("/reset-password", registerController.resetPassword);
router.post("/set-password", needLogin, requireScope("user:update", { action: "security" }), registerController.setPassword);

// 邮箱管理相关路由
router.post("/send-verification-code", needLogin, requireScope("user:update", { action: "security" }), emailController.sendVerificationCode);
router.get("/emails", needLogin, requireScope("user:read"), emailController.getEmails);
router.post("/add-email", needLogin, requireScope("user:update", { action: "security" }), requireSudo, emailController.addEmail);
router.post("/verify-email", needLogin, requireScope("user:update", { action: "security" }), emailController.verifyEmail);
router.post("/remove-email", needLogin, requireScope("user:update", { action: "security" }), requireSudo, emailController.removeEmail);
router.post("/set-primary-email", needLogin, requireScope("user:update", { action: "security" }), requireSudo, emailController.setPrimaryEmail);
// 二次验证（2FA）相关路由
router.get("/2fa/status", needLogin, requireScope("user:read"), twoFactorController.status);
router.post("/2fa/setup", needLogin, requireScope("user:update", { action: "security" }), requireSudo, twoFactorController.setup);
router.post("/2fa/activate", needLogin, requireScope("user:update", { action: "security" }), requireSudo, twoFactorController.activate);
router.post("/2fa/disable", needLogin, requireScope("user:update", { action: "security" }), requireSudo, twoFactorController.disable);
router.post("/2fa/login/totp", twoFactorController.finalizeLoginWithTotp);

// Passkey相关路由
router.post("/passkey/begin-registration", needLogin, requireScope("user:update", { action: "security" }), requireSudo, passkeyController.beginRegistration);
router.post("/passkey/finish-registration", needLogin, requireScope("user:update", { action: "security" }), requireSudo, passkeyController.finishRegistration);
router.post("/passkey/begin-login", passkeyController.beginLogin);
router.post("/passkey/finish-login", passkeyController.finishLogin);
router.post("/passkey/sudo-begin", needLogin, requireInteractiveSession, passkeyController.sudoWithPasskey);
router.post("/passkey/sudo-finish", needLogin, requireInteractiveSession, passkeyController.finalizeSudoWithPasskey);
router.get("/passkey/list", needLogin, requireScope("user:read"), passkeyController.listCredentials);
router.post("/passkey/delete", needLogin, requireScope("user:update", { action: "security" }), requireSudo, passkeyController.deleteCredential);

// OAuth相关路由
router.get("/oauth/providers", oauthController.getOAuthProviders);
router.get('/oauth/bluesky/client-metadata.json', async (req, res) => {
    try {
        const metadata = await buildAtprotoAuthClientMetadata();

        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json(metadata);
    } catch (error) {
        logger.error('[oauth] Build Bluesky client metadata failed:', error);
        res.status(500).json({ status: 'error', message: '生成Bluesky client metadata失败' });
    }
});
// 精确路由必须位于 /oauth/:provider 前，且仅从 HttpOnly Cookie 读取临时令牌。
router.post("/oauth/validate-token", oauthController.validateOAuthLoginToken);
router.get("/oauth/bind/:provider", needLogin, requireScope("user:update", { action: "security" }), oauthController.bindOAuth);
router.get("/oauth/:provider", oauthController.authWithOAuth);
router.get("/oauth/:provider/callback", oauthController.handleOAuthCallbackRequest);
router.post("/oauth/bound", needLogin, requireScope("user:read"), oauthController.getBoundOAuthAccounts);
router.post("/unlink-oauth", needLogin, requireScope("user:update", { action: "security" }), requireSudo, oauthController.unlinkOAuth);

// 令牌管理相关路由
router.post("/refresh-token", tokenController.refreshToken);
router.post("/editor-session", tokenController.issueEditorSession);
router.post("/editor-token", needLogin, tokenController.issueEditorToken);
router.get("/token-details/:tokenId", needLogin, requireResource("token", "read", "tokenId"), tokenController.getTokenDetails);
router.get("/active-tokens", needLogin, requireScope("token:read"), tokenController.getActiveTokens);
router.post("/revoke-token", needLogin, requireResource("token", "manage", "token_id", { action: "security" }), tokenController.revokeToken);

export default router;
