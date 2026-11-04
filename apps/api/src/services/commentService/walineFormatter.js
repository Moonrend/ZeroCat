import { UAParser } from 'ua-parser-js';
import crypto from 'crypto';
import ipLocation from '../ip/ipLocation.js';
import zcconfig from '../config/zcconfig.js';
import { renderMarkdown } from './markdown.js';
import { canViewContent } from '../moderation/visibility.js';

/**
 * 将内部角色映射为 Waline 客户端识别的 type
 * administrator/moderator → "administrator" (Waline 管理权限)
 * guest/banned/其他 → 原值
 */
export function toWalineType(type) {
    if (type === 'administrator' || type === 'moderator') return 'administrator';
    return type || 'guest';
}

/**
 * 根据昵称和邮箱计算默认头像 URL
 * - 昵称为纯数字 → QQ头像
 * - QQ邮箱 → QQ头像
 * - 其他 → Libravatar (邮箱MD5)
 */
function getDefaultAvatar(nick, mail) {
    const numExp = /^[0-9]+$/;
    const qqMailExp = /^[0-9]+@qq\.com$/i;

    if (nick && numExp.test(nick)) {
        return `https://q1.qlogo.cn/g?b=qq&nk=${nick}&s=100`;
    }
    if (mail && qqMailExp.test(mail)) {
        const qq = mail.replace(/@qq\.com$/i, '');
        return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`;
    }
    const hash = mail
        ? crypto.createHash('md5').update(mail.trim().toLowerCase()).digest('hex')
        : '00000000000000000000000000000000';
    return `https://seccdn.libravatar.org/avatar/${hash}`;
}

/**
 * 格式化单条评论为 Waline 兼容格式
 * @param {object} comment - 数据库评论记录
 * @param {object} options
 * @param {boolean} options.isAdmin - 当前请求者是否管理员
 * @param {object|null} options.spaceUser - 评论者的空间用户记录
 * @param {object|null} options.zcUser - 评论者的 ZeroCat 用户记录
 * @param {boolean} options.disableUserAgent - 是否隐藏UA
 * @param {boolean} options.disableRegion - 是否隐藏IP地区
 * @returns {Promise<object>} Waline 兼容评论对象
 */
export async function formatComment(comment, options = {}) {
    const { isAdmin = false, spaceUser = null, zcUser = null, disableUserAgent = false, disableRegion = false, userLevelMap = null } = options;
    const accountId = Number(comment.account_user_id);
    const profileVisibility = options.profileVisibility;
    const hasProfileVisibility = profileVisibility?.viewerId === (Number(options.viewerId) || null)
        && profileVisibility.userIds.has(accountId);
    const hiddenProfile = accountId && (hasProfileVisibility
        ? profileVisibility.hiddenUserIds.has(accountId)
        : !await canViewContent('profile', { id: accountId }, options.viewerId || null));

    let browser = '';
    let os = '';
    if (!disableUserAgent && comment.ua) {
        const parser = new UAParser(comment.ua);
        const result = parser.getResult();
        browser = result.browser.name ? `${result.browser.name} ${result.browser.version || ''}`.trim() : '';
        os = result.os.name ? `${result.os.name} ${result.os.version || ''}`.trim() : '';
    }

    let addr = '';
    if (!disableRegion && comment.ip) {
        try {
            const ipInfo = await ipLocation.getIPLocation(comment.ip);
            addr = ipInfo.most_specific_country_or_region || '';
        } catch {
            // ignore
        }
    }

    // 确定 link 和 avatar: 已登录用户用 ZeroCat 账户信息
    let link = comment.link || '';
    let avatar = '';
    const staticUrl = await zcconfig.get('s3.staticurl');
    if (comment.account_user_id && zcUser) {
        if (zcUser.url) {
            link = zcUser.url;
        } else {
            const frontendUrl = await zcconfig.get('urls.frontend');
            link = `${frontendUrl}/${zcUser.username}`;
        }
        if (zcUser.avatar) {
            avatar = `${staticUrl}/assets/${zcUser.avatar.substring(0, 2)}/${zcUser.avatar.substring(2, 4)}/${zcUser.avatar}.webp`;
        }
    }

    // 没有指定头像时，根据昵称和邮箱计算默认头像
    if (!avatar) {
        const nick = comment.nick || '';
        const mail = comment.mail || '';
        avatar = getDefaultAvatar(nick, mail);
    }

    // Markdown → HTML → DOMPurify (与 Waline 一致)
    const renderedComment = renderMarkdown(comment.comment);

    const formatted = {
        objectId: String(comment.id),
        comment: renderedComment,
        insertedAt: comment.insertedAt.toISOString(),
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
        time: comment.insertedAt.getTime(),
        nick: comment.nick || '',
        mail: '',
        link,
        avatar,
        url: comment.url,
        status: comment.status,
        like: comment.like || 0,
        sticky: comment.sticky || false,
        pid: comment.pid ? String(comment.pid) : null,
        rid: comment.rid ? String(comment.rid) : null,
        browser,
        os,
        addr,
        user_id: comment.account_user_id ? Number(comment.account_user_id) : null,
        orig: comment.comment,
    };

    // 如果有关联的空间用户，覆盖显示信息
    if (spaceUser) {
        formatted.nick = spaceUser.display_name || formatted.nick;
        if (spaceUser.avatar) {
            formatted.avatar = `${staticUrl}/assets/${spaceUser.avatar.substring(0, 2)}/${spaceUser.avatar.substring(2, 4)}/${spaceUser.avatar}.webp`;
        }
        formatted.label = spaceUser.label || '';
        formatted.type = toWalineType(spaceUser.type);
    }

    // 用户等级
    if (userLevelMap && comment.account_user_id) {
        const userId = Number(comment.account_user_id);
        if (userLevelMap.has(userId)) {
            formatted.level = userLevelMap.get(userId);
        }
    }

    // 管理员可以看到 mail 和 ip
    if (isAdmin) {
        formatted.mail = comment.mail || '';
        formatted.ip = comment.ip || '';
        formatted.orig = comment.comment;
    }

    if (hiddenProfile) {
        formatted.nick = '用户';
        formatted.link = '';
        formatted.avatar = '';
        formatted.user_id = null;
        delete formatted.label;
        delete formatted.type;
        delete formatted.level;
    }
    return formatted;
}

/**
 * 批量格式化评论，并构建子评论树结构
 * @param {Array} comments - 根评论列表
 * @param {Array} children - 子评论列表
 * @param {object} options - 格式化选项
 * @param {Map} spaceUsersMap - user_id -> spaceUser 映射
 * @param {Map} zcUsersMap - user_id -> zcUser 映射
 * @returns {Promise<Array>}
 */
export async function formatCommentsWithChildren(comments, children, options = {}, spaceUsersMap = new Map(), zcUsersMap = new Map()) {
    const formatOpts = (comment) => ({
        ...options,
        spaceUser: comment.account_user_id ? spaceUsersMap.get(Number(comment.account_user_id)) || null : null,
        zcUser: comment.account_user_id ? zcUsersMap.get(Number(comment.account_user_id)) || null : null,
    });

    const formattedRoots = await Promise.all(
        comments.map(c => formatComment(c, formatOpts(c)))
    );

    const formattedChildren = await Promise.all(
        children.map(c => formatComment(c, formatOpts(c)))
    );

    // 按 rid 分组子评论
    const childrenByRid = {};
    for (const child of formattedChildren) {
        const rid = child.rid;
        if (!childrenByRid[rid]) childrenByRid[rid] = [];
        childrenByRid[rid].push(child);
    }

    // 挂载 children
    return formattedRoots.map(root => {
        const rootChildren = childrenByRid[root.objectId] || [];
        const commentMap = new Map();
        commentMap.set(root.objectId, root);
        for (const child of rootChildren) {
            commentMap.set(child.objectId, child);
        }

        const childrenWithReplyUser = rootChildren.map(child => {
            const parent = child.pid ? commentMap.get(String(child.pid)) : null;
            if (!parent) return child;
            return {
                ...child,
                reply_user: {
                    nick: parent.nick,
                    link: parent.link,
                    avatar: parent.avatar,
                },
            };
        });

        return {
            ...root,
            children: childrenWithReplyUser,
        };
    });
}

export default { formatComment, formatCommentsWithChildren, toWalineType };
