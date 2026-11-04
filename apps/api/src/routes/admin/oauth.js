import { Router } from "express";
import { prisma } from "../../services/prisma.js";
import logger from "../../services/logger.js";
import { revokeTokensWhere } from "../../services/auth/tokenService.js";
import { normalizeScopes } from "../../services/auth/scopes.js";

const router = Router();

const MAX_ITEMS_PER_PAGE = 100;
const ALLOWED_SORT_FIELDS = new Set([
    "id",
    "name",
    "client_id",
    "status",
    "type",
    "is_verified",
    "is_public",
    "auto_authorize",
    "created_at",
    "updated_at",
    "owner_id",
]);

const ALLOWED_STATUS = new Set([
    "active",
    "inactive",
    "pending",
    "suspended",
    "revoked",
    "deleted",
]);

const parseBooleanQuery = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return null;
};

const parsePositiveInt = (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
};

const normalizeArrayField = (value) => {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((item) => String(item).trim()).filter(Boolean);
            }
        } catch {
            // fall through
        }
        return trimmed
            .split(/\r?\n|,/g)
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
};

const ownerSelect = {
    id: true,
    username: true,
    display_name: true,
    email: true,
    avatar: true,
    status: true,
};

const countSelect = {
    authorizations: true,
    access_tokens: true,
};

/**
 * 按 client_id 或 数字 id 查找应用
 */
async function findApplicationByIdentifier(identifier, { includeDeleted = true, select } = {}) {
    const raw = String(identifier || "").trim();
    if (!raw) return null;

    const asId = Number(raw);
    const where = Number.isInteger(asId) && asId > 0
        ? { OR: [{ id: asId }, { client_id: raw }] }
        : { client_id: raw };

    if (!includeDeleted) {
        where.status = { not: "deleted" };
    }

    return prisma.ow_oauth_applications.findFirst({
        where,
        ...(select ? { select } : {
            include: {
                owner: { select: ownerSelect },
                _count: { select: countSelect },
            },
        }),
    });
}

/**
 * @api {get} /admin/oauth/applications 列出全部 OAuth 应用
 */
router.get("/applications", async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(
            MAX_ITEMS_PER_PAGE,
            Math.max(1, parseInt(req.query.limit || req.query.itemsPerPage, 10) || 20)
        );
        const search = String(req.query.search || "").trim();
        const status = String(req.query.status || "").trim();
        const sortBy = ALLOWED_SORT_FIELDS.has(String(req.query.sortBy || ""))
            ? String(req.query.sortBy)
            : "updated_at";
        const sortOrder = String(req.query.sortOrder || "desc").toLowerCase() === "asc"
            ? "asc"
            : "desc";

        const where = { AND: [] };

        if (search) {
            where.AND.push({
                OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { description: { contains: search, mode: "insensitive" } },
                    { client_id: { contains: search, mode: "insensitive" } },
                    {
                        owner: {
                            OR: [
                                { username: { contains: search, mode: "insensitive" } },
                                { display_name: { contains: search, mode: "insensitive" } },
                                { email: { contains: search, mode: "insensitive" } },
                            ],
                        },
                    },
                ],
            });
        }

        if (status) {
            if (!ALLOWED_STATUS.has(status)) {
                return res.status(400).json({ status: "error", message: "无效的状态筛选" });
            }
            where.AND.push({ status });
        }

        if (req.query.owner_id !== undefined && req.query.owner_id !== "") {
            const ownerId = parsePositiveInt(req.query.owner_id);
            if (!ownerId) {
                return res.status(400).json({ status: "error", message: "owner_id 必须是正整数" });
            }
            where.AND.push({ owner_id: ownerId });
        }

        const isVerified = parseBooleanQuery(req.query.is_verified);
        if (isVerified === null) {
            return res.status(400).json({ status: "error", message: "is_verified 参数无效" });
        }
        if (isVerified !== undefined) {
            where.AND.push({ is_verified: isVerified });
        }

        const isPublic = parseBooleanQuery(req.query.is_public);
        if (isPublic === null) {
            return res.status(400).json({ status: "error", message: "is_public 参数无效" });
        }
        if (isPublic !== undefined) {
            where.AND.push({ is_public: isPublic });
        }

        const autoAuthorize = parseBooleanQuery(req.query.auto_authorize);
        if (autoAuthorize === null) {
            return res.status(400).json({ status: "error", message: "auto_authorize 参数无效" });
        }
        if (autoAuthorize !== undefined) {
            where.AND.push({ auto_authorize: autoAuthorize });
        }

        const finalWhere = where.AND.length > 0 ? where : {};

        const [items, total] = await Promise.all([
            prisma.ow_oauth_applications.findMany({
                where: finalWhere,
                orderBy: { [sortBy]: sortOrder },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    owner: { select: ownerSelect },
                    _count: { select: countSelect },
                },
            }),
            prisma.ow_oauth_applications.count({ where: finalWhere }),
        ]);

        // 列表不返回 client_secret
        const safeItems = items.map(({ client_secret, ...rest }) => rest);

        res.json({
            items: safeItems,
            total,
            pagination: {
                page,
                limit,
                total,
                totalItems: total,
                totalPages: Math.ceil(total / limit) || 1,
            },
        });
    } catch (error) {
        logger.error("[admin/oauth] list applications failed:", error);
        res.status(500).json({ status: "error", message: "加载应用列表失败" });
    }
});

/**
 * @api {get} /admin/oauth/applications/:identifier 应用详情
 */
router.get("/applications/:identifier", async (req, res) => {
    try {
        const application = await findApplicationByIdentifier(req.params.identifier);
        if (!application) {
            return res.status(404).json({ status: "error", message: "Application not found" });
        }

        const { client_secret, ...safe } = application;
        res.json({ application: safe });
    } catch (error) {
        logger.error("[admin/oauth] get application failed:", error);
        res.status(500).json({ status: "error", message: "加载应用详情失败" });
    }
});

/**
 * @api {put} /admin/oauth/applications/:identifier 更新应用
 */
router.put("/applications/:identifier", async (req, res) => {
    try {
        const application = await findApplicationByIdentifier(req.params.identifier, { select: { id: true, type: true } });
        if (!application) {
            return res.status(404).json({ status: "error", message: "Application not found" });
        }

        const {
            name,
            description,
            homepage_url,
            redirect_uris,
            client_type,
            type,
            scopes,
            webhook_url,
            logo_url,
            terms_url,
            privacy_url,
            status,
            is_public,
            auto_authorize,
        } = req.body || {};

        const data = {};

        if (name !== undefined) {
            const trimmed = String(name || "").trim();
            if (!trimmed) {
                return res.status(400).json({ status: "error", message: "应用名称不能为空" });
            }
            data.name = trimmed;
        }

        if (description !== undefined) {
            data.description = description === null || description === ""
                ? null
                : String(description);
        }

        if (homepage_url !== undefined) {
            data.homepage_url = homepage_url ? String(homepage_url).trim() : null;
        }

        if (redirect_uris !== undefined) {
            const uris = normalizeArrayField(redirect_uris);
            if (uris.length === 0) {
                return res.status(400).json({ status: "error", message: "至少需要一个 redirect URI" });
            }
            data.redirect_uris = uris;
        }

        if (client_type !== undefined || type !== undefined) {
            const value = String(client_type || type || "").trim();
            if (!value) {
                return res.status(400).json({ status: "error", message: "client_type 不能为空" });
            }
            data.client_type = value;
            if (type !== undefined) {
                data.type = String(type).trim() || application.type;
            }
        }

        if (scopes !== undefined) {
            data.scopes = normalizeScopes(scopes);
        }

        if (webhook_url !== undefined) {
            data.webhook_url = webhook_url ? String(webhook_url).trim() : null;
        }
        if (logo_url !== undefined) {
            data.logo_url = logo_url ? String(logo_url).trim() : null;
        }
        if (terms_url !== undefined) {
            data.terms_url = terms_url ? String(terms_url).trim() : null;
        }
        if (privacy_url !== undefined) {
            data.privacy_url = privacy_url ? String(privacy_url).trim() : null;
        }

        if (status !== undefined) {
            const nextStatus = String(status || "").trim();
            if (!ALLOWED_STATUS.has(nextStatus) || nextStatus === "deleted") {
                return res.status(400).json({
                    status: "error",
                    message: "无效状态；删除请使用 DELETE 接口",
                });
            }
            data.status = nextStatus;
        }

        if (is_public !== undefined) {
            data.is_public = Boolean(is_public);
        }

        if (auto_authorize !== undefined) {
            data.auto_authorize = Boolean(auto_authorize);
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ status: "error", message: "没有可更新的字段" });
        }

        const updated = await prisma.ow_oauth_applications.update({
            where: { id: application.id },
            data,
            include: {
                owner: { select: ownerSelect },
                _count: { select: countSelect },
            },
        });

        const { client_secret, ...safe } = updated;
        res.json({ status: "success", application: safe });
    } catch (error) {
        logger.error("[admin/oauth] update application failed:", error);
        res.status(500).json({ status: "error", message: "更新应用失败" });
    }
});

/**
 * @api {put|patch|post} /admin/oauth/applications/:identifier/verified 设置验证状态
 */
async function setVerifiedHandler(req, res) {
    try {
        const application = await findApplicationByIdentifier(req.params.identifier, { select: { id: true, is_verified: true } });
        if (!application) {
            return res.status(404).json({ status: "error", message: "Application not found" });
        }

        const next =
            req.body?.is_verified !== undefined
                ? Boolean(req.body.is_verified)
                : !application.is_verified;

        const updated = await prisma.ow_oauth_applications.update({
            where: { id: application.id },
            data: { is_verified: next },
            include: {
                owner: { select: ownerSelect },
                _count: { select: countSelect },
            },
        });

        const { client_secret, ...safe } = updated;
        res.json({ status: "success", application: safe });
    } catch (error) {
        logger.error("[admin/oauth] set verified failed:", error);
        res.status(500).json({ status: "error", message: "更新验证状态失败" });
    }
}

router.put("/applications/:identifier/verified", setVerifiedHandler);
router.patch("/applications/:identifier/verified", setVerifiedHandler);
router.post("/applications/:identifier/verified", setVerifiedHandler);

/**
 * @api {put|patch|post} /admin/oauth/applications/:identifier/auto-authorize 设置自动授权
 */
async function setAutoAuthorizeHandler(req, res) {
    try {
        const application = await findApplicationByIdentifier(req.params.identifier, { select: { id: true } });
        if (!application) {
            return res.status(404).json({ status: "error", message: "Application not found" });
        }

        if (req.body?.auto_authorize === undefined) {
            return res.status(400).json({ status: "error", message: "缺少 auto_authorize 字段" });
        }

        const next = Boolean(req.body.auto_authorize);

        const updated = await prisma.ow_oauth_applications.update({
            where: { id: application.id },
            data: { auto_authorize: next },
            include: {
                owner: { select: ownerSelect },
                _count: { select: countSelect },
            },
        });

        const { client_secret, ...safe } = updated;
        res.json({
            status: "success",
            message: next
                ? "已开启自动授权：用户登录后打开授权页将直接同意并跳转"
                : "已关闭自动授权",
            application: safe,
        });
    } catch (error) {
        logger.error("[admin/oauth] set auto_authorize failed:", error);
        res.status(500).json({ status: "error", message: "更新自动授权状态失败" });
    }
}

router.put("/applications/:identifier/auto-authorize", setAutoAuthorizeHandler);
router.patch("/applications/:identifier/auto-authorize", setAutoAuthorizeHandler);
router.post("/applications/:identifier/auto-authorize", setAutoAuthorizeHandler);

/**
 * @api {delete} /admin/oauth/applications/:identifier 下线应用（软删除 + 撤销授权）
 */
router.delete("/applications/:identifier", async (req, res) => {
    try {
        const application = await findApplicationByIdentifier(req.params.identifier, { select: { id: true, status: true } });
        if (!application) {
            return res.status(404).json({ status: "error", message: "Application not found" });
        }

        if (application.status === "deleted") {
            return res.json({ status: "success", message: "应用已处于下线状态" });
        }

        await prisma.ow_oauth_applications.update({
            where: { id: application.id },
            data: {
                status: "deleted",
                auto_authorize: false,
            },
        });

        await revokeTokensWhere({
            application_id: application.id,
            type: "oauth",
        });

        await prisma.ow_oauth_authorizations.updateMany({
            where: { application_id: application.id },
            data: { status: "revoked" },
        });

        res.json({
            status: "success",
            message: "应用已下线并撤销相关授权",
        });
    } catch (error) {
        logger.error("[admin/oauth] delete application failed:", error);
        res.status(500).json({ status: "error", message: "下线应用失败" });
    }
});

export default router;
