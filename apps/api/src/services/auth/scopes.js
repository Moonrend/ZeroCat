/**
 * Scope 精细化权限规范
 *
 * 语法：
 *   - 类型级:  resource:action            (如 project:update, user:read)
 *   - 实例级:  resource:id:action         (如 project:118:read)
 *   - 通配:    *                          (全权限)
 *             resource:*                  (某资源全部操作)
 *             resource:id:*               (某实例全部操作)
 *
 * 新权限不再把创建、修改、删除做成线性等级。用户面对的是明确能力：
 * read / create / update / delete / interact / manage。
 *
 * 兼容规则：
 *   - * 不覆盖 admin 资源；管理员能力必须显式为 admin:* 或 admin:manage
 *   - manage 覆盖同资源全部能力
 *   - write 为历史兼容动作，覆盖 create/update/delete/interact/read
 *   - user:basic、user:email、profile 会规范化为 user:read
 */

import logger from "../logger.js";

// 标准动作。write 仅用于兼容旧令牌/旧 OAuth 应用，不在新 UI 中展示。
export const ACTIONS = ["read", "create", "update", "delete", "interact", "manage", "write"];

export const ACTION_DEFINITIONS = {
    read: {
        label: "查看",
        description: "读取属于你的私有数据。公开内容通常不需要授权。",
    },
    create: {
        label: "创建",
        description: "新建内容或上传资源。",
    },
    update: {
        label: "修改",
        description: "修改已有内容或状态，不包含删除。",
    },
    delete: {
        label: "删除",
        description: "删除已有内容。该操作不可恢复时会单独提示。",
    },
    interact: {
        label: "互动",
        description: "点赞、收藏、关注、转发等社交互动。",
    },
    manage: {
        label: "管理",
        description: "管理高风险设置，覆盖该资源的查看、创建、修改、删除和互动。",
    },
    write: {
        label: "写入 (兼容)",
        description: "历史兼容动作，覆盖创建、修改、删除和互动。",
        legacy: true,
    },
};

export const ADMIN_MODULES = ["permissions", "restrictions", "content", "hidden_content"];

const ACTION_COVERAGE = {
    read: ["read"],
    create: ["create"],
    update: ["update"],
    delete: ["delete"],
    interact: ["interact"],
    manage: ["read", "create", "update", "delete", "interact", "manage", "write"],
    // 历史兼容：旧 project:write/post:write 等令牌继续可用。
    write: ["read", "create", "update", "delete", "interact", "write"],
};

export const LEGACY_SCOPE_ALIASES = {
    profile: "user:read",
    "user:basic": "user:read",
    "user:email": "user:read",
};

/**
 * 将旧 scope 名称映射到新规范。
 * @param {string} scope
 * @returns {string}
 */
export function canonicalizeScope(scope) {
    const value = typeof scope === "string" ? scope.trim() : "";
    return LEGACY_SCOPE_ALIASES[value] || value;
}

/**
 * 判断授予的动作是否覆盖要求的动作。
 * @param {string} grantedAction
 * @param {string} requiredAction
 * @returns {boolean}
 */
export function actionSatisfies(grantedAction, requiredAction) {
    if (grantedAction === "*") return true;
    const granted = ACTION_COVERAGE[grantedAction];
    if (!granted) return grantedAction === requiredAction;
    return granted.includes(requiredAction);
}

// 资源清单 (来自现有数据模型)
export const RESOURCES = [
    "project",
    "user",
    "comment",
    "post",
    "notification",
    "asset",
    "list",
    "follow",
    "event",
    "analytics",
    "cachekv",
    "blog",
    "extension",
    "oauth_app",
    "token",
    "git_sync",
    "admin",
];

export const SCOPE_CATEGORIES = {
    account: { label: "账户", order: 10 },
    project: { label: "创作项目", order: 20 },
    asset: { label: "素材", order: 30 },
    social: { label: "社交", order: 40 },
    content: { label: "内容", order: 50 },
    developer: { label: "开发者", order: 60 },
    admin: { label: "管理", order: 90 },
};

const scope = (name, title, description, category, risk_level, extra = {}) => ({
    name,
    title,
    description,
    category,
    category_label: SCOPE_CATEGORIES[category]?.label || category,
    risk_level,
    ...extra,
});

/**
 * Scope 目录: 提供给令牌创建 / OAuth 同意页 UI 的可读元数据。
 * 仅包含类型级 scope; 实例级 scope (resource:id:action) 由用户/应用自行构造。
 */
export const SCOPE_CATALOG = [
    scope("*", "完全访问", "账户全部非管理员权限，等同于完整登录会话。", "account", "high", {
        resource: "*",
        action: "*",
        action_label: "全部",
    }),

    scope("user:read", "查看账户资料", "读取用户名、显示名、头像、已验证邮箱等账户资料。", "account", "low", {
        resource: "user",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("user:update", "修改账户资料", "修改个人资料、用户名或密码。敏感操作仍需要 Sudo 验证。", "account", "medium", {
        resource: "user",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("user:delete", "删除账户", "删除或停用你的账户。该操作仍需要 Sudo 验证。", "account", "high", {
        resource: "user",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("project:read", "查看私有项目", "读取你有权访问的私有项目和项目分析。公开项目无需授权。", "project", "low", {
        resource: "project",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("project:create", "创建项目", "创建新项目、Fork 项目或创建项目分支。", "project", "medium", {
        resource: "project",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("project:update", "修改项目", "保存项目文件、提交代码、修改项目标题/描述/标签等内容。", "project", "medium", {
        resource: "project",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("project:interact", "项目互动", "收藏、取消收藏或记录与项目相关的互动。", "project", "medium", {
        resource: "project",
        action: "interact",
        action_label: ACTION_DEFINITIONS.interact.label,
    }),
    scope("project:delete", "删除项目", "删除你拥有的项目。删除前仍可能要求 Sudo 验证。", "project", "high", {
        resource: "project",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),
    scope("project:manage", "管理项目设置", "修改可见性等高风险项目设置，覆盖项目的全部能力。", "project", "high", {
        resource: "project",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),

    scope("asset:read", "查看私有素材", "读取你上传的私有素材列表。", "asset", "low", {
        resource: "asset",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("asset:create", "上传素材", "上传图片、文件或推文媒体素材。", "asset", "medium", {
        resource: "asset",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("asset:delete", "删除素材", "删除或下架你上传的素材。", "asset", "high", {
        resource: "asset",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("post:read", "查看私有社交内容", "读取需要登录才能访问的推文、收藏、提及等社交数据。", "social", "low", {
        resource: "post",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("post:create", "发布推文", "发布推文、回复、引用或上传推文图片。", "social", "medium", {
        resource: "post",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("post:update", "同步推文", "重新同步、推送联邦状态或更新你发布的推文相关元数据。", "social", "medium", {
        resource: "post",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("post:interact", "推文互动", "点赞、收藏、转发、取消转发等社交互动。", "social", "medium", {
        resource: "post",
        action: "interact",
        action_label: ACTION_DEFINITIONS.interact.label,
    }),
    scope("post:delete", "删除推文", "删除你发布的推文。", "social", "high", {
        resource: "post",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("comment:read", "查看评论", "读取与你相关的评论数据。公开评论无需授权。", "social", "low", {
        resource: "comment",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("comment:create", "发表评论", "发表或回复评论。", "social", "medium", {
        resource: "comment",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("comment:update", "修改评论", "修改你发布的评论。", "social", "medium", {
        resource: "comment",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("comment:delete", "删除评论", "删除你发布的评论。", "social", "high", {
        resource: "comment",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),
    scope("comment:manage", "管理评论空间", "管理评论空间、配置、用户角色、审核队列和数据导入。", "social", "high", {
        resource: "comment",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),

    scope("notification:read", "查看通知", "读取你的私有通知和未读数量。", "account", "low", {
        resource: "notification",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("notification:update", "更新通知状态", "标记通知已读、批量已读或更新通知状态。", "account", "low", {
        resource: "notification",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),

    scope("list:read", "查看项目列表", "读取你的私有项目列表。公开列表无需授权。", "project", "low", {
        resource: "list",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("list:create", "创建项目列表", "创建新的项目列表。", "project", "medium", {
        resource: "list",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("list:update", "修改项目列表", "修改列表标题、描述或列表项。", "project", "medium", {
        resource: "list",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("list:delete", "删除项目列表", "删除你创建的项目列表。", "project", "high", {
        resource: "list",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("follow:read", "查看关注关系", "读取你的关注和粉丝关系。", "social", "low", {
        resource: "follow",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("follow:interact", "关注互动", "关注、取关或调整关注关系。", "social", "medium", {
        resource: "follow",
        action: "interact",
        action_label: ACTION_DEFINITIONS.interact.label,
    }),

    scope("blog:read", "查看博客草稿", "读取你的私有博客草稿。公开文章无需授权。", "content", "low", {
        resource: "blog",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("blog:create", "创建博客文章", "创建博客草稿或文章。", "content", "medium", {
        resource: "blog",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("blog:update", "修改博客文章", "修改博客草稿、正文、封面和标签。", "content", "medium", {
        resource: "blog",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("blog:delete", "删除博客文章", "删除博客草稿或文章。", "content", "high", {
        resource: "blog",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("cachekv:read", "查看键值存储", "读取你的私有键值存储。", "account", "low", {
        resource: "cachekv",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("cachekv:update", "写入键值存储", "新增或修改你的键值存储。", "account", "medium", {
        resource: "cachekv",
        action: "update",
        action_label: ACTION_DEFINITIONS.update.label,
    }),
    scope("cachekv:delete", "删除键值存储", "删除你的键值存储条目。", "account", "high", {
        resource: "cachekv",
        action: "delete",
        action_label: ACTION_DEFINITIONS.delete.label,
    }),

    scope("oauth_app:read", "查看 OAuth 应用", "读取你创建的 OAuth 应用信息。", "developer", "low", {
        resource: "oauth_app",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("oauth_app:manage", "管理 OAuth 应用", "创建、修改或删除 OAuth 应用。敏感操作仍需要 Sudo 验证。", "developer", "high", {
        resource: "oauth_app",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),

    scope("token:read", "查看令牌", "读取你的个人 API 令牌列表和使用记录。", "developer", "low", {
        resource: "token",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("token:manage", "管理令牌", "创建和吊销个人 API 令牌。敏感操作仍需要 Sudo 验证。", "developer", "high", {
        resource: "token",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),

    scope("git_sync:read", "查看 Git 同步", "读取已绑定的 GitHub 安装、仓库列表和同步状态。", "developer", "medium", {
        resource: "git_sync",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("git_sync:manage", "管理 Git 同步", "绑定或解绑 GitHub、创建仓库、配置同步并触发同步任务。", "developer", "high", {
        resource: "git_sync",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),

    scope("analytics:read", "查看分析数据", "读取与你相关的统计分析数据。", "developer", "medium", {
        resource: "analytics",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("event:read", "查看事件记录", "读取与你相关的事件记录。", "developer", "medium", {
        resource: "event",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("event:create", "写入事件记录", "创建与你的账户行为相关的事件记录。", "developer", "medium", {
        resource: "event",
        action: "create",
        action_label: ACTION_DEFINITIONS.create.label,
    }),
    scope("extension:read", "查看扩展", "读取扩展相关信息。", "developer", "low", {
        resource: "extension",
        action: "read",
        action_label: ACTION_DEFINITIONS.read.label,
    }),
    scope("extension:manage", "管理扩展", "创建、审核或管理扩展。", "developer", "high", {
        resource: "extension",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),
    scope("admin:manage", "管理员操作", "执行管理后台操作，仅管理员账号可用。", "admin", "high", {
        resource: "admin",
        action: "manage",
        action_label: ACTION_DEFINITIONS.manage.label,
    }),
    ...ADMIN_MODULES.flatMap((module) => ["read", "manage"].map((action) =>
        scope(`admin:${module}:${action}`, `${module} ${ACTION_DEFINITIONS[action].label}`,
            `管理后台 ${module} 模块的${ACTION_DEFINITIONS[action].label}权限。`, "admin", "high", {
                resource: "admin", module, action, action_label: ACTION_DEFINITIONS[action].label,
            })
    )),
];

export const SCOPE_PRESETS = [
    {
        id: "identity",
        name: "识别身份",
        description: "只让工具识别你是谁，适合登录第三方应用或基础账号绑定。",
        scopes: ["user:read"],
        risk_level: "low",
    },
    {
        id: "project_reader",
        name: "查看创作数据",
        description: "读取私有项目、素材和通知，不允许创建、修改或删除。",
        scopes: ["user:read", "project:read", "asset:read", "notification:read"],
        risk_level: "low",
    },
    {
        id: "project_editor",
        name: "项目编辑工具",
        description: "用于 IDE、同步工具或自动构建：可创建项目、保存代码和上传素材，但不能删除项目。",
        scopes: ["user:read", "project:read", "project:create", "project:update", "asset:read", "asset:create"],
        risk_level: "medium",
    },
    {
        id: "social_client",
        name: "社交发布工具",
        description: "发布推文、回复、点赞收藏，并读取通知。",
        scopes: ["user:read", "post:create", "post:interact", "notification:read"],
        risk_level: "medium",
    },
    {
        id: "developer_console",
        name: "开发者控制台",
        description: "管理 OAuth 应用和个人令牌。该预设风险较高，建议只给自己维护的工具使用。",
        scopes: ["user:read", "oauth_app:manage", "token:read", "token:manage"],
        risk_level: "high",
    },
];

const RESOURCE_SET = new Set(RESOURCES);
const ACTION_SET = new Set(ACTIONS);

/**
 * 解析 scope 字符串
 * @param {string} scope
 * @returns {{wildcard:boolean, resource:string|null, id:string|null, action:string|null}|null}
 */
export function parseScope(scope) {
    if (typeof scope !== "string" || scope.length === 0) return null;
    const s = canonicalizeScope(scope);
    if (s === "*") {
        return { wildcard: true, resource: null, id: null, action: null };
    }
    const parts = s.split(":");
    if (parts.length === 2) {
        return { wildcard: false, resource: parts[0], id: null, action: parts[1] };
    }
    if (parts.length === 3) {
        return { wildcard: false, resource: parts[0], id: parts[1], action: parts[2] };
    }
    return null;
}

/**
 * 校验一个 scope 字符串语法是否合法 (资源/动作须在白名单内, 通配位允许 *)
 * @param {string} scope
 * @returns {boolean}
 */
export function isValidScope(scope) {
    const parsed = parseScope(scope);
    if (!parsed) return false;
    if (parsed.wildcard) return true;
    if (!RESOURCE_SET.has(parsed.resource)) return false;
    if (parsed.action !== "*" && !ACTION_SET.has(parsed.action)) return false;
    if (parsed.id !== null && (!String(parsed.id).length || /[\s:]/.test(parsed.id))) return false;
    if (parsed.resource === "admin" && parsed.id !== null) {
        return ADMIN_MODULES.includes(parsed.id) && ["read", "manage", "*"].includes(parsed.action);
    }
    return true;
}

/**
 * 判断单个授予 scope 是否满足单个要求 scope
 * @param {string} granted
 * @param {string} required
 * @returns {boolean}
 */
function singleSatisfies(granted, required) {
    const g = parseScope(granted);
    const r = parseScope(required);
    if (!g || !r) return false;

    if (r.wildcard) return false;
    if (g.wildcard) return r.resource !== "admin";
    if (g.resource !== r.resource) return false;

    if (g.action === "*" && g.id === null) return true;

    if (g.id === null) {
        return actionSatisfies(g.action, r.action);
    }

    if (r.id === null) return false;
    if (g.id !== r.id) return false;
    return actionSatisfies(g.action, r.action);
}

/**
 * 判断授予的 scope 集合是否满足要求
 * @param {string[]} grantedScopes
 * @param {string} required 单个要求 scope
 * @returns {boolean}
 */
export function scopeSatisfies(grantedScopes, required) {
    if (!Array.isArray(grantedScopes) || grantedScopes.length === 0) return false;
    return grantedScopes.some((g) => singleSatisfies(g, required));
}

/**
 * 判断一组授予的 scope 是否是另一组允许 scope 的子集。
 * @param {string[]} subset 待校验
 * @param {string[]} allowed 允许集合
 * @returns {boolean}
 */
export function isScopeSubset(subset, allowed) {
    if (!Array.isArray(subset)) return false;
    if (!Array.isArray(allowed)) return false;
    const normalizedAllowed = normalizeScopes(allowed);
    return subset.every((s) => {
        const parsed = parseScope(s);
        if (!parsed) return false;
        if (parsed.wildcard) {
            return normalizedAllowed.some((item) => parseScope(item)?.wildcard);
        }
        return scopeSatisfies(normalizedAllowed, s);
    });
}

/**
 * 判断当前请求 token 是否允许继续转授权这些 scope。
 *
 * session token 代表网页登录会话，不再独立记录权限，权限上限由用户当前角色策略决定；
 * personal/oauth token 是受限令牌，创建下游 token/OAuth 授权时仍必须是当前 token scope 的子集。
 *
 * @param {string|null|undefined} tokenType
 * @param {string[]} currentTokenScopes
 * @param {string[]} requestedScopes
 * @returns {boolean}
 */
export function tokenContextCanGrantScopes(tokenType, currentTokenScopes, requestedScopes) {
    if (tokenType === "session") return true;
    return isScopeSubset(requestedScopes, currentTokenScopes || []);
}

async function isAdminUser(userId) {
    try {
        const [{ default: zcconfig }, { prisma }] = await Promise.all([
            import("../config/zcconfig.js"),
            import("../prisma.js"),
        ]);
        const [adminUsers, user] = await Promise.all([
            zcconfig.get("security.adminusers"),
            prisma.ow_users.findUnique({
                where: { id: Number(userId) },
                select: { id: true, type: true, status: true },
            }),
        ]);

        if (!user || user.status !== "active") return false;
        const configuredAdmin = Array.isArray(adminUsers)
            && adminUsers.map(String).includes(String(userId));
        return configuredAdmin || user.type === "administrator";
    } catch (error) {
        logger.error(`[scopes] 检查管理员身份失败: ${error.message}`);
        return false;
    }
}

const WRITE_LIKE_ACTIONS = new Set(["create", "update", "delete", "manage", "write"]);

function parsedScopeToString(parsedScope) {
    if (parsedScope?.wildcard) return "*";
    if (!parsedScope?.resource || !parsedScope?.action) return "";
    return parsedScope.id === null || parsedScope.id === undefined
        ? `${parsedScope.resource}:${parsedScope.action}`
        : `${parsedScope.resource}:${parsedScope.id}:${parsedScope.action}`;
}

function numericId(value) {
    const numberValue = Number(value);
    return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function isWriteLikeAction(action) {
    return WRITE_LIKE_ACTIONS.has(action);
}

async function canUseProjectLikeResource(userId, resourceId, action, { articleOnly = false, db } = {}) {
    const projectId = numericId(resourceId);
    if (!projectId) return false;

    // Instance capabilities must still pass current deny and governance checks.
    const [{ prisma: defaultDb }, { canViewContent }] = await Promise.all([
        import("../prisma.js"), import("../moderation/visibility.js"),
    ]);
    const prisma = db || defaultDb;
    const project = await prisma.ow_projects.findUnique({ where: { id: projectId } });

    if (!project || !await canViewContent("project", project, userId, { db: prisma })) return false;
    if (articleOnly && String(project.type || "").toLowerCase() !== "article") return false;
    if (Number(project.authorid) === Number(userId)) return true;

    // 协作者放行：删除永远仅作者；其余动作看实例级协作角色覆盖的 scope。
    if (action !== "delete") {
        const { getUserResourceRoleScopes } = await import("./policyEngine.js");
        const collabScopes = await getUserResourceRoleScopes(userId, "project", String(projectId), { db: prisma });
        if (scopeSatisfies(collabScopes, `project:${action}`)) return true;
    }

    if (!isWriteLikeAction(action)) return project.state === "public";
    return false;
}

async function canUsePostResource(userId, resourceId, action, { db } = {}) {
    const postId = numericId(resourceId);
    if (!postId) return false;

    const [{ prisma: defaultDb }, { canViewContent }] = await Promise.all([
        import("../prisma.js"), import("../moderation/visibility.js"),
    ]);
    const prisma = db || defaultDb;
    const post = await prisma.ow_posts.findUnique({ where: { id: postId } });

    if (!post || !await canViewContent("post", post, userId, { db: prisma })) return false;
    if (Number(post.author_id) === Number(userId)) return true;
    return !isWriteLikeAction(action);
}

async function canUseListResource(userId, resourceId, action, { db } = {}) {
    const listId = numericId(resourceId);
    if (!listId) return false;

    const [{ prisma: defaultDb }, { canViewContent }] = await Promise.all([
        import("../prisma.js"), import("../moderation/visibility.js"),
    ]);
    const prisma = db || defaultDb;
    const list = await prisma.ow_projects_lists.findUnique({ where: { id: listId } });

    if (!list || !await canViewContent("list", list, userId, { db: prisma })) return false;
    if (Number(list.authorid) === Number(userId)) return true;
    return !isWriteLikeAction(action) && list.state === "public";
}

async function canUseExtensionResource(userId, resourceId, action, { db } = {}) {
    const extensionId = numericId(resourceId);
    if (!extensionId) return false;

    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const extension = await prisma.ow_scratch_extensions.findUnique({
        where: { id: extensionId },
        select: {
            status: true,
            project: { select: { authorid: true, state: true } },
        },
    });

    if (!extension) return false;
    if (Number(extension.project?.authorid) === Number(userId)) return true;
    if (isWriteLikeAction(action)) return false;
    return ["verified", "approved"].includes(String(extension.status || "").toLowerCase())
        || extension.project?.state === "public";
}

async function canUseCommentResource(userId, resourceId, action, { db } = {}) {
    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const rawId = String(resourceId || "").trim();
    if (!rawId) return false;

    const space = await prisma.ow_comment_spaces.findUnique({
        where: { cuid: rawId },
        select: { owner_id: true, status: true },
    });
    if (space) {
        if (Number(space.owner_id) === Number(userId)) return true;
        return !isWriteLikeAction(action) && space.status === "active";
    }

    const commentId = numericId(rawId);
    if (!commentId) return false;
    const comment = await prisma.ow_comment_service.findUnique({
        where: { id: commentId },
        select: {
            account_user_id: true,
            space: { select: { owner_id: true, status: true } },
        },
    });
    if (!comment) return false;
    if (Number(comment.space?.owner_id) === Number(userId)) return true;
    if (Number(comment.account_user_id) === Number(userId)) return true;
    return !isWriteLikeAction(action) && comment.space?.status === "active";
}

async function canUseAssetResource(userId, resourceId, action, { db } = {}) {
    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const assetId = numericId(resourceId);
    const where = assetId
        ? { id: assetId }
        : { md5: String(resourceId || "").replace(/\.[a-z0-9]+$/i, "") };

    const asset = await prisma.ow_assets.findUnique({
        where,
        select: { uploader_id: true, is_banned: true },
    });
    if (!asset || asset.is_banned) return false;
    if (Number(asset.uploader_id) === Number(userId)) return true;
    return !isWriteLikeAction(action);
}

async function canUseNotificationResource(userId, resourceId, { db } = {}) {
    const notificationId = numericId(resourceId);
    if (!notificationId) return false;

    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const notification = await prisma.ow_notifications.findUnique({
        where: { id: notificationId },
        select: { user_id: true },
    });
    return Number(notification?.user_id) === Number(userId);
}

async function canUseOAuthApplicationResource(userId, resourceId, action, { db } = {}) {
    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const appId = numericId(resourceId);
    const application = await prisma.ow_oauth_applications.findUnique({
        where: appId ? { id: appId } : { client_id: String(resourceId || "") },
        select: { owner_id: true, is_public: true, status: true },
    });
    if (!application || application.status === "deleted") return false;
    if (Number(application.owner_id) === Number(userId)) return true;
    return !isWriteLikeAction(action) && application.is_public;
}

async function canUseTokenResource(userId, resourceId, { db } = {}) {
    const tokenId = numericId(resourceId);
    if (!tokenId) return false;

    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const token = await prisma.ow_tokens.findUnique({
        where: { id: tokenId },
        select: { user_id: true },
    });
    return Number(token?.user_id) === Number(userId);
}

async function canUseEventResource(userId, resourceId, action, { db } = {}) {
    const eventId = numericId(resourceId);
    if (!eventId) return false;

    const { prisma: defaultDb } = await import("../prisma.js");
    const prisma = db || defaultDb;
    const event = await prisma.ow_events.findUnique({
        where: { id: eventId },
        select: { actor_id: true, public: true },
    });
    if (!event) return false;
    if (Number(event.actor_id) === Number(userId)) return true;
    return !isWriteLikeAction(action) && event.public;
}

/**
 * 校验实例级 scope 是否仍落在当前用户自己的资源/可见资源边界内。
 *
 * 类型级 scope 没有具体资源 ID，必须由调用方路由保证其操作的是当前用户上下文；
 * 实例级 scope 在这里做统一归属兜底，避免宽 scope 匹配到他人资源。
 *
 * @param {number} userId
 * @param {string} requiredScope
 * @returns {Promise<boolean>}
 */
export async function userCanAccessResourceScope(userId, requiredScope, options = {}) {
    const parsed = parseScope(requiredScope);
    if (!isValidScope(requiredScope) || !parsed || parsed.wildcard) return false;
    if (parsed.id === null || parsed.id === undefined) return true;

    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return false;

    try {
        const { getUserPolicy, policyDeniesScope } = await import("./policyEngine.js");
        const policy = await getUserPolicy(normalizedUserId, { targetType: parsed.resource, targetId: parsed.id, db: options.db });
        if (!policy.valid || policyDeniesScope(policy, requiredScope)) return false;
        switch (parsed.resource) {
            case "user":
                return String(parsed.id) === String(normalizedUserId);
            case "project":
                return canUseProjectLikeResource(normalizedUserId, parsed.id, parsed.action, options);
            case "blog":
                return canUseProjectLikeResource(normalizedUserId, parsed.id, parsed.action, { ...options, articleOnly: true });
            case "post":
                return canUsePostResource(normalizedUserId, parsed.id, parsed.action, options);
            case "list":
                return canUseListResource(normalizedUserId, parsed.id, parsed.action, options);
            case "extension":
                return canUseExtensionResource(normalizedUserId, parsed.id, parsed.action, options);
            case "comment":
                return canUseCommentResource(normalizedUserId, parsed.id, parsed.action, options);
            case "asset":
                return canUseAssetResource(normalizedUserId, parsed.id, parsed.action, options);
            case "notification":
                return canUseNotificationResource(normalizedUserId, parsed.id, options);
            case "oauth_app":
                return canUseOAuthApplicationResource(normalizedUserId, parsed.id, parsed.action, options);
            case "token":
                return canUseTokenResource(normalizedUserId, parsed.id, options);
            case "event":
                return canUseEventResource(normalizedUserId, parsed.id, parsed.action, options);
            case "follow":
            case "cachekv":
            case "git_sync":
            case "analytics":
                return true;
            case "admin":
                return false;
            default:
                return false;
        }
    } catch (error) {
        logger.error(`[scopes] 检查资源实例权限失败 ${requiredScope}: ${error.message}`);
        return false;
    }
}

async function canGrantInstanceScope(userId, parsedScope, isAdmin) {
    if (!parsedScope.id) return true;
    if (isAdmin) return true;

    return userCanAccessResourceScope(Number(userId), parsedScopeToString(parsedScope));
}

/**
 * 判断用户账号本身是否允许授予这些 scope。
 *
 * 注意：这不是请求时的资源所有权检查；它只限制“转授权上限”。
 * 用户只能转授当前令牌已经覆盖、且账号本身可访问的 scope；普通用户不能转授 admin 权限。
 * 实例级 scope 会按本人/资源可见性额外校验，避免显式授予他人私有资源权限。
 *
 * @param {number} userId
 * @param {string[]} scopes
 * @returns {Promise<{allowed:boolean, denied:string[], admin:boolean}>}
 */
export async function validateUserGrantableScopes(userId, scopes) {
    const normalized = normalizeScopes(scopes);
    if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) {
        return { allowed: false, denied: normalized, admin: false };
    }

    const { canUserGrantScopes, getUserPolicy, resourcePolicyAllowsScope } = await import("./policyEngine.js");
    const policyCheck = await canUserGrantScopes(userId, normalized);
    const isAdmin = policyCheck.admin;
    const denied = [];

    for (const scopeName of normalized) {
        const parsed = parseScope(scopeName);
        if (!parsed) {
            denied.push(scopeName);
            continue;
        }

        if (!policyCheck.allowed && policyCheck.denied.includes(scopeName)) {
            denied.push(scopeName);
            continue;
        }

        if (parsed.wildcard) continue;

        if (parsed.id !== null && parsed.resource !== "admin") {
            const policy = await getUserPolicy(userId, { targetType: parsed.resource, targetId: parsed.id });
            if (resourcePolicyAllowsScope(policy, scopeName)) continue;
        }
        if (parsed.resource !== "admin" && !(await canGrantInstanceScope(Number(userId), parsed, isAdmin))) {
            denied.push(scopeName);
        }
    }

    return { allowed: denied.length === 0, denied, admin: isAdmin };
}

/**
 * 规范化 scope 集合：去重、规范旧名称、过滤非法项，并移除被同集合中更宽 scope 覆盖的冗余项。
 * 例如 ["project:read","project:manage"] -> ["project:manage"]；
 * 含 "*" 则直接返回 ["*"]。
 * @param {string[]|string} scopes
 * @returns {string[]}
 */
export function normalizeScopes(scopes) {
    const input = typeof scopes === "string" ? scopes.split(/\s+/).filter(Boolean) : scopes || [];
    const valid = [...new Set(input.map(canonicalizeScope).filter(isValidScope))];
    if (valid.includes("*")) {
        const explicitAdminScopes = valid.filter((scopeName) => {
            const parsed = parseScope(scopeName);
            return scopeName !== "*" && parsed?.resource === "admin";
        });
        const compactAdminScopes = explicitAdminScopes.filter(
            (scopeName) => !explicitAdminScopes.some(
                (other) => other !== scopeName && singleSatisfies(other, scopeName)
            )
        );
        return ["*", ...compactAdminScopes];
    }
    return valid.filter(
        (s) => !valid.some((other) => other !== s && singleSatisfies(other, s))
    );
}

/**
 * 启动时将 SCOPE_CATALOG 同步进 ow_oauth_scopes 表 (供前端展示)。
 * 幂等: upsert by name。
 */
export async function syncScopeCatalog() {
    try {
        const [{ prisma }, { Prisma }] = await Promise.all([
            import("../prisma.js"), import("../../../generated/prisma/client.ts"),
        ]);
        const values = SCOPE_CATALOG.filter(item => item.name !== "*").map(item => Prisma.sql`
            (${item.name}, ${item.description}, ${item.category}, ${item.risk_level}, ${item.name === "user:read"}, CURRENT_TIMESTAMP)
        `);
        if (values.length) await prisma.$executeRaw(Prisma.sql`
            INSERT INTO "oauth_scopes" ("name", "description", "category", "risk_level", "is_default", "updated_at")
            VALUES ${Prisma.join(values)}
            ON CONFLICT ("name") DO UPDATE SET
                "description" = EXCLUDED."description",
                "category" = EXCLUDED."category",
                "risk_level" = EXCLUDED."risk_level",
                "updated_at" = CURRENT_TIMESTAMP
            WHERE ("oauth_scopes"."description", "oauth_scopes"."category", "oauth_scopes"."risk_level")
                IS DISTINCT FROM (EXCLUDED."description", EXCLUDED."category", EXCLUDED."risk_level")
        `);
        logger.info(`[scopes] 已同步 ${SCOPE_CATALOG.length - 1} 个 scope 到目录`);
    } catch (error) {
        logger.error(`[scopes] 同步 scope 目录失败: ${error.message}`);
    }
}

export default {
    ACTIONS,
    ACTION_DEFINITIONS,
    RESOURCES,
    SCOPE_CATEGORIES,
    SCOPE_CATALOG,
    SCOPE_PRESETS,
    LEGACY_SCOPE_ALIASES,
    canonicalizeScope,
    parseScope,
    isValidScope,
    actionSatisfies,
    scopeSatisfies,
    isScopeSubset,
    tokenContextCanGrantScopes,
    userCanAccessResourceScope,
    validateUserGrantableScopes,
    normalizeScopes,
    syncScopeCatalog,
};
