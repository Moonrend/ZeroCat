import crypto from 'crypto';
import jsonwebtoken from 'jsonwebtoken';
import logger from '../logger.js';
import { prisma } from '../prisma.js';
import { authorize } from '../auth/authorization.js';
import { scopeSatisfies } from '../auth/scopes.js';
import { getEffectiveTokenScopes } from '../auth/tokenService.js';

const WALINE_TOKEN_TTL_SECONDS = 15 * 60;
const WALINE_TOKEN_ISSUER = 'zerocat:commentservice';
const WALINE_TOKEN_PURPOSE = 'waline';

export const WALINE_TOKEN_SCOPES = Object.freeze([
    'comment:read',
    'comment:create',
    'comment:update',
    'comment:delete',
    'comment:interact',
    'comment:manage',
]);

function walineAudience(spaceCuid) {
    return `zerocat:waline:${spaceCuid}`;
}

function hashWalineToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function invalidParentToken(message) {
    const error = new Error(message);
    error.status = 401;
    error.code = 'ZC_ERROR_NEED_LOGIN';
    return error;
}

function sameScopes(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const rightSet = new Set(right);
    return rightSet.size === right.length && left.every(scope => rightSet.has(scope));
}

export function isWalineScopeGranted(scopes, requiredScope) {
    return scopeSatisfies(scopes || [], requiredScope);
}

/**
 * Resolve the comment capabilities allowed by both the source-token ceiling and current account policy.
 */
export async function getWalineEffectiveScopes({ userId, tokenType, tokenScopes }) {
    const candidates = WALINE_TOKEN_SCOPES.filter(scope => scopeSatisfies(tokenScopes || [], scope));
    const decisions = await Promise.all(candidates.map(requiredScope => authorize({
        userId,
        requiredScope,
        tokenType,
        tokenScopes: tokenScopes || [],
    })));
    return candidates.filter((_scope, index) => decisions[index].allowed);
}

/**
 * Issue a short-lived, space-bound Waline credential linked to its live ZeroCat parent token.
 */
export async function createWalineToken({ userId, jwtSecret, spaceId, spaceCuid, parentTokenId }) {
    const normalizedUserId = Number(userId);
    const normalizedParentTokenId = Number(parentTokenId);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0
        || !Number.isSafeInteger(normalizedParentTokenId) || normalizedParentTokenId <= 0) {
        throw invalidParentToken('父令牌无效');
    }

    const parentToken = await prisma.ow_tokens.findUnique({
        where: { id: normalizedParentTokenId },
        select: {
            id: true,
            user_id: true,
            type: true,
            scopes: true,
            revoked: true,
            expires_at: true,
            user: { select: { status: true } },
        },
    });
    const now = Date.now();
    if (!parentToken || parentToken.user_id !== normalizedUserId || parentToken.revoked
        || parentToken.user?.status !== 'active'
        || (parentToken.expires_at && parentToken.expires_at.getTime() <= now)) {
        throw invalidParentToken('父令牌已失效');
    }

    const parentScopes = await getEffectiveTokenScopes({
        userId: normalizedUserId,
        type: parentToken.type,
        scopes: parentToken.scopes,
    });
    const scopes = await getWalineEffectiveScopes({
        userId: normalizedUserId,
        tokenType: parentToken.type,
        tokenScopes: parentScopes,
    });
    if (!isWalineScopeGranted(scopes, 'comment:create')) {
        throw invalidParentToken('父令牌不再具有发表评论权限');
    }

    const parentTtl = parentToken.expires_at
        ? Math.floor((parentToken.expires_at.getTime() - now) / 1000)
        : WALINE_TOKEN_TTL_SECONDS;
    const expiresIn = Math.min(WALINE_TOKEN_TTL_SECONDS, parentTtl);
    if (expiresIn <= 0) throw invalidParentToken('父令牌已过期');

    const jti = crypto.randomBytes(16).toString('hex');
    const token = jsonwebtoken.sign(
        {
            purpose: WALINE_TOKEN_PURPOSE,
            spaceCuid,
            parentTokenId: normalizedParentTokenId,
            scopes,
        },
        jwtSecret,
        {
            algorithm: 'HS256',
            audience: walineAudience(spaceCuid),
            issuer: WALINE_TOKEN_ISSUER,
            subject: String(normalizedUserId),
            jwtid: jti,
            expiresIn,
        },
    );
    const expiresAt = new Date(now + expiresIn * 1000);

    await prisma.ow_comment_tokens.create({
        data: {
            jti,
            token_hash: hashWalineToken(token),
            user_id: normalizedUserId,
            space_id: spaceId,
            parent_token_id: normalizedParentTokenId,
            scopes,
            expires_at: expiresAt,
        },
    });

    return token;
}

/**
 * Verify token claims and the live derived/parent token records before restoring Waline identity.
 */
export async function verifyWalineToken(token, jwtSecret, { spaceId, spaceCuid }) {
    try {
        const payload = jsonwebtoken.verify(token, jwtSecret, {
            algorithms: ['HS256'],
            audience: walineAudience(spaceCuid),
            issuer: WALINE_TOKEN_ISSUER,
        });
        const userId = Number(payload?.sub);
        const parentTokenId = Number(payload?.parentTokenId);
        const scopes = payload?.scopes;
        if (!payload || typeof payload !== 'object'
            || payload.purpose !== WALINE_TOKEN_PURPOSE
            || payload.spaceCuid !== spaceCuid
            || !Number.isSafeInteger(userId) || userId <= 0
            || !Number.isSafeInteger(parentTokenId) || parentTokenId <= 0
            || typeof payload.jti !== 'string' || !/^[a-f0-9]{32}$/.test(payload.jti)
            || !Array.isArray(scopes) || new Set(scopes).size !== scopes.length
            || scopes.some(scope => !WALINE_TOKEN_SCOPES.includes(scope))) {
            return { valid: false, userId: null, scopes: [] };
        }

        const record = await prisma.ow_comment_tokens.findUnique({
            where: { token_hash: hashWalineToken(token) },
            select: {
                jti: true,
                user_id: true,
                space_id: true,
                parent_token_id: true,
                scopes: true,
                expires_at: true,
                revoked_at: true,
                parent_token: {
                    select: {
                        id: true,
                        user_id: true,
                        type: true,
                        scopes: true,
                        revoked: true,
                        expires_at: true,
                        user: { select: { status: true } },
                    },
                },
            },
        });
        const now = Date.now();
        const parentToken = record?.parent_token;
        if (!record || record.revoked_at || record.expires_at.getTime() <= now
            || record.jti !== payload.jti || record.user_id !== userId || record.space_id !== spaceId
            || record.parent_token_id !== parentTokenId || !sameScopes(scopes, record.scopes)
            || !parentToken || parentToken.id !== parentTokenId || parentToken.user_id !== userId
            || parentToken.revoked || parentToken.user?.status !== 'active'
            || (parentToken.expires_at && parentToken.expires_at.getTime() <= now)) {
            return { valid: false, userId: null, scopes: [] };
        }

        const parentScopes = await getEffectiveTokenScopes({
            userId,
            type: parentToken.type,
            scopes: parentToken.scopes,
        });
        const currentlyAllowed = await getWalineEffectiveScopes({
            userId,
            tokenType: parentToken.type,
            tokenScopes: parentScopes,
        });
        const effectiveScopes = scopes.filter(scope => isWalineScopeGranted(currentlyAllowed, scope));

        return { valid: true, userId, scopes: effectiveScopes, jti: payload.jti, parentTokenId };
    } catch (err) {
        logger.debug(`[walineAuth] JWT验证失败: ${err.message}`);
        return { valid: false, userId: null, scopes: [] };
    }
}

/** Revoke only the presented derived Waline token; the parent login/API token remains active. */
export async function revokeWalineToken(token) {
    if (typeof token !== 'string' || !token) return false;
    const result = await prisma.ow_comment_tokens.updateMany({
        where: { token_hash: hashWalineToken(token), revoked_at: null },
        data: { revoked_at: new Date() },
    });
    return result.count > 0;
}

export default {
    createWalineToken,
    verifyWalineToken,
    revokeWalineToken,
    isWalineScopeGranted,
    getWalineEffectiveScopes,
};
