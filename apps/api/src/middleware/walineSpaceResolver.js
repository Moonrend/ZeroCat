import logger from '../services/logger.js';
import { prisma } from '../services/prisma.js';
import { isWalineScopeGranted, verifyWalineToken } from '../services/commentService/walineAuth.js';
import { getSpaceConfig, getSpaceUser } from '../services/commentService/spaceManager.js';

/**
 * 解析 spaceCuid, 加载空间配置, 验证 Waline JWT
 * 挂载在 /comment/:spaceCuid/* 路由上
 */
export const walineSpaceResolver = async (req, res, next) => {
    const { spaceCuid } = req.params;
    if (!spaceCuid) {
        return res.status(400).json({ errno: 1001, errmsg: '缺少 spaceCuid 参数' });
    }

    try {
        // 加载空间
        const space = await prisma.ow_comment_spaces.findUnique({
            where: { cuid: spaceCuid },
        });

        if (!space) {
            return res.status(404).json({ errno: 1002, errmsg: '评论空间不存在' });
        }

        if (space.status === 'banned') {
            return res.status(403).json({ errno: 1002, errmsg: '该评论空间已被封禁' });
        }

        if (space.status !== 'active') {
            return res.status(404).json({ errno: 1002, errmsg: '评论空间不存在或未启用' });
        }

        // 加载配置
        const config = await getSpaceConfig(spaceCuid);

        // 域名校验: 合并 space.domain 和 config.secureDomains
        const origin = req.headers.origin || req.headers.referer || '';
        let allowedDomains = [];
        if (space.domain) {
            allowedDomains.push(...space.domain.split(',').map(d => d.trim()).filter(Boolean));
        }
        if (config.secureDomains) {
            allowedDomains.push(...config.secureDomains.split(',').map(d => d.trim()).filter(Boolean));
        }

        if (allowedDomains.length > 0 && origin) {
            try {
                const hostname = new URL(origin).hostname;
                const matched = allowedDomains.some(d =>
                    hostname === d || hostname.endsWith('.' + d)
                );
                if (!matched) {
                    return res.status(403).json({ errno: 1008, errmsg: '域名不在允许列表中' });
                }
            } catch {
                // origin 解析失败，跳过校验
            }
        }

        // 挂载到 req 上
        req.commentSpace = space;
        req.spaceConfig = config;
        req.walineUser = null;
        req.walineSpaceUser = null;
        req.walineToken = null;

        // 解析 Waline JWT (从 Authorization header)
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const parts = authHeader.split(' ');
            const token = parts.length === 2 && parts[0].toLowerCase() === 'bearer'
                ? parts[1]
                : authHeader;
            req.walineToken = token;

            const { valid, userId, scopes, jti, parentTokenId } = await verifyWalineToken(
                token,
                space.jwt_secret,
                { spaceId: space.id, spaceCuid: space.cuid },
            );
            if (valid && userId) {
                req.walineUser = { userId, scopes, jti, parentTokenId };

                // 加载空间用户信息
                const spaceUser = await getSpaceUser(space.id, userId);
                if (spaceUser) {
                    const effectiveType = isWalineScopeGranted(scopes, 'comment:manage')
                        ? spaceUser.type
                        : 'guest';
                    req.walineSpaceUser = { ...spaceUser, type: effectiveType };
                    req.walineUser.type = effectiveType;
                    req.walineUser.nick = spaceUser.display_name;
                    req.walineUser.mail = spaceUser.email;
                    req.walineUser.link = spaceUser.url;
                    req.walineUser.avatar = spaceUser.avatar;
                    req.walineUser.label = spaceUser.label;
                }

                // 也加载 ZeroCat 用户信息
                const zcUser = await prisma.ow_users.findUnique({
                    where: { id: userId },
                    select: {
                        id: true, username: true, display_name: true,
                        avatar: true, email: true, type: true,
                        url: true, label: true, bio: true,
                    },
                });
                if (zcUser) {
                    req.walineUser.zcUser = zcUser;
                    if (!req.walineUser.nick) {
                        req.walineUser.nick = zcUser.display_name || zcUser.username;
                    }
                }
            }
        }

        next();
    } catch (err) {
        logger.error(`[walineSpaceResolver] Error: ${err.message}`);
        next(err);
    }
};

/**
 * 检查是否为空间管理员/审核员
 */
export const isSpaceAdmin = (req) => {
    if (!req.walineUser) return false;
    const type = req.walineUser.type;
    return (type === 'administrator' || type === 'moderator')
        && isWalineScopeGranted(req.walineUser.scopes, 'comment:manage');
};

/**
 * CORS 中间件: 对 /comment 路由放宽 CORS
 * secureDomains 配置验证
 */
export const walineCors = (req, res, next) => {
    const origin = req.headers.origin;

    // 设置 CORS 头
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
};

export default { walineSpaceResolver, isSpaceAdmin, walineCors };
