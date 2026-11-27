import logger from "../services/logger.js";
import fs, {createReadStream} from "fs";

//个人中心
import {Router} from "express";
import {createHash} from "crypto";
//功能函数集
import {prisma} from "../services/prisma.js";
import {checkhash, hash, S3update, validateUsername} from "../services/global.js";
//数据库
import multer from "multer";
import {createEvent} from "../controllers/events.js";
import { validateFileTypeFromContent, uploadFile } from "../services/assets.js";
import {needLogin} from "../middleware/auth.js";
import {requireScope} from "../middleware/scope.js";
import {assertCanWrite} from "../services/moderation/visibility.js";

var router = Router();

// 配置multer用于内存存储
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB限制
    files: 1
  }
});

// Migrated to use the global parseToken middleware

router.post("/set/avatar", upload.single("zcfile"), async (req, res) => {
    if (!req.file) {
        return res
            .status(400)
            .send({status: "error", message: "No file uploaded"});
    }

    try {
        // 验证文件类型
        const fileTypeValidation = await validateFileTypeFromContent(req.file.buffer, req.file.mimetype);

        if (!fileTypeValidation.isValid) {
            logger.warn("头像文件类型验证失败:", {
                originalname: req.file.originalname,
                frontendMimeType: req.file.mimetype,
                detectedMimeType: fileTypeValidation.mimeType,
                error: fileTypeValidation.error
            });
            return res.status(400).send({
                status: "error",
                message: fileTypeValidation.error || "不支持的文件类型"
            });
        }

        // 确保是图片文件
        if (!fileTypeValidation.mimeType.startsWith('image/')) {
            return res.status(400).send({
                status: "error",
                message: "头像必须是图片文件"
            });
        }

        // 使用检测到的文件类型信息更新文件对象
        req.file.detectedMimeType = fileTypeValidation.mimeType;
        req.file.detectedExtension = fileTypeValidation.extension;

        // 使用统一的文件上传函数，purpose 设为 'avatar'
        const result = await uploadFile(
            req.file,
            {
                purpose: 'avatar',
                category: 'avatars',
                tags: 'avatar'
            },
            res,
            req.ip,
            req.headers['user-agent']
        );

        if (!result.success) {
            return res.status(500).send({
                status: "error",
                message: "头像上传失败"
            });
        }

        // 更新用户头像字段（使用asset的MD5作为标识）
        await prisma.ow_users.update({
            where: {id: res.locals.userid},
            data: {avatar: result.asset.md5},
        });

        logger.info("头像上传成功:", {
            userId: res.locals.userid,
            assetId: result.asset.id,
            md5: result.asset.md5,
            processing: result.processing
        });

        res.status(200).send({
            status: "success",
            message: "头像上传成功",
            avatar: {
                md5: result.asset.md5,
                url: result.asset.url,
                processing: result.processing
            }
        });

    } catch (err) {
        logger.error("Avatar upload error:", err);
        res.status(500).send({status: "error", message: "头像上传失败"});
    }
});

router.use((err, req, res, next) => {
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
        logger.error("Unexpected end of form: ", err);
        res.status(400).send({status: "error", message: "数据传输异常"});
    } else {
        next(err);
    }
});

async function requireProfileWrite(req, res, next) {
    try {
        await assertCanWrite(res.locals.userid, "profile", "update");
        next();
    } catch (error) {
        next(error);
    }
}

//修改个人信息
router.post("/set/userinfo", needLogin, requireScope("user:update"), requireProfileWrite, async (req, res) => {
    try {
        const updateData = {
            display_name: req.body.display_name,
            bio: req.body.bio,
            location: req.body.location,
            region: req.body.region,
            sex: req.body.sex,
            url: req.body.url,
            birthday: req.body.birthday ? new Date(req.body.birthday) : undefined,
        };

        // 处理custom_status (表情和状态文本)
        if (req.body.custom_status) {
            try {
                updateData.custom_status = JSON.parse(req.body.custom_status);
            } catch (e) {
                return res.status(400).send({
                    status: "error",
                    message: "custom_status 必须是有效的 JSON 格式"
                });
            }
        }

        // 处理featured_projects (精选项目ID)
        if (req.body.featured_projects) {
            const featuredProjectId = parseInt(req.body.featured_projects);
            if (isNaN(featuredProjectId)) {
                return res.status(400).send({
                    status: "error",
                    message: "featured_projects 必须是有效的数字"
                });
            }

            // 验证项目是否存在且属于当前用户
            const project = await prisma.ow_projects.findFirst({
                where: {
                    id: featuredProjectId,
                    authorid: res.locals.userid
                }
            });

            if (!project) {
                return res.status(400).send({
                    status: "error",
                    message: "指定的项目不存在或不属于当前用户"
                });
            }

            updateData.featured_projects = featuredProjectId;
        }

        // 移除所有undefined的字段
        Object.keys(updateData).forEach(key =>
            updateData[key] === undefined && delete updateData[key]
        );

        await prisma.ow_users.update({
            where: {id: res.locals.userid},
            data: updateData
        });

        // 添加个人资料更新事件
        await createEvent(
            "user_profile_update",
            res.locals.userid,
            "user",
            res.locals.userid,
            {
                event_type: "user_profile_update",
                actor_id: res.locals.userid,
                target_type: "user",
                target_id: res.locals.userid,
                update_type: "profile_update",
                updated_fields: Object.keys(updateData),
                old_value: null,
                new_value: JSON.stringify(updateData)
            }
        );

        res.status(200).send({status: "success", message: "个人信息修改成功"});
    } catch (error) {
        logger.error("Error updating user info:", error);
        res.status(500).send({status: "error", message: "修改个人信息失败"});
    }
});

//修改用户名
import { requireSudo } from "../middleware/sudo.js"; // 确保已导入

router.post("/set/username", requireSudo, async (req, res) => {
    const username = req.body.username;
    const validation = validateUsername(username);
    if (!validation.valid) {
        return res.status(400).json({
            status: "error",
            message: validation.message,
        });
    }

    // 检查用户名是否已被使用
    const existing = await prisma.ow_users.findFirst({
        where: { username, id: { not: res.locals.userid } },
    });
    if (existing) {
        return res.status(409).json({
            status: "error",
            message: "用户名已被使用",
        });
    }

    await prisma.ow_users.update({
        where: {id: res.locals.userid},
        data: {
            username,
        },
    });
    res.locals.username = username;

    res.status(200).send({status: "success", message: "用户名修改成功"});
});

//修改密码：动作
router.post("/set/pw", requireSudo, async (req, res) => {
    const USER = await prisma.ow_users.findUnique({
        where: {id: res.locals.userid},
    });
    if (!USER) {
        return res.status(200).send({status: "错误", message: "用户不存在"});
    }
    if (checkhash(req.body["oldpw"], USER.password) == false) {
        return res.status(200).send({status: "错误", message: "旧密码错误"});
    }
    const newPW = hash(req.body["newpw"]);
    await prisma.ow_users.update({
        where: {id: res.locals.userid},
        data: {password: newPW},
    });
    res.status(200).send({status: "success", message: "密码修改成功"});
});

export default router;
