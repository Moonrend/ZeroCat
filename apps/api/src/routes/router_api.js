import logger from "../services/logger.js";
import zcconfig from "../services/config/zcconfig.js";

import {Router} from "express";
import cryptojs from "crypto-js";
import {prisma} from "../services/prisma.js";
import {needAdmin} from "../middleware/auth.js";
import followsRoutes from "./router_follows.js";
import {CONFIG_TYPES} from "../services/config/configTypes.js";
import sitemapService from '../services/sitemap.js';
import { buildAvatarURL } from "../utils/avatarUrl.js";
import { visibleWhere } from "../services/moderation/visibility.js";
import { sanitizeFeaturedProjects } from "../controllers/users.js";

var router = Router();

router.get("/usertx", async function (req, res, next) {
    try {
        const USER = await prisma.ow_users.findFirst({
            where: {
                id: parseInt(req.query.id),
                AND: [await visibleWhere('profile', res.locals.userid)],
            },
            select: {
                avatar: true,
            },
        });
        if (!USER) {
            res.status(404).json({
                status: "error",
                code: "404",
                message: "找不到页面",
            });
            return;
        }
        res.redirect(
            302,
            (await zcconfig.get("s3.staticurl")) + "/user/" + USER.avatar
        );
    } catch (err) {
        next(err);
    }
});

router.get("/getuserinfo", async function (req, res, next) {
    try {
        var user = await prisma.ow_users.findMany({
            where: {
                id: parseInt(req.query.id),
                AND: [await visibleWhere('profile', res.locals.userid)],
            },
            select: {
                id: true,
                display_name: true,
                bio: true,

                avatar: true,
                regTime: true,
                sex: true,
                username: true,
                location: true,
                region: true,
                birthday: true,
                featured_projects: true,
                custom_status: true,
                url: true,
            },
        });

        if (!user[0]) {
            logger.debug("用户不存在");
            return res.status(404).json({
                status: "error",
                code: "404",
                message: "找不到页面",
            });
        }
        const projectCounts = await prisma.ow_projects.groupBy({
            by: ['type'],
            where: {
                type: { in: ['scratch', 'python'] },
                state: 'public',
                AND: [await visibleWhere('project', res.locals.userid)],
            },
            _count: { _all: true },
        });
        const counts = new Map(projectCounts.map(row => [row.type, row._count._all]));
        const scratchcount = counts.get('scratch') || 0;
        const pythoncount = counts.get('python') || 0;
        res.send({
            status: "success",
            info: {
                user: { ...await sanitizeFeaturedProjects(user[0], res.locals.userid), avatarURL: await buildAvatarURL(user[0]?.avatar) },
                count: {pythoncount, scratchcount},
            },
        });
    } catch (err) {
        next(err);
    }
});

router.get("/info", async (req, res, next) => {
    try {
        const projectWhere = await visibleWhere('project', res.locals.userid);
        const userCount = await prisma.ow_users.count({ where: await visibleWhere('profile', res.locals.userid) });
        const projectCounts = await prisma.ow_projects.groupBy({
            by: ['type'],
            where: { type: { in: ['scratch', 'python'] }, AND: [projectWhere] },
            _count: { _all: true },
        });
        const counts = new Map(projectCounts.map(row => [row.type, row._count._all]));
        const scratchCount = counts.get('scratch') || 0;
        const pythonCount = counts.get('python') || 0;

        res.send({
            user: userCount,
            scratch: scratchCount,
            python: pythonCount,
            project: scratchCount + pythonCount,
        });
    } catch (err) {
        next(err);
    }
});

router.get("/projectinfo", async function (req, res, next) {
    try {
        const project = await prisma.ow_projects.findFirst({
            where: {
                id: Number(req.query.id),
                AND: [await visibleWhere('project', res.locals.userid)],
            },
            select: {
                id: true,
                authorid: true,
                thumbnail: true,
                time: true,
                default_branch: true,
                view_count: true,
                like_count: true,
                type: true,
                favo_count: true,
                title: true,
                state: true,
                description: true,
                license: true,
                name: true,
                star_count: true,
            },
        });

        if (!project) {
            res.send({
                code: 404,
                status: "404",
                message: "项目不存在或未发布",
            });
            return;
        }

        const author = await prisma.ow_users.findFirst({
            where: {id: project.authorid, AND: [await visibleWhere('profile', res.locals.userid)]},
            select: {
                display_name: true,
                avatar: true,
                bio: true,

            },
        });

        res.json({
            ...project,
            author_display_name: author?.display_name ?? null,
            author_avatar: author?.avatar ?? null,
            author_avatarURL: author ? await buildAvatarURL(author.avatar) : null,
            author_bio: author?.bio ?? null,
        });
    } catch (err) {
        next(err);
    }
});

router.get("/config", async function (req, res, next) {
    try {
        // Ensure zcconfig is initialized
        await zcconfig.initialize();

        // Get all public configurations
        const publicConfigs = zcconfig.getPublicConfigs();

        res.status(200).json(publicConfigs);
    } catch (err) {
        next(err);
    }
});

router.get("/config/:key", async function (req, res, next) {
    const result = await prisma.ow_config.findFirst({
        where: {is_public: true, key: req.params.key},
        select: {key: true, value: true},
    });

    if (!result) {
        res.status(404).send({
            status: "error",
            code: "404",
            message: "找不到配置项",
        });
        return;
    }
    res.status(200).send({
        [result.key]: result.value,
    });
});

router.get("/admin/config/reload", needAdmin, async function (req, res, next) {
    await zcconfig.loadConfigsFromDB();

    res.status(200).send({
        status: "success",
        message: "配置已重新加载",
    });
});
router.get("/admin/config/all", needAdmin, async function (req, res, next) {
    const result = await prisma.ow_config.findMany();

    res
        .status(200)
        .send({status: "success", message: "获取成功", data: result});
});

router.put("/admin/config/:id", needAdmin, async function (req, res, next) {
    try {
        const {id} = req.params;
        const {key, value, is_public} = req.body;

        const updatedConfig = await prisma.ow_config.update({
            where: {id: Number(id)},
            data: {
                key,
                value,
                is_public,
                updated_at: new Date(),
                user_id: res.locals.userid,
            },
        });

        res.status(200).send({
            status: "success",
            message: "配置已更新",
            data: updatedConfig,
        });
    } catch (error) {
        next(error);
    }
});

router.delete("/admin/config/:id", needAdmin, async function (req, res, next) {
    try {
        const {id} = req.params;

        await prisma.ow_config.delete({
            where: {id: Number(id)},
        });

        res.status(200).send({
            status: "success",
            message: "配置已删除",
        });
    } catch (error) {
        next(error);
    }
});
router.post("/admin/config", needAdmin, async function (req, res, next) {
    try {
        const {key, value, is_public} = req.body;

        const newConfig = await prisma.ow_config.create({
            data: {key, value, user_id: res.locals.userid, is_public},
        });

        res.status(200).send({
            status: "success",
            message: "配置已创建",
            data: newConfig,
        });
    } catch (error) {
        next(error);
    }
});

router.get("/tuxiaochao", async function (req, res) {
    const userId = res.locals.userid;
    const displayName = res.locals.display_name;

    // 获取配置
    const txcid = await zcconfig.get("feedback.txcid");
    const txckey = await zcconfig.get("feedback.txckey");
    const staticUrl = await zcconfig.get("s3.staticurl");

    // 判断登录状态和配置
    if (!res.locals.login || !txcid || !txckey) {
        res.redirect(
            txcid
                ? `https://support.qq.com/product/${txcid}`
                : "https://support.qq.com/product/597800"
        );
        return;
    }

    try {
        // 查询用户信息
        const USER = await prisma.ow_users.findFirst({
            where: {id: userId},
            select: {avatar: true},
        });

        if (!USER) {
            res.status(404).json({
                status: "error",
                code: "404",
                message: "找不到页面",
            });
            return;
        }

        const userImage = USER.avatar;
        const txcinfo = `${userId}${displayName}${staticUrl}/user/${userImage}${txckey}`;
        const cryptostr = cryptojs.MD5(txcinfo).toString();

        // 构建重定向链接
        const redirectUrl = `https://support.qq.com/product/${txcid}?openid=${userId}&nickname=${displayName}&avatar=${staticUrl}/user/${userImage}&user_signature=${cryptostr}`;
        res.redirect(redirectUrl);
    } catch (error) {
        // 错误处理
        console.error(error);
        res.status(500).json({
            status: "error",
            message: "服务器内部错误",
        });
    }
});

router.get("/public-config", async function (req, res, next) {
    try {
        // 获取所有 public: true 的配置项 key
        const publicKeys = Object.entries(CONFIG_TYPES)
            .filter(([_, v]) => v.public)
            .map(([k]) => k);
        // 并发获取所有配置项的当前值
        const entries = await Promise.all(
            publicKeys.map(async (key) => [key, await zcconfig.get(key)])
        );
        // 转为对象
        const result = Object.fromEntries(entries);
        res.status(200).json(result);
    } catch (err) {
        next(err);
    }
});

// Public sitemap route
router.get('/sitemap.xml', async (req, res) => {
    try {
        const enabled = await zcconfig.get('sitemap.enabled');
        if (!enabled) {
            return res.status(404).send('Sitemap is disabled');
        }

        const buffer = await sitemapService.getCurrentSitemapBuffer();
        res.header('Cache-Control', 'no-store');

        // Set appropriate headers
        res.header('Content-Type', 'application/xml');
        res.header('Content-Encoding', 'gzip');
        res.header('Content-Length', buffer.length);

        // Send the gzipped XML
        res.send(buffer);
    } catch (error) {
        logger.error('[api] Error serving sitemap:', error);
        res.status(500).send('Internal server error');
    }
});

// Mount follows routes
router.use('/follows', followsRoutes);

export default router;
