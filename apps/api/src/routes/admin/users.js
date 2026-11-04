import {Router} from "express";
import {summarizeGroups} from "./groupedStats.js";
import {prisma} from "../../services/prisma.js";
import {validateUsername} from "../../services/global.js";
import logger from "../../services/logger.js";
import zcconfig from "../../services/config/zcconfig.js";
import {requireSudo} from "../../middleware/sudo.js";
import * as tokenService from "../../services/auth/tokenService.js";
import { setUserRoles } from "../../services/auth/permissionAdministration.js";
import { requireScope } from "../../middleware/scope.js";
import {
    createUserManagementService, USER_FIELDS, CONTACT_FIELDS, SESSION_FIELDS,
    safeContact, safeUser, UserManagementError,
} from "../../services/admin/userManagementService.js";
import {
    assignDefaultRolesToUser,
    assignRoleToUser,
    getUserPolicy,
    getUserRoleAssignments,
    listRoles,
    clearUserPolicyCache,
    policyAllowsScope,
    revokeRoleFromUser,
    SYSTEM_ROLE_KEYS,
} from "../../services/auth/policyEngine.js";

const router = Router();

const userManagement = createUserManagementService({
    db: prisma,
    tokens: tokenService,
    policyAllowsScope,
    getConfiguredAdmins: () => zcconfig.get("security.adminusers"),
    assignAdminRole: (id, actorId, db) => assignRoleToUser(id, SYSTEM_ROLE_KEYS.ADMIN, {
        assignedBy: actorId, reason: "admin-update-user-type", db,
    }),
    revokeAdminRole: (id, db) => revokeRoleFromUser(id, SYSTEM_ROLE_KEYS.ADMIN, { db }),
    clearPolicyCache: clearUserPolicyCache,
    afterCleanup: async (result) => {
        const gorse = await import("../../services/gorse.js");
        const jobs = [
            ...(result.postIds || []).map((id) => () => gorse.hidePost(id, { throwOnError: true })),
            ...(result.projectIds || []).map((id) => () => gorse.hideProject(id, { throwOnError: true })),
        ];
        let failures = 0;
        for (let offset = 0; offset < jobs.length; offset += 10) {
            const results = await Promise.allSettled(jobs.slice(offset, offset + 10).map((run) => run()));
            failures += results.filter(({ status }) => status === "rejected").length;
        }
        return failures ? [`本站数据已清理，但 ${failures} 项推荐数据隐藏失败，请稍后检查服务日志`] : [];
    },
});

function managementError(res, error) {
    const status = error instanceof UserManagementError ? error.status
        : error.status || (String(error.code || "").startsWith("CLEANUP_") ? 409 : 500);
    logger.error("[admin-users] 管理操作失败", { code: error.code, message: error.message });
    return res.status(status).json({
        code: status === 500 ? "USER_OPERATION_FAILED" : error.code,
        message: status === 500 ? "操作失败，数据未完成变更，请联系管理员检查日志" : error.message,
    });
}

const USER_TARGET_TYPE = "user";
const MAX_ITEMS_PER_PAGE = 200;

const parseUserId = (value) => {
    const userId = Number(value);
    if (!Number.isInteger(userId) || userId <= 0) {
        return null;
    }
    return userId;
};

const normalizeConfigValue = (value) => {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

async function findAdminUser(userId) {
    if (!userId) return null;
    return prisma.ow_users.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            display_name: true,
            email: true,
            status: true,
            type: true,
            avatar: true,
        },
    });
}

/**
 * @api {get} /admin/users/permissions/roles 获取可分配角色与权限清单
 * @apiName GetUserPermissionRoles
 * @apiGroup AdminUsers
 * @apiPermission admin
 */
router.get("/permissions/roles", async (req, res) => {
    try {
        const roles = await listRoles();
        res.json({
            status: "success",
            data: {
                roles,
            },
        });
    } catch (error) {
        console.error("Error fetching permission roles:", error);
        res.status(500).json({
            status: "error",
            message: "获取角色权限清单失败",
        });
    }
});

/**
 * @api {get} /admin/users/:id/permissions 获取用户角色权限
 * @apiName GetUserPermissions
 * @apiGroup AdminUsers
 * @apiPermission admin
 */
router.get("/:id/permissions", async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) {
            return res.status(400).json({
                status: "error",
                message: "无效用户ID",
            });
        }

        const user = await findAdminUser(userId);
        if (!user) {
            return res.status(404).json({
                status: "error",
                message: "用户不存在",
            });
        }

        const [assignments, policy] = await Promise.all([
            getUserRoleAssignments(userId),
            getUserPolicy(userId, { useCache: false }),
        ]);

        res.json({
            status: "success",
            data: {
                user,
                assignments,
                policy,
            },
        });
    } catch (error) {
        console.error("Error fetching user permissions:", error);
        res.status(500).json({
            status: "error",
            message: "获取用户权限失败",
        });
    }
});

/**
 * @api {put} /admin/users/:id/permissions 整体更新用户角色权限
 * @apiName UpdateUserPermissions
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiBody {String[]} role_keys 用户应拥有的角色 key 列表
 */
router.put("/:id/permissions", requireScope("admin:permissions:manage"), async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) {
            return res.status(400).json({
                status: "error",
                message: "无效用户ID",
            });
        }

        const roleKeys = Array.isArray(req.body?.role_keys)
            ? [...new Set(req.body.role_keys.map((roleKey) => String(roleKey || "").trim()).filter(Boolean))]
            : null;
        if (!roleKeys) {
            return res.status(400).json({
                status: "error",
                message: "role_keys 必须是数组",
            });
        }

        const user = await findAdminUser(userId);
        if (!user) {
            return res.status(404).json({
                status: "error",
                message: "用户不存在",
            });
        }

        await setUserRoles(res.locals.userid, userId, roleKeys, {
            reason: "admin-permission-page",
        });

        const [assignments, policy] = await Promise.all([
            getUserRoleAssignments(userId),
            getUserPolicy(userId, { useCache: false }),
        ]);

        res.json({
            status: "success",
            message: "用户权限已更新",
            data: {
                user,
                assignments,
                policy,
            },
        });
    } catch (error) {
        console.error("Error updating user permissions:", error);
        const badRole = /角色不存在|未知系统角色/.test(error.message || "");
        res.status(error.status || (badRole ? 400 : 500)).json({
            status: "error",
            code: error.code || "PERMISSION_OPERATION_FAILED",
            message: error.status || badRole ? error.message : "更新用户权限失败",
        });
    }
});

/**
 * @api {get} /admin/users/:id/target-configs 获取指定用户 target configs
 * @apiName GetUserTargetConfigs
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id 用户ID
 * @apiQuery {Number} [page=1] 页码（从1开始）
 * @apiQuery {Number} [itemsPerPage=20] 每页条数，最大200
 * @apiQuery {String} [key] 按 key 精确匹配
 * @apiQuery {String} [keyLike] 按 key 模糊匹配
 *
 * @apiSuccess {String} status 请求状态
 * @apiSuccess {Object} data 结果数据
 */
router.get("/:id/target-configs", async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) {
            return res.status(400).json({
                status: "error",
                message: "无效用户ID",
            });
        }

        const user = await prisma.ow_users.findUnique({
            where: {id: userId},
            select: {id: true},
        });

        if (!user) {
            return res.status(404).json({
                status: "error",
                message: "用户不存在",
            });
        }

        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const itemsPerPageRaw = Number.parseInt(req.query.itemsPerPage, 10) || 20;
        const itemsPerPage = Math.min(MAX_ITEMS_PER_PAGE, Math.max(1, itemsPerPageRaw));
        const key = typeof req.query.key === "string" ? req.query.key.trim() : "";
        const keyLike = typeof req.query.keyLike === "string" ? req.query.keyLike.trim() : "";

        const where = {
            target_type: USER_TARGET_TYPE,
            target_id: String(userId),
        };

        if (key) {
            where.key = key;
        } else if (keyLike) {
            where.key = {
                contains: keyLike,
            };
        }

        const [items, total] = await Promise.all([
            prisma.ow_target_configs.findMany({
                where,
                orderBy: [
                    {updated_at: "desc"},
                    {id: "desc"},
                ],
                skip: (page - 1) * itemsPerPage,
                take: itemsPerPage,
                select: {
                    id: true,
                    target_type: true,
                    target_id: true,
                    key: true,
                    value: true,
                    created_at: true,
                    updated_at: true,
                },
            }),
            prisma.ow_target_configs.count({where}),
        ]);

        res.json({
            status: "success",
            data: {
                items,
                total,
                page,
                itemsPerPage,
            },
        });
    } catch (error) {
        console.error("Error fetching user target configs:", error);
        res.status(500).json({
            status: "error",
            message: "获取用户target config失败",
        });
    }
});

/**
 * @api {put} /admin/users/:id/target-configs/:key 设置指定用户 target config
 * @apiName UpsertUserTargetConfig
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id 用户ID
 * @apiParam {String} key 配置键
 * @apiBody {String|Object|Number|Boolean} value 配置值（最终存储为字符串）
 *
 * @apiSuccess {String} status 请求状态
 * @apiSuccess {String} message 结果描述
 * @apiSuccess {Object} data 配置记录
 */
router.put("/:id/target-configs/:key", async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) {
            return res.status(400).json({
                status: "error",
                message: "无效用户ID",
            });
        }

        const configKey = String(req.params.key || "").trim();
        if (!configKey) {
            return res.status(400).json({
                status: "error",
                message: "配置key不能为空",
            });
        }

        if (configKey.length > 255) {
            return res.status(400).json({
                status: "error",
                message: "配置key长度不能超过255",
            });
        }

        if (typeof req.body === "undefined" || typeof req.body.value === "undefined") {
            return res.status(400).json({
                status: "error",
                message: "缺少value字段",
            });
        }

        const user = await prisma.ow_users.findUnique({
            where: {id: userId},
            select: {id: true},
        });

        if (!user) {
            return res.status(404).json({
                status: "error",
                message: "用户不存在",
            });
        }

        const normalizedValue = normalizeConfigValue(req.body.value);
        const record = await prisma.ow_target_configs.upsert({
            where: {
                target_type_target_id_key: {
                    target_type: USER_TARGET_TYPE,
                    target_id: String(userId),
                    key: configKey,
                },
            },
            update: {
                value: normalizedValue,
            },
            create: {
                target_type: USER_TARGET_TYPE,
                target_id: String(userId),
                key: configKey,
                value: normalizedValue,
            },
            select: {
                id: true,
                target_type: true,
                target_id: true,
                key: true,
                value: true,
                created_at: true,
                updated_at: true,
            },
        });

        res.json({
            status: "success",
            message: "用户target config已更新",
            data: record,
        });
    } catch (error) {
        console.error("Error updating user target config:", error);
        res.status(500).json({
            status: "error",
            message: "更新用户target config失败",
        });
    }
});

/**
 * @api {get} /admin/users List users with pagination, sorting and filtering
 * @apiName GetUsers
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiQuery {Number} page Current page number (1-based)
 * @apiQuery {Number} itemsPerPage Items per page
 * @apiQuery {String} sortBy Field to sort by
 * @apiQuery {String} sortDesc Sort direction (true for descending)
 * @apiQuery {String} search Search term for username/email/display_name
 * @apiQuery {String} status Filter by status
 * @apiQuery {String} type Filter by user type
 *
 * @apiSuccess {Object[]} items List of users
 * @apiSuccess {Number} total Total number of users matching filters
 */
router.get("/", async (req, res) => {
    try {
        const {
            page = 1,
            itemsPerPage = 10,
            sortBy = "id",
            sortDesc = false,
            search = "",
            status,
            type,
        } = req.query;

        // Build filter conditions
        const where = {
            AND: [
                {
                    OR: [
                        {username: {contains: search}},
                        {email: {contains: search}},
                        {display_name: {contains: search}},
                    ],
                },
            ],
        };

        if (status) {
            where.AND.push({status});
        }

        if (type) {
            where.AND.push({type});
        }

        const requestedSort = req.query.sort_by || sortBy;
        const sortable = new Set(["id", "username", "display_name", "email", "status", "type", "regTime", "loginTime"]);
        const direction = req.query.sort_order === "desc" || sortDesc === true || sortDesc === "true" ? "desc" : "asc";
        const orderBy = { [sortable.has(requestedSort) ? requestedSort : "id"]: direction };
        const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
        const pageSize = Math.min(MAX_ITEMS_PER_PAGE, Math.max(1, Number.parseInt(itemsPerPage, 10) || 10));

        // Execute query with pagination
        const [items, total] = await Promise.all([
            prisma.ow_users.findMany({
                where,
                orderBy,
                skip: (currentPage - 1) * pageSize,
                take: pageSize,
                select: {
                    id: true,
                    username: true,
                    email: true,
                    display_name: true,
                    status: true,
                    type: true,
                    regTime: true,
                    loginTime: true,
                    avatar: true,
                    location: true,
                    region: true,
                    url: true,
                    bio: true,
                    birthday: true,
                    sex: true,
                    custom_status: true,
                    featured_projects: true,
                },
            }),
            prisma.ow_users.count({where}),
        ]);

        res.json({
            items,
            total,
        });
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/users/:id Get user details
 * @apiName GetUser
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 *
 * @apiSuccess {Object} user User details
 */
router.get("/:id", async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) throw new UserManagementError(400, "INVALID_USER_ID", "无效用户 ID");
        const user = await prisma.ow_users.findUnique({
            where: { id: userId },
            select: {
                ...USER_FIELDS,
                contacts: { select: CONTACT_FIELDS },
                authored_projects: { select: { id: true, name: true, title: true, state: true, time: true } },
                tokens: { select: SESSION_FIELDS, take: 20, orderBy: { created_at: "desc" } },
            },
        });
        if (!user) throw new UserManagementError(404, "USER_NOT_FOUND", "用户不存在");
        res.json({ ...safeUser(user), authored_projects: user.authored_projects, auth_tokens: user.tokens });
    } catch (error) {
        managementError(res, error);
    }
});

/**
 * @api {post} /admin/users Create new user
 * @apiName CreateUser
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiBody {String} username Username
 * @apiBody {String} email Email address
 * @apiBody {String} password Password
 * @apiBody {String} display_name Display name
 * @apiBody {String} type User type
 * @apiBody {String} status User status
 */
router.post("/", async (req, res) => {
    try {
        const {
            username,
            email,
            password,
            display_name,
            type = "user",
            status = "active",
        } = req.body;

        // Validate required fields
        if (!username || !email || !password) {
            return res.status(400).json({error: "Missing required fields"});
        }

        // Validate username format
        const validation = validateUsername(username);
        if (!validation.valid) {
            return res.status(400).json({error: validation.message});
        }

        // Check for existing username/email
        const existing = await prisma.ow_users.findFirst({
            where: {
                OR: [{username}, {email}],
            },
        });

        if (existing) {
            return res
                .status(400)
                .json({error: "Username or email already exists"});
        }

        // Create user and role assignments atomically
        const user = await prisma.$transaction(async (tx) => {
            const createdUser = await tx.ow_users.create({
                data: {
                    username,
                    email,
                    password, // Note: Ensure password is hashed before saving
                    display_name: display_name || username,
                    type,
                    status,
                    regTime: new Date(),
                    loginTime: new Date(),
                },
            });
            await assignDefaultRolesToUser(createdUser.id, tx);
            if (["admin", "administrator"].includes(String(type || "").toLowerCase())) {
                await assignRoleToUser(createdUser.id, SYSTEM_ROLE_KEYS.ADMIN, {
                    assignedBy: res.locals.userid || null,
                    reason: "admin-create-user",
                    db: tx,
                });
            }
            return createdUser;
        });

        res.status(201).json(safeUser(user));
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/users/:id Update user
 * @apiName UpdateUser
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {Object} updates Fields to update
 * @apiBody {String} [updates.display_name] Display name
 * @apiBody {String} [updates.email] Primary email address
 * @apiBody {String} [updates.status] User status (active, suspended, banned, pending)
 * @apiBody {String} [updates.type] User type (user, admin, etc)
 * @apiBody {String} [updates.bio] Markdown biography
 * @apiBody {String} [updates.location] User location
 * @apiBody {String} [updates.region] User region
 * @apiBody {String} [updates.birthday] User birthday (ISO date string)
 * @apiBody {String} [updates.sex] User gender
 * @apiBody {String} [updates.url] User website URL
 * @apiBody {Object} [updates.custom_status] Custom status object with emoji and text
 * @apiBody {Number[]} [updates.featured_projects] Array of featured project IDs
 * @apiBody {String} [updates.avatar] Avatar URL/hash
 * @apiBody {Object[]} [updates.contacts] Array of contact objects
 * @apiBody {String} updates.contacts[].contact_type Contact type (email, phone, etc)
 * @apiBody {String} updates.contacts[].contact_value Contact value
 * @apiBody {Boolean} updates.contacts[].is_primary Whether this is primary contact
 * @apiBody {Boolean} updates.contacts[].verified Whether contact is verified
 */
router.put("/:id", async (req, res) => {
    try {
        const userId = parseUserId(req.params.id);
        if (!userId) throw new UserManagementError(400, "INVALID_USER_ID", "无效用户 ID");
        const updates = { ...req.body };

        const existingUser = await userManagement.findUser(userId);

        if (!existingUser) {
            return res.status(404).json({error: "User not found"});
        }

        // Check username uniqueness if it's being updated
        if (updates.username && updates.username !== existingUser.username) {
            const validation = validateUsername(updates.username);
            if (!validation.valid) {
                return res.status(400).json({error: validation.message});
            }

            const usernameExists = await prisma.ow_users.findFirst({
                where: {
                    username: updates.username,
                    NOT: {
                        id: userId
                    }
                }
            });

            if (usernameExists) {
                return res.status(400).json({error: "Username already exists"});
            }
        }

        // Connections have their own ownership-checked management endpoints.
        delete updates.contacts;

        // Handle avatar update
        if (updates.avatar) {
            updates.images = updates.avatar; // Update both avatar and images fields
        }

        // Clean up empty strings and handle special fields
        const cleanUpdates = {};
        for (const [key, value] of Object.entries(updates)) {
            // Skip empty strings for optional fields
            if (value === "") {
                continue;
            }

            // Handle special fields
            switch (key) {
                case "birthday":
                    // Only set birthday if it's a valid date string
                    if (value && Date.parse(value)) {
                        cleanUpdates[key] = new Date(value);
                    }
                    break;
                case "custom_status":
                    // Only include custom_status if it has non-empty values
                    if (value && (value.emoji || value.text)) {
                        cleanUpdates[key] = value;
                    }
                    break;
                case "featured_projects":
                    cleanUpdates[key] = Array.isArray(value) ? (value[0] ? Number(value[0]) : null)
                        : value === null ? null : Number(value);
                    break;
                default:
                    cleanUpdates[key] = value;
            }
        }

        const user = await userManagement.update(userId, res.locals.userid, cleanUpdates);
        res.json({ ...safeUser(user), warnings: user.warnings });
    } catch (error) {
        managementError(res, error);
    }
});

/**
 * @api {delete} /admin/users/:id Delete user
 * @apiName DeleteUser
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 */
router.delete("/:id", requireSudo, async (req, res) => {
    try {
        res.json(await userManagement.cleanup(req.params.id, res.locals.userid, req.body || {}, true));
    } catch (error) {
        managementError(res, error);
    }
});

router.get("/:id/data-summary", async (req, res) => {
    try {
        res.json(await userManagement.summary(req.params.id, res.locals.userid));
    } catch (error) {
        managementError(res, error);
    }
});

router.post("/:id/cleanup", requireSudo, async (req, res) => {
    try {
        res.json(await userManagement.cleanup(req.params.id, res.locals.userid, req.body || {}));
    } catch (error) {
        managementError(res, error);
    }
});

router.get("/:id/sessions", async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(MAX_ITEMS_PER_PAGE, Math.max(1, Number.parseInt(req.query.itemsPerPage, 10) || 20));
        res.json(await userManagement.sessions(req.params.id, page, limit));
    } catch (error) {
        managementError(res, error);
    }
});

router.delete("/:id/sessions/:tokenId", async (req, res) => {
    try {
        res.json(await userManagement.revokeSessions(req.params.id, res.locals.userid, req.params.tokenId));
    } catch (error) {
        managementError(res, error);
    }
});

router.post("/:id/sessions/revoke-all", async (req, res) => {
    try {
        res.json(await userManagement.revokeSessions(req.params.id, res.locals.userid));
    } catch (error) {
        managementError(res, error);
    }
});

/**
 * @api {post} /admin/users/:id/status Update user status
 * @apiName UpdateUserStatus
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {String} status New status
 */
router.post("/:id/status", async (req, res) => {
    try {
        const user = await userManagement.changeStatus(req.params.id, res.locals.userid, req.body?.status);
        res.json({ ...user, message: "用户状态已更新" });
    } catch (error) {
        managementError(res, error);
    }
});

/**
 * @api {get} /admin/users/stats/overview Get user statistics
 * @apiName GetUserStats
 * @apiGroup AdminUsers
 * @apiPermission admin
 */
router.get("/stats/overview", async (req, res) => {
    try {
        const stats = await prisma.$transaction([
            prisma.ow_users.groupBy({
                by: ["status", "type"],
                _count: true,
            }),
            // New users in last 7 days
            prisma.ow_users.count({
                where: {
                    regTime: {
                        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                    },
                },
            }),
        ]);

        const summary = summarizeGroups(stats[0], ["status", "type"]);
        res.json({
            totalUsers: summary.total,
            usersByStatus: summary.groups[0],
            usersByType: summary.groups[1],
            newUsersLast7Days: stats[1],
        });
    } catch (error) {
        console.error("Error fetching user stats:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/users/:id/profile Update user profile
 * @apiName UpdateUserProfile
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {Object} profile Profile fields to update
 */
router.put("/:id/profile", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const {
            display_name,
            bio,
            location,
            region,
            birthday,
            sex,
            url,
            custom_status,
            featured_projects,
        } = req.body;

        const user = await prisma.ow_users.update({
            where: {id: userId},
            data: {
                display_name: display_name,
                bio: bio,
                location: location,
                region: region,
                birthday: birthday ? new Date(birthday) : undefined,
                sex: sex,
                url: url,
                custom_status: custom_status,
                featured_projects: featured_projects,
                updatedAt: new Date(),
            },
        });

        res.json(safeUser(user));
    } catch (error) {
        console.error("Error updating user profile:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/users/:id/avatar Update user avatar
 * @apiName UpdateUserAvatar
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {String} avatar Avatar URL or identifier
 */
router.put("/:id/avatar", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const {avatar} = req.body;

        const user = await prisma.ow_users.update({
            where: {id: userId},
            data: {
                avatar: avatar,
                images: avatar, // Update both avatar and images fields
                updatedAt: new Date(),
            },
        });

        res.json(safeUser(user));
    } catch (error) {
        console.error("Error updating user avatar:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/users/:id/contacts Update user contact information
 * @apiName UpdateUserContacts
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {Object[]} contacts Array of contact objects
 */
router.put("/:id/contacts", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const {contacts} = req.body;

        // Validate contacts array
        if (!Array.isArray(contacts)) {
            return res.status(400).json({error: "Contacts must be an array"});
        }

        // Update or create contacts
        const updatedContacts = await Promise.all(
            contacts.map((contact) =>
                prisma.ow_users_contacts.upsert({
                    where: {
                        contact_value: contact.contact_value,
                    },
                    update: {
                        contact_type: contact.contact_type,
                        contact_info: contact.contact_info,
                        is_primary: contact.is_primary,
                        verified: contact.verified,
                        metadata: contact.metadata,
                        updated_at: new Date(),
                    },
                    create: {
                        user_id: userId,
                        contact_type: contact.contact_type,
                        contact_value: contact.contact_value,
                        contact_info: contact.contact_info,
                        is_primary: contact.is_primary,
                        verified: contact.verified,
                        metadata: contact.metadata,
                    },
                })
            )
        );

        res.json(updatedContacts);
    } catch (error) {
        console.error("Error updating user contacts:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/users/:id/activity Get user activity
 * @apiName GetUserActivity
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 */
router.get("/:id/activity", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        const activity = await prisma.$transaction([
            // Get recent events
            prisma.ow_events.findMany({
                where: {actor_id: userId},
                orderBy: {created_at: "desc"},
                take: 10,
            }),
            // Get recent notifications
            prisma.ow_notifications.findMany({
                where: {user_id: userId},
                orderBy: {created_at: "desc"},
                take: 10,
            }),
            // Get auth tokens
            prisma.ow_tokens.findMany({
                where: {user_id: userId},
                select: SESSION_FIELDS,
                orderBy: {last_used_at: "desc"},
                take: 5,
            }),
            // Get analytics events
            prisma.ow_analytics_event.findMany({
                where: {user_id: userId},
                orderBy: {created_at: "desc"},
                take: 10,
                include: {
                    device: true,
                },
            }),
        ]);

        res.json({
            events: activity[0],
            notifications: activity[1],
            auth_tokens: activity[2],
            analytics: activity[3],
        });
    } catch (error) {
        console.error("Error fetching user activity:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/users/:id/relationships Get user relationships
 * @apiName GetUserRelationships
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 */
router.get("/:id/relationships", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);

        const relationships = await prisma.$transaction([
            // Get followers
            prisma.ow_user_relationships.findMany({
                where: {
                    target_user_id: userId,
                    relationship_type: "follow",
                },
                include: {
                    source_user: {
                        select: {
                            id: true,
                            username: true,
                            display_name: true,
                            avatar: true,
                        },
                    },
                },
            }),
            // Get following
            prisma.ow_user_relationships.findMany({
                where: {
                    source_user_id: userId,
                    relationship_type: "follow",
                },
                include: {
                    target_user: {
                        select: {
                            id: true,
                            username: true,
                            display_name: true,
                            avatar: true,
                        },
                    },
                },
            }),
            // Get blocked users
            prisma.ow_user_relationships.findMany({
                where: {
                    source_user_id: userId,
                    relationship_type: "block",
                },
                include: {
                    target_user: {
                        select: {
                            id: true,
                            username: true,
                            display_name: true,
                        },
                    },
                },
            }),
        ]);

        res.json({
            followers: relationships[0],
            following: relationships[1],
            blocked: relationships[2],
        });
    } catch (error) {
        console.error("Error fetching user relationships:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/users/:id/connections Get user connections
 * @apiName GetUserConnections
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiQuery {String} [type] Filter by connection type (e.g. oauth_github, email, phone)
 *
 * @apiSuccess {Object[]} connections List of user connections
 */
router.get("/:id/connections", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const {type} = req.query;

        // Build where clause
        const where = {
            user_id: userId,
        };

        // Add type filter if provided
        if (type) {
            where.contact_type = type;
        }

        const connections = await prisma.ow_users_contacts.findMany({
            where,
            select: CONTACT_FIELDS,
            orderBy: {
                created_at: "desc",
            },
        });

        res.json(connections.map(safeContact));
    } catch (error) {
        console.error("Error fetching user connections:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {post} /admin/users/:id/connections Add OAuth connection
 * @apiName AddUserConnection
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiBody {String} type OAuth provider type (oauth_github, oauth_google, etc)
 * @apiBody {String} value OAuth provider user ID or unique identifier
 * @apiBody {Object} [info] Additional connection info
 * @apiBody {Object} [metadata] Additional metadata
 */
router.post("/:id/connections", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const {contact_type, contact_value, contact_info, metadata} = req.body;

        // Validate required fields
        if (!contact_type || !contact_value) {
            return res.status(400).json({error: "Missing required fields"});
        }

        // Check for existing connection
        const existing = await prisma.ow_users_contacts.findUnique({
            where: {
                contact_value: contact_value,
            },
        });

        if (existing) {
            return res.status(400).json({error: "Connection already exists"});
        }

        // Create connection
        const connection = await prisma.ow_users_contacts.create({
            data: {
                user_id: userId,
                contact_type: contact_type,
                contact_value: contact_value,
                contact_info: contact_info,
                metadata: metadata,
                verified: true, // OAuth connections are verified by default
                created_at: new Date(),
                updated_at: new Date(),
            },
        });

        res.status(201).json(connection);
    } catch (error) {
        console.error("Error creating connection:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/users/:id/connections/:connectionId Update connection
 * @apiName UpdateUserConnection
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiParam {Number} connectionId Connection ID
 * @apiBody {String} [contact_type] Connection type (oauth_github, email, phone, etc)
 * @apiBody {String} [contact_value] Connection value (email address, phone number, OAuth ID etc)
 * @apiBody {Object} [contact_info] Additional connection info
 * @apiBody {Object} [metadata] Additional metadata
 * @apiBody {Boolean} [verified] Update verification status
 */
router.put("/:id/connections/:connectionId", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const connectionId = parseInt(req.params.connectionId);
        const {contact_info, contact_value, contact_type, metadata, verified} =
            req.body;

        // Verify connection exists and belongs to user
        const existing = await prisma.ow_users_contacts.findFirst({
            where: {
                contact_id: connectionId,
                user_id: userId,
            },
        });

        if (!existing) {
            return res.status(404).json({error: "Connection not found"});
        }

        // Update connection
        const connection = await prisma.ow_users_contacts.update({
            where: {
                contact_id: connectionId,
            },
            data: {
                contact_info: contact_info,
                contact_value: contact_value,
                contact_type: contact_type,
                metadata: metadata,
                verified: verified,
                updated_at: new Date(),
            },
        });

        res.json(connection);
    } catch (error) {
        console.error("Error updating connection:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {delete} /admin/users/:id/connections/:connectionId Delete connection
 * @apiName DeleteUserConnection
 * @apiGroup AdminUsers
 * @apiPermission admin
 *
 * @apiParam {Number} id User ID
 * @apiParam {Number} connectionId Connection ID
 */
router.delete("/:id/connections/:connectionId", async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const connectionId = parseInt(req.params.connectionId);

        // Verify connection exists and belongs to user
        const existing = await prisma.ow_users_contacts.findFirst({
            where: {
                contact_id: connectionId,
                user_id: userId,
            },
        });

        if (!existing) {
            return res.status(404).json({error: "Connection not found"});
        }

        // Delete connection
        await prisma.ow_users_contacts.delete({
            where: {
                contact_id: connectionId,
            },
        });

        res.status(204).send();
    } catch (error) {
        console.error("Error deleting connection:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

export default router;
