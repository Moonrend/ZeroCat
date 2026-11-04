import logger from "../services/logger.js";
import zcconfig from "../services/config/zcconfig.js";
import jsonwebtoken from "jsonwebtoken";
import fs, {createReadStream} from "fs";

import {Router} from "express";
import {createHash} from "crypto";
import {prisma} from "../services/prisma.js";
import {S3update} from "../services/global.js";
import {needLogin} from "../middleware/auth.js";
import { requireResource } from "../middleware/scope.js";
import {getProjectById, getProjectFile} from "../controllers/projects.js";
import multer from "multer";
import { validateFileTypeFromContent, uploadFile, handleAssetUpload, processImage, generateMD5, uploadToS3 } from "../services/assets.js";
import redisClient from "../services/redis.js";
import { userCanActOnProject } from "../services/projectCollaborationService.js";
import { authorize } from "../services/auth/authorization.js";
import { canViewContent, sanitizeProfile, visibleWhere } from "../services/moderation/visibility.js";

async function scratchProjectVisible(project, res, context = null) {
    if (!project || !await canViewContent('project', project, res.locals.userid)) return false;
    if (!res.locals.userid) return project.state === 'public';
    const contexts = [];
    if (res.locals.tokenType) contexts.push({ tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] });
    if (context) contexts.push(context);
    if (!contexts.length) return false;
    for (const tokenContext of contexts) {
        const decision = await authorize({
            ...tokenContext, actorId: res.locals.userid, requiredScope: `project:${project.id}:read`,
        });
        if (!decision.allowed) return false;
    }
    return true;
}

var router = Router();

const CLOUD_EVENT_TARGET_TYPE = "scratch_cloud";
const CLOUD_MAX_NAME_LENGTH = 256;
const CLOUD_MAX_VALUE_LENGTH = 1024;
const CLOUD_UPDATES_MAX_LIMIT = 200;
const TARGET_CONFIG_TYPE_PROJECT = "project";
const TARGET_CONFIG_KEY_CLOUD_ANON_WRITE = "scratch.clouddata.anonymouswrite";
const TARGET_CONFIG_KEY_CLOUD_HISTORY_ENABLED = "scratch.clouddata.history.enabled";
const CLOUD_CONFIG_CACHE_TTL_SECONDS = 604800;

const cloudVarsRedisKey = (projectId) => `scratch:cloud:${projectId}:vars`;
const cloudSnapshotDbKey = (projectId) => `scratch:cloud:${projectId}:vars`;
const cloudConfigRedisKey = (projectId) => `scratch:cloud:${projectId}:config`;

const requireProjectIdQuery = (req, res, next) => {
    const projectId = Number(req.query?.projectid);
    if (!Number.isInteger(projectId) || projectId <= 0) {
        return res.status(400).json({
            status: "error",
            message: "缺少有效的项目 ID",
            code: "INVALID_PROJECT_ID",
        });
    }
    return next();
};

const parseBooleanInput = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
    if (typeof value !== "string") return null;

    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) return false;
    return null;
};

const sanitizeAnonymousInputName = (name) => {
    const raw = String(name || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
    const cleaned = raw.replace(/[\[\]]/g, "");
    return cleaned.slice(0, 64) || "unknown";
};

const normalizeIp = (ipAddress) => {
    const value = String(ipAddress || "").trim();
    if (!value) return "unknown";
    if (value.startsWith("::ffff:")) return value.slice(7);
    return value;
};

const resolveActorName = ({userId, username, bodyUserName, ip}) => {
    if (typeof userId === "number" && userId > 0) {
        return username ? String(username) : String(userId);
    }
    const anonymousInputName = sanitizeAnonymousInputName(bodyUserName);
    return `[匿名]${anonymousInputName}`;
};

const parseCloudConfigCache = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const anonymousParsed = parseBooleanInput(raw.anonymousWriteEnabled);
    const historyParsed = parseBooleanInput(raw.historyEnabled);
    if (anonymousParsed === null || historyParsed === null) return null;
    return {
        anonymousWriteEnabled: anonymousParsed,
        historyEnabled: historyParsed,
    };
};

const getCachedCloudConfig = async (projectId) => {
    const cacheKey = cloudConfigRedisKey(projectId);
    if (!redisClient.client || !redisClient.isConnected) {
        return null;
    }
    try {
        const cachedValue = await redisClient.client.hgetall(cacheKey);
        return parseCloudConfigCache(cachedValue);
    } catch (error) {
        logger.warn(`[cloud-config] 读取Redis缓存失败: ${cacheKey}`, error);
        return null;
    }
};

const loadCloudConfigFromDb = async (projectId) => {
    const records = await prisma.ow_target_configs.findMany({
        where: {
            target_type: TARGET_CONFIG_TYPE_PROJECT,
            target_id: String(projectId),
            key: {in: [TARGET_CONFIG_KEY_CLOUD_ANON_WRITE, TARGET_CONFIG_KEY_CLOUD_HISTORY_ENABLED]},
        },
        select: {key: true, value: true},
    });
    const recordMap = new Map(records.map((row) => [row.key, row.value]));
    const anonymousParsed = parseBooleanInput(recordMap.get(TARGET_CONFIG_KEY_CLOUD_ANON_WRITE));
    const historyParsed = parseBooleanInput(recordMap.get(TARGET_CONFIG_KEY_CLOUD_HISTORY_ENABLED));
    return {
        anonymousWriteEnabled: anonymousParsed === null ? false : anonymousParsed,
        historyEnabled: historyParsed === null ? true : historyParsed,
    };
};

const getProjectCloudConfig = async (projectId) => {
    const cacheKey = cloudConfigRedisKey(projectId);
    const cachedConfig = await getCachedCloudConfig(projectId);
    if (cachedConfig) {
        return cachedConfig;
    }

    const config = await loadCloudConfigFromDb(projectId);
    if (redisClient.client && redisClient.isConnected) {
        try {
            await redisClient.client.hset(cacheKey, {
                anonymousWriteEnabled: config.anonymousWriteEnabled ? "true" : "false",
                historyEnabled: config.historyEnabled ? "true" : "false",
            });
            await redisClient.client.expire(cacheKey, CLOUD_CONFIG_CACHE_TTL_SECONDS);
        } catch (error) {
            logger.warn(`[cloud-config] 写入Redis缓存失败: ${cacheKey}`, error);
        }
    }
    return config;
};

const appendCloudHistory = async ({
    projectId,
    method,
    name,
    value = null,
    actorId = null,
    actorName = null,
    ip = "",
}) => {
    return prisma.project_clouddata_history.create({
        data: {
            project_id: Number(projectId),
            method: String(method || ""),
            name: String(name || ""),
            value: value === null ? null : String(value),
            actor_id: typeof actorId === "number" ? actorId : null,
            actor_name: actorName ? String(actorName) : null,
            ip: ip ? String(ip) : "",
        },
        select: {id: true},
    });
};

const parseCloudBody = (req) => {
    if (typeof req.body === "string") {
        try {
            return JSON.parse(req.body);
        } catch (error) {
            return null;
        }
    }
    return req.body;
};

const normalizeCloudValue = (value) => {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return String(value);
    }

    if (typeof value === "string") {
        if (value.length > CLOUD_MAX_VALUE_LENGTH) return null;
        return value;
    }

    return null;
};

const isValidCloudName = (name) => {
    if (typeof name !== "string") return false;
    if (!name.startsWith("☁")) return false;
    if (!name.trim()) return false;
    return name.length <= CLOUD_MAX_NAME_LENGTH;
};

const getCloudProject = async (projectId, userId) => {
    const project = await prisma.ow_projects.findFirst({
        where: {id: Number(projectId)},
        select: {
            id: true,
            authorid: true,
            state: true,
            type: true,
            title: true,
            is_shadowbanned: true,
            shadowban_expires_at: true,
            deleted_at: true,
        },
    });

    if (!project || !await canViewContent('project', project, userId)) {
        return {ok: false, status: 404, message: "项目不存在"};
    }

    if (project.type !== "scratch") {
        return {ok: false, status: 400, message: "仅支持Scratch项目"};
    }

    if (project.state !== "public" && !(await userCanActOnProject(userId, project.id, "read"))) {
        return {ok: false, status: 403, message: "无权访问此项目"};
    }

    return {ok: true, project};
};

const loadCloudState = async (project) => {
    const varsKey = cloudVarsRedisKey(project.id);
    let vars = {};

    if (redisClient.client && redisClient.isConnected) {
        vars = await redisClient.client.hgetall(varsKey);
        if (Object.keys(vars).length > 0) {
            return vars;
        }
    }

    if (!project.authorid) {
        return {};
    }

    const snapshot = await prisma.ow_cache_kv.findUnique({
        where: {
            user_id_key: {
                user_id: project.authorid,
                key: cloudSnapshotDbKey(project.id),
            },
        },
        select: {value: true},
    });

    if (!snapshot || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
        return {};
    }

    vars = snapshot.value;

    if (redisClient.client && redisClient.isConnected && Object.keys(vars).length > 0) {
        await redisClient.client.hset(varsKey, vars);
    }

    return vars;
};

const saveCloudSnapshot = async (project, vars, creatorIp) => {
    if (!project.authorid) return;

    await prisma.ow_cache_kv.upsert({
        where: {
            user_id_key: {
                user_id: project.authorid,
                key: cloudSnapshotDbKey(project.id),
            },
        },
        create: {
            user_id: project.authorid,
            key: cloudSnapshotDbKey(project.id),
            value: vars,
            creator_ip: creatorIp || "",
        },
        update: {
            value: vars,
            creator_ip: creatorIp || "",
        },
    });
};

const appendCloudEvent = async (projectId, actorId, eventData) => {
    return prisma.ow_events.create({
        data: {
            event_type: "cloud_variable",
            actor_id: actorId,
            target_type: CLOUD_EVENT_TARGET_TYPE,
            target_id: Number(projectId),
            event_data: eventData,
            public: false,
        },
        select: {
            id: true,
            created_at: true,
        },
    });
};

const formatCloudVars = (vars) =>
    Object.entries(vars).map(([name, value]) => ({
        method: "set",
        name,
        value,
    }));

const processCloudMessage = async ({
    project,
    userId,
    username,
    body,
    ip,
    allowNonAuthorWrite = false,
    historyEnabled = true,
}) => {
    const method = body?.method;
    const actorId = typeof userId === "number" ? userId : null;
    const actorName = resolveActorName({
        userId,
        username,
        bodyUserName: body?.user,
        ip,
    });

    if (!method || typeof method !== "string") {
        return {status: 400, data: {status: "error", message: "缺少method"}};
    }

    if (body.project_id && String(body.project_id) !== String(project.id)) {
        return {status: 400, data: {status: "error", message: "project_id不匹配"}};
    }

    if (body.user && body.user !== username) {
        return {status: 403, data: {status: "error", message: "用户标识不匹配"}};
    }

    if (method === "handshake") {
        const vars = await loadCloudState(project);
        return {
            status: 200,
            data: {
                status: "success",
                method: "handshake",
                project_id: String(project.id),
                user: username,
                variables: formatCloudVars(vars),
            },
        };
    }

    if (
        !allowNonAuthorWrite
        && !(await userCanActOnProject(userId, project.id, "update"))
    ) {
        return {status: 403, data: {status: "error", message: "无权修改云变量"}};
    }

    const vars = await loadCloudState(project);

    if (method === "set" || method === "create") {
        const name = body.name;
        const value = normalizeCloudValue(body.value);

        if (!isValidCloudName(name)) {
            return {status: 400, data: {status: "error", message: "变量名非法"}};
        }

        if (value === null) {
            return {status: 400, data: {status: "error", message: "变量值非法"}};
        }

        vars[name] = value;

        if (redisClient.client && redisClient.isConnected) {
            await redisClient.client.hset(cloudVarsRedisKey(project.id), name, value);
        }

        await saveCloudSnapshot(project, vars, ip);
        const event = await appendCloudEvent(project.id, userId, {
            method: "set",
            name,
            value,
            user: username,
        });
        if (historyEnabled) {
            await appendCloudHistory({
                projectId: project.id,
                method: "set",
                name,
                value,
                actorId,
                actorName,
                ip,
            });
        }

        return {
            status: 200,
            data: {
                status: "success",
                update: {
                    id: event.id,
                    method: "set",
                    name,
                    value,
                    user: username,
                    created_at: event.created_at,
                },
            },
        };
    }

    if (method === "rename") {
        const oldName = body.name;
        const newName = body.new_name;

        if (!isValidCloudName(oldName) || !isValidCloudName(newName)) {
            return {status: 400, data: {status: "error", message: "变量名非法"}};
        }

        if (!(oldName in vars)) {
            return {status: 404, data: {status: "error", message: "旧变量不存在"}};
        }

        vars[newName] = vars[oldName];
        delete vars[oldName];

        if (redisClient.client && redisClient.isConnected) {
            const redisKey = cloudVarsRedisKey(project.id);
            await redisClient.client.multi().hdel(redisKey, oldName).hset(redisKey, newName, vars[newName]).exec();
        }

        await saveCloudSnapshot(project, vars, ip);
        const event = await appendCloudEvent(project.id, userId, {
            method: "rename",
            name: oldName,
            new_name: newName,
            value: vars[newName],
            user: username,
        });
        if (historyEnabled) {
            await appendCloudHistory({
                projectId: project.id,
                method: "rename",
                name: oldName,
                value: vars[newName],
                actorId,
                actorName,
                ip,
            });
        }

        return {
            status: 200,
            data: {
                status: "success",
                update: {
                    id: event.id,
                    method: "rename",
                    name: oldName,
                    new_name: newName,
                    value: vars[newName],
                    user: username,
                    created_at: event.created_at,
                },
            },
        };
    }

    if (method === "delete") {
        const name = body.name;
        if (!isValidCloudName(name)) {
            return {status: 400, data: {status: "error", message: "变量名非法"}};
        }

        if (!(name in vars)) {
            return {status: 404, data: {status: "error", message: "变量不存在"}};
        }

        delete vars[name];

        if (redisClient.client && redisClient.isConnected) {
            await redisClient.client.hdel(cloudVarsRedisKey(project.id), name);
        }

        await saveCloudSnapshot(project, vars, ip);
        const event = await appendCloudEvent(project.id, userId, {
            method: "delete",
            name,
            user: username,
        });
        if (historyEnabled) {
            await appendCloudHistory({
                projectId: project.id,
                method: "delete",
                name,
                actorId,
                actorName,
                ip,
            });
        }

        return {
            status: 200,
            data: {
                status: "success",
                update: {
                    id: event.id,
                    method: "delete",
                    name,
                    user: username,
                    created_at: event.created_at,
                },
            },
        };
    }

    return {status: 400, data: {status: "error", message: "不支持的method"}};
};

// 配置multer用于内存存储（scratch上传）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB限制
    files: 1
  }
});

// Migrated to use the global parseToken middleware

router.get("/projectinfo", async function (req, res, next) {
    try {
        const project = await prisma.ow_projects.findFirst({
            where: {
                id: Number(req.query.id),
                state: "public",
                type: "scratch",
                AND: [await visibleWhere('project', res.locals.userid)],
            },
            select: {
                id: true,
                authorid: true,
                time: true,
                view_count: true,
                like_count: true,
                favo_count: true,
                title: true,
                state: true,
                description: true,
                license: true,
                thumbnail: true,
                default_branch: true,
                name: true,
                star_count: true,
            },
        });
        logger.debug(project)
        if (!await scratchProjectVisible(project, res)) {
            res.status(404).send({
                code: 404,
                status: "404",
                message: "项目不存在或未发布",
            });
            return;
        }

        const author = await sanitizeProfile(await prisma.ow_users.findFirst({
            where: {id: project.authorid},
            select: {
                id: true,
                display_name: true,
                avatar: true,
                bio: true,

            },
        }), res.locals.userid);

        res.locals.is_author = project.authorid == res.locals.userid;

        res.json({
            ...project,
            author_display_name: author?.display_name || '',
            author_images: author?.avatar || '',
            author_bio: author?.bio || '',
        });
    } catch (err) {
        next(err);
    }
});

router.get("/projectinfo2", async function (req, res, next) {
    try {
        var result = await prisma.ow_projects.findFirst({
            where: {
                id: Number(req.query.id),
            },
        });
        if (!await scratchProjectVisible(result, res)) {
            return res.status(404).send({ status: 'error', message: '项目不存在' });
        }
        var author = await sanitizeProfile(await prisma.ow_users.findFirst({
            where: { id: result.authorid },
            select: { id: true, display_name: true, bio: true, username: true, createdAt: true, avatar: true },
        }), res.locals.userid) || {};
        res.locals.is_author = result.authorid == res.locals.userid;
        logger.debug(result);
        var project_token = jsonwebtoken.sign(
            {
                exp: Math.floor(Date.now() / 1000) + 60 * 5,
                data: {
                    type: "project",
                    action: "read",
                    issuer: await zcconfig.get("site.domain"),
                    projectid: result.id,
                    userid: res.locals.userid,
                    authorizationContext: {
                        tokenType: res.locals.tokenType,
                        tokenScopes: res.locals.scopes || [],
                    },
                },
            },
            await zcconfig.get("security.jwttoken")
        );
        var jsonscratch = {
            id: result.id,
            title: result.title,
            description: result.description,
            instructions: "ZeroCat社区",
            visibility: "visible",
            public: result.state == "public",
            comments_allowed: true,
            is_published: result.state == "public",
            author: {
                id: result.authorid,
                username: author.display_name,
                description: author.bio,
                zcusername: author.username,
                scratchteam: author.id == 1,
                history: {
                    joined: author.createdAt,
                },
                profile: {
                    id: author.avatar,
                    images: {
                        "90x90": `${global.config["s3.staticurl"]}/assets/${(author.avatar || '').slice(0,2)}/${(author.avatar || '').slice(2,4)}/${author.avatar}`,
                        "60x60": `${global.config["s3.staticurl"]}/assets/${(author.avatar || '').slice(0,2)}/${(author.avatar || '').slice(2,4)}/${author.avatar}`,
                        "55x55": `${global.config["s3.staticurl"]}/assets/${(author.avatar || '').slice(0,2)}/${(author.avatar || '').slice(2,4)}/${author.avatar}`,
                        "50x50": `${global.config["s3.staticurl"]}/assets/${(author.avatar || '').slice(0,2)}/${(author.avatar || '').slice(2,4)}/${author.avatar}`,
                        "32x32": `${global.config["s3.staticurl"]}/assets/${author.avatar}`,
                    },
                },
            },
            image: `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
            images: {
                "282x218": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
                "216x163": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
                "200x200": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
                "144x108": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
                "135x102": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
                "100x80": `${global.config["s3.staticurl"]}/scratch_slt/${result.id}`,
            },
            history: {
                created: result.createdAt,
                modified: result.createdAt,
                shared: result.createdAt,
            },
            stats: {
                views: result.view_count,
                loves: 0,
                favorites: 0,
                remixes: 0,
            },
            remix: {
                parent: null,
                root: null,
            },
            project_token,
        };
        ////logger.logger.debug(SCRATCH[0]);
        res.json(jsonscratch);
    } catch (err) {
        logger.error(err);
        next(err);
    }
});

// 获取源代码
router.get("/project/:id", async (req, res, next) => {
    try {
        if (!req.params.id) {
            return res.status(400).send({status: "error", message: "缺少项目ID"});
        }
        let project_token;
        if (req.query.token) {
            try {
                project_token = jsonwebtoken.verify(
                    req.query.token,
                    await zcconfig.get("security.jwttoken")
                );
            } catch (err) {
                logger.debug("Error verifying project token:", err);
                return res
                    .status(200)
                    .send({
                        status: "error",
                        message: "无权访问此项目",
                        code: "AUTH_ERROR_LOGIN",
                    });
            }
            if (project_token.data.projectid != req.params.id) {
                logger.debug("1");
                return res
                    .status(200)
                    .send({
                        status: "error",
                        message: "无权访问此项目",
                        code: "AUTH_ERROR_LOGIN",
                    });
            }
            if (res.locals.userid && project_token.data.userid != res.locals.userid) {
                logger.debug("2");
                return res
                    .status(200)
                    .send({
                        status: "error",
                        message: "无权访问此项目",
                        code: "AUTH_ERROR_LOGIN",
                    });
            }
        } else {
            logger.debug("3");
            return res
                .status(200)
                .send({
                    status: "error",
                    message: "无权访问此项目",
                    code: "AUTH_ERROR_LOGIN",
                });
        }
        const project = await prisma.ow_projects.findFirst({
            where: {id: Number(project_token.data.projectid)},
        });

        const viewerId = res.locals.userid || project_token.data.userid;
        const context = project_token.data.authorizationContext;
        if (!await scratchProjectVisible(project, { locals: { ...res.locals, userid: viewerId } }, context)) {
            return res.status(404).send({status: 'error', message: '作品不存在或无权打开'});
        }

        const source =
            project.authorid === project_token.data.userid
                ? project.devsource
                : project.source;
        const projectFile = await getProjectFile(source);

        if (projectFile?.source) {
            res.status(200).send(projectFile.source);
        } else {
            res
                .status(200)
                .send({
                    status: "error",
                    message: "无权访问此项目",
                    code: "AUTH_ERROR_LOGIN",
                });
        }
    } catch (err) {
        logger.error("Error fetching project source code:", err);
        next(err);
    }
});

//保存作品：缩略图
router.post(
    "/thumbnail/:projectid",
    needLogin,
    requireResource("project", "update", "projectid"),
    upload.single("file"),
    async (req, res, next) => {
        // 项目权限验证函数
        const validateProjectAuth = async (req, res) => {
            const project = await getProjectById(Number(req.params.projectid));
            if (!project) {
                return {
                    success: false,
                    status: 404,
                    error: "作品不存在"
                };
            }
            return { success: true, project };
        };

        // 缩略图处理成功回调
        const thumbnailSuccessCallback = async (req, res, result) => {
            // 使用assets服务中的图片处理功能
            const imageResult = await processImage(req.file.buffer, {
                width: 758,
                height: 576,
                format: 'webp',
                quality: 100,
                sanitize: true
            });

            const md5Hash = generateMD5(imageResult.buffer);
            const thumbnailFilename = `${md5Hash}.webp`;
            const s3Key = `assets/${md5Hash.substring(0, 2)}/${md5Hash.substring(2, 4)}/${thumbnailFilename}`;

            await uploadToS3(imageResult.buffer, s3Key, 'image/webp');

            // 更新数据库项目的thumbnail字段
            await prisma.ow_projects.update({
                where: { id: Number(req.params.projectid) },
                data: { thumbnail: thumbnailFilename }
            });

            logger.debug("作品缩略图保存成功:" + JSON.stringify({
                projectId: req.params.projectid,
                userId: res.locals.userid,
                thumbnailHash: md5Hash,
                originalSize: req.file.buffer.length,
                processedSize: imageResult.size,
                compressionRatio: imageResult.compressionRatio,
                dimensions: `${imageResult.width}x${imageResult.height}`
            }));

            return {
                thumbnail: {
                    filename: thumbnailFilename,
                    hash: md5Hash,
                    size: imageResult.size,
                    dimensions: {
                        width: imageResult.width,
                        height: imageResult.height
                    }
                }
            };
        };

        // 使用统一的上传处理
        const uploadResult = await handleAssetUpload(req, res, {
            validateAuth: true,
            authCheck: validateProjectAuth,
            successCallback: thumbnailSuccessCallback,
            errorMessage: '缩略图处理失败'
        });

        if (!uploadResult.success) {
            return res.status(uploadResult.status).send({
                status: "error",
                message: uploadResult.error,
                ...(uploadResult.status === 404 && { code: "404" }),
                ...(uploadResult.status === 403 && { code: "AUTH_ERROR_LOGIN" })
            });
        }

        res.status(200).send({
            status: "success",
            ...uploadResult.result.thumbnail
        });
    }
);

// 保存 Scratch 项目素材：必须绑定到一个可更新的项目。
router.post(
    "/assets/:filename",
    needLogin,
    requireProjectIdQuery,
    requireResource("project", "update", "projectid"),
    upload.single("file"),
    async (req, res, next) => {
        // Scratch素材成功回调
        const scratchSuccessCallback = async (req, res, result) => {
            logger.info("Scratch素材上传成功:")
            logger.info({
                userId: res.locals.userid,
                filename: req.params.filename,
                assetId: result.asset.id,
                md5: result.asset.md5,
                originalFormat: req.file.detectedMimeType,
                isExisting: result.isExisting
            });

            return {
                asset: {
                    md5: result.asset.md5,
                    url: result.asset.url,
                    filename: req.params.filename,
                    mimeType: result.asset.mime_type,
                    size: result.asset.file_size
                }
            };
        };

        // 使用统一的上传处理
        const uploadResult = await handleAssetUpload(req, res, {
            purpose: 'scratch',
            category: 'scratch-assets',
            tags: 'scratch',
            successCallback: scratchSuccessCallback,
            errorMessage: '文件上传失败'
        });

        if (!uploadResult.success) {
            return res.status(uploadResult.status).send({
                status: "error",
                message: uploadResult.error
            });
        }

        res.status(200).send({
            status: "success",
            ...uploadResult.result.asset
        });
    }
);

router.post("/cloud/:projectid/message", needLogin, requireResource("project", "interact", "projectid"), async (req, res, next) => {
    try {
        const projectId = Number(req.params.projectid);

        if (!projectId) {
            return res.status(400).json({status: "error", message: "缺少项目ID"});
        }

        const projectResult = await getCloudProject(projectId, res.locals.userid);
        if (!projectResult.ok) {
            return res.status(projectResult.status).json({
                status: "error",
                message: projectResult.message,
            });
        }

        const body = parseCloudBody(req);
        if (!body || typeof body !== "object") {
            return res.status(400).json({status: "error", message: "消息格式错误"});
        }

        const cachedConfig = await getCachedCloudConfig(projectResult.project.id);
        const {anonymousWriteEnabled, historyEnabled} = cachedConfig || await getProjectCloudConfig(projectResult.project.id);
        const decision = await authorize({
            actorId: res.locals.userid, tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [],
            requiredScope: `project:${projectId}:${body.method === 'handshake' ? 'read' : anonymousWriteEnabled ? 'interact' : 'update'}`,
            category: 'projects', action: body.method === 'handshake' ? 'read' : 'interact',
        });
        if (!decision.allowed) return res.status(decision.status).json({status: 'error', code: decision.code, message: decision.message});
        const result = await processCloudMessage({
            project: projectResult.project,
            userId: res.locals.userid,
            username: res.locals.username,
            body,
            ip: req.ipInfo?.clientIP || req.ip,
            allowNonAuthorWrite: Boolean(anonymousWriteEnabled),
            historyEnabled,
        });

        res.status(result.status).json(result.data);
    } catch (error) {
        logger.error("处理云变量消息失败:", error);
        next(error);
    }
});

router.get("/cloud/:projectid/variables", needLogin, requireResource("project", "read", "projectid"), async (req, res, next) => {
    try {
        const projectId = Number(req.params.projectid);
        if (!projectId) {
            return res.status(400).json({status: "error", message: "缺少项目ID"});
        }

        const projectResult = await getCloudProject(projectId, res.locals.userid);
        if (!projectResult.ok) {
            return res.status(projectResult.status).json({
                status: "error",
                message: projectResult.message,
            });
        }

        const vars = await loadCloudState(projectResult.project);

        res.json({
            status: "success",
            project_id: String(projectResult.project.id),
            variables: formatCloudVars(vars),
        });
    } catch (error) {
        logger.error("读取云变量失败:", error);
        next(error);
    }
});

const handleCloudUpdatesRequest = async (req, res, next) => {
    try {
        const projectId = Number(req.params.projectid);
        if (!projectId) {
            return res.status(400).json({status: "error", message: "缺少项目ID"});
        }

        const projectResult = await getCloudProject(projectId, res.locals.userid);
        if (!projectResult.ok) {
            return res.status(projectResult.status).json({
                status: "error",
                message: projectResult.message,
            });
        }

        const cachedConfig = await getCachedCloudConfig(projectResult.project.id);
        const {historyEnabled} = cachedConfig || await getProjectCloudConfig(projectResult.project.id);
        if (!historyEnabled) {
            return res.status(403).json({status: "error", message: "云变量历史记录未启用"});
        }

        const since = Number(req.query.since || 0);
        const limitRaw = Number(req.query.limit || 50);
        const limit = Number.isFinite(limitRaw)
            ? Math.min(Math.max(limitRaw, 1), CLOUD_UPDATES_MAX_LIMIT)
            : 50;

        const updates = await prisma.ow_events.findMany({
            where: {
                target_type: CLOUD_EVENT_TARGET_TYPE,
                target_id: projectResult.project.id,
                ...(since > 0 ? {id: {gt: since}} : {}),
            },
            orderBy: {id: "asc"},
            take: limit,
            select: {
                id: true,
                actor_id: true,
                created_at: true,
                event_data: true,
            },
        });

        const actorIds = [...new Set(updates.map((row) => row.actor_id).filter((id) => typeof id === "number"))];
        const users = actorIds.length > 0
            ? await prisma.ow_users.findMany({
                where: {id: {in: actorIds}, AND: [await visibleWhere('profile', res.locals.userid)]},
                select: {
                    id: true,
                    username: true,
                    display_name: true,
                    avatar: true,
                },
            })
            : [];
        const userMap = new Map(users.map(user => [user.id, user]));

        const mappedUpdates = updates.map((row) => {
            const data = typeof row.event_data === 'object' && row.event_data !== null ? { ...row.event_data } : {};
            if (row.actor_id && !userMap.get(row.actor_id)) data.user = null;
            return {
                ...data,
                id: row.id,
                actor_id: row.actor_id,
                actor: row.actor_id ? userMap.get(row.actor_id) || null : null,
                created_at: row.created_at,
            };
        });

        res.json({
            status: "success",
            project_id: String(projectResult.project.id),
            updates: mappedUpdates,
            next_since: mappedUpdates.length > 0 ? mappedUpdates[mappedUpdates.length - 1].id : since,
        });
    } catch (error) {
        logger.error("读取云变量更新失败:", error);
        next(error);
    }
};

router.get("/cloud/:projectid/updates", needLogin, requireResource("project", "read", "projectid"), handleCloudUpdatesRequest);

router.get("/cloud/:projectid/history", needLogin, requireResource("project", "read", "projectid"), async (req, res, next) => {
    try {
        const projectId = Number(req.params.projectid);
        if (!projectId) {
            return res.status(400).json({status: "error", message: "缺少项目ID"});
        }

        const projectResult = await getCloudProject(projectId, res.locals.userid);
        if (!projectResult.ok) {
            return res.status(projectResult.status).json({
                status: "error",
                message: projectResult.message,
            });
        }

        const cachedConfig = await getCachedCloudConfig(projectResult.project.id);
        const {historyEnabled} = cachedConfig || await getProjectCloudConfig(projectResult.project.id);
        if (!historyEnabled) {
            return res.status(403).json({status: "error", message: "云变量历史记录未启用"});
        }

        const since = Number(req.query.since || 0);
        const limitRaw = Number(req.query.limit || 50);
        const limit = Number.isFinite(limitRaw)
            ? Math.min(Math.max(limitRaw, 1), CLOUD_UPDATES_MAX_LIMIT)
            : 50;

        const rows = await prisma.project_clouddata_history.findMany({
            where: {
                project_id: projectResult.project.id,
                ...(since > 0 ? {id: {lt: since}} : {}),
            },
            orderBy: {id: "desc"},
            take: limit,
            select: {
                id: true,
                method: true,
                name: true,
                value: true,
                actor_id: true,
                actor_name: true,
                ip: true,
                created_at: true,
            },
        });

        const actorIds = [...new Set(rows.map((row) => row.actor_id).filter((id) => typeof id === "number"))];
        const users = actorIds.length > 0
            ? await prisma.ow_users.findMany({
                where: {id: {in: actorIds}, AND: [await visibleWhere('profile', res.locals.userid)]},
                select: {
                    id: true,
                    username: true,
                    display_name: true,
                    avatar: true,
                },
            })
            : [];
        const userMap = new Map(users.map(user => [user.id, user]));

        const history = rows.map((row) => ({
            id: row.id,
            method: row.method,
            name: row.name,
            value: row.value,
            actor_id: row.actor_id,
            actor: row.actor_id ? userMap.get(row.actor_id) || null : null,
            actor_name: row.actor_id && !userMap.get(row.actor_id) ? null : row.actor_name,
            ip: row.actor_id ? null : row.ip,
            created_at: row.created_at,
        }));

        res.json({
            status: "success",
            project_id: String(projectResult.project.id),
            history,
            next_since: history.length > 0 ? history[history.length - 1].id : since,
        });
    } catch (error) {
        logger.error("读取云变量历史失败:", error);
        next(error);
    }
});

export default router;
