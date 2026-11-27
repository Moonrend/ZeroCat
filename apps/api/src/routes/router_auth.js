import { Router } from 'express';
import { parseToken, needLogin } from '../middleware/auth.js';
import { scopeSatisfies } from '../services/auth/scopes.js';
import { userSatisfiesPolicy } from '../services/auth/policyEngine.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import {
    sendCode,
    auth,
    getAuthMethods
} from '../controllers/auth/unifiedAuthController.js';

const router = Router();

const passwordResetLimiter = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    prefix: 'rate_limit:password_reset:',
    message: {
        status: 'error',
        message: '密码重置请求过于频繁，请稍后再试'
    }
});

const limitPasswordReset = (req, res, next) => {
    if (req.body?.purpose !== 'reset_password') {
        return next();
    }
    return passwordResetLimiter(req, res, next);
};

const AUTHENTICATED_PURPOSE_SCOPES = {
    sudo: null,
    change_email: "user:update",
    delete_account: "user:delete",
};

const requirePurposeAuthorization = (req, res, next) => {
    const { purpose } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(AUTHENTICATED_PURPOSE_SCOPES, purpose)) {
        return next();
    }

    return needLogin(req, res, async () => {
        if (res.locals.tokenType !== "session") {
            return res.status(403).json({
                status: "error",
                message: "此认证目的需要使用网页登录会话",
                code: "ZC_ERROR_SESSION_REQUIRED",
            });
        }

        const requiredScope = AUTHENTICATED_PURPOSE_SCOPES[purpose];
        if (requiredScope && !scopeSatisfies(res.locals.scopes || [], requiredScope)) {
            return res.status(403).json({
                status: "error",
                message: "令牌权限不足",
                code: "ZC_ERROR_INSUFFICIENT_SCOPE",
                required: requiredScope,
            });
        }
        if (requiredScope && !(await userSatisfiesPolicy(res.locals.userid, requiredScope))) {
            return res.status(403).json({
                status: "error",
                message: "账号角色权限不足",
                code: "ZC_ERROR_ROLE_POLICY_FORBIDDEN",
                required: requiredScope,
            });
        }

        return next();
    });
};

// 应用通用中间件
router.use(parseToken);

/**
 * GET /auth/methods
 * 获取可用的认证方法
 * 查询参数: purpose (login, sudo, reset_password, change_email, delete_account)
 */
router.get('/methods', getAuthMethods);

/**
 * POST /auth/send-code
 * 统一发送验证码接口
 * 支持所有认证场景：登录、sudo、重置密码、更改邮箱、删除账户等
 *
 * 请求体:
 * - email: 邮箱地址（可选，某些场景下会自动获取用户邮箱）
 * - purpose: 认证目的 (login, sudo, reset_password, change_email, delete_account)
 * - userId: 用户ID（某些场景下可选，会从登录状态获取）
 */
router.post('/send-code', limitPasswordReset, requirePurposeAuthorization, sendCode);

/**
 * POST /auth/authenticate
 * 统一认证接口
 * 支持多种认证方式和认证目的
 *
 * 请求体:
 * - method: 认证方式 (password, email, totp, passkey)
 * - purpose: 认证目的 (login, sudo, reset_password, change_email, delete_account)
 * - identifier: 用户标识符（用户名或邮箱，login时使用）
 * - userId: 用户ID（非login时使用，某些情况下会从登录状态获取）
 * - password: 密码（password方式）
 * - code_id: 验证码ID（email方式）
 * - code: 验证码（email方式）
 * - new_password: 新密码（reset_password时必填）
 */
router.post('/authenticate', limitPasswordReset, requirePurposeAuthorization, auth);

export default router;
