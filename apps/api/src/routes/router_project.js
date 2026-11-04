import logger from "../services/logger.js";
import zcconfig from "../services/config/zcconfig.js";
import { Router } from "express";
import { prisma } from "../services/prisma.js";
import default_project from "../default_project.js";
import {
  authorSelectionFields,
  extractProjectData,
  handleTagsChange,
  projectSelectionFields,
  sanitizeProjectAuthors,
} from "../controllers/projects.js";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { createTypedJWT } from "../services/auth/tokenUtils.js";
import {
  verifyFileAccessToken,
} from "../services/auth/tokenManager.js";
import {
  getContextRecommendedProjects,
  getRecommendedProjectsForUser,
  getSimilarProjectsByProject,
} from "../controllers/projectRecommendations.js";
import { needLogin } from "../middleware/auth.js";
import { requireScope, requireResource } from "../middleware/scope.js";
import { hasProjectPermission } from "../services/auth/permissionManager.js";
import { createEvent } from "../controllers/events.js";
import { getAnalytics } from "../services/analytics.js";
import redisClient from "../services/redis.js";
import queueManager from "../services/queue/queueManager.js";
import gorseService from "../services/gorse.js";
import {
  createBranchIfNotExists,
  getCommitParentId,
  updateBranchLatestCommit,
} from "../services/commitService.js";

import { visibleWhere, sanitizeProfile, sanitizeProfiles } from "../services/moderation/visibility.js";
import { readProjectFile, saveProjectFile } from "../services/projectFileStorage.js";
import { findReachableProjectCommit, listReachableCommitIds } from "../services/projectCommitAccess.js";
import { assertCanWrite } from "../services/moderation/restrictions.js";
import { softDeleteContent, restoreContent } from "../services/moderation/lifecycle.js";

const router = Router();

router.use((req, res, next) => {
  if (req.headers["x-zerocat-delegation"] !== undefined && req.method === "GET"
      && !/^\/id\/[^/]+\/?$/.test(req.path)) {
    return res.status(403).json({ status: "error", code: "ZC_ERROR_DELEGATION_NOT_SUPPORTED", message: "此操作不支持授权委托" });
  }
  next();
});

async function visibleProjectWhere(where, userId = null) {
  return { AND: [where, await visibleWhere("project", userId)] };
}

function projectNotFound() {
  return Object.assign(new Error("项目不存在"), { status: 404, code: "ZC_ERROR_CONTENT_NOT_FOUND" });
}

async function ensureProjectVisible(projectId, viewerId, options = {}) {
  const project = await prisma.ow_projects.findFirst({
    where: { AND: [{ id: Number(projectId) }, await visibleWhere("project", viewerId, options)] },
    select: { id: true, type: true },
  });
  if (!project) throw projectNotFound();
  return project;
}

const projectWriteGuard = (action, selector) => async (req, res, next) => {
  try {
    const id = selector ? selector(req) : null;
    const authorization = res.locals.authorization;
    const delegated = authorization?.allowed && authorization.principalId !== authorization.actorId;
    const project = id ? await ensureProjectVisible(id, res.locals.userid, { ignorePrivacy: authorization?.allowed === true }) : null;
    const type = project?.type || req.body?.type;
    for (const userId of new Set([res.locals.userid, ...(delegated ? [authorization.principalId] : [])])) {
      await assertCanWrite(userId, "project", action);
      if (type === "article") await assertCanWrite(userId, "blog", action);
    }
    next();
  } catch (error) {
    res.status(error.status || 403).json({ status: "error", message: error.message, code: error.code });
  }
};

const projectIdFromRequest = (req) => req.body?.projectid || req.query?.projectid || req.headers["x-project-id"] || req.params.id;

const issueProjectFileAccessToken = (sha256, userid, projectId, staged = false) => createTypedJWT("file", {
  action: "read", sha256, userid, project_id: Number(projectId), staged,
}, 300);

const findReachableCommit = (projectId, options = {}) => findReachableProjectCommit(projectId, options);

const resolveProjectInitType = (projectType) => {
  if (projectType && default_project[projectType]) return projectType;
  if (default_project.text) return "text";
  return projectType;
};

const initializeEmptyProject = async (tx, { projectId, userId, projectType }) => {
  const initType = resolveProjectInitType(projectType);
  const defaultSource = default_project[initType];
  if (!defaultSource) {
    throw new Error(`Default project template not found for type: ${initType}`);
  }

  const timestamp = new Date();
  const commitContent = JSON.stringify({
    userid: userId,
    project_id: Number(projectId),
    project_branch: "main",
    source_sha256: defaultSource,
    commit_message: "初始化提交",
    parent_commit: null,
    timestamp,
  });
  const commitId = createHash("sha256").update(commitContent).digest("hex");

  await tx.ow_projects_branch.create({
    data: {
      projectid: Number(projectId),
      latest_commit_hash: commitId,
      name: "main",
      creator: userId,
      description: "默认分支",
    },
  });

  const commit = await tx.ow_projects_commits.create({
    data: {
      id: commitId,
      project_id: Number(projectId),
      author_id: userId,
      branch: "main",
      commit_file: defaultSource,
      commit_message: "初始化提交",
      parent_commit_id: null,
      commit_date: new Date(timestamp),
      commit_description: "# 初始化提交",
    },
  });

  return commit;
};

const PROJECT_CONFIG_TARGET_TYPE = "project";
const PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE = "scratch.clouddata.anonymouswrite";
const PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED = "scratch.clouddata.history.enabled";
const CLOUD_CONFIG_CACHE_TTL_SECONDS = 604800;

const cloudConfigRedisKey = (projectId) => `scratch:cloud:${projectId}:config`;

const parseBooleanInput = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) return false;
  return null;
};

const parseBooleanConfigValue = (value, fallback = false) => {
  const parsed = parseBooleanInput(value);
  return parsed === null ? fallback : parsed;
};

const getProjectCloudAnonymousWriteConfig = async (projectId) => {
  const record = await prisma.ow_target_configs.findUnique({
    where: {
      target_type_target_id_key: {
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key: PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE,
      },
    },
    select: {
      value: true,
      updated_at: true,
    },
  });

  const enabled = parseBooleanConfigValue(record?.value, false);
  return {
    enabled,
    raw_value: record?.value ?? String(enabled),
    updated_at: record?.updated_at ?? null,
  };
};

const setProjectCloudConfig = async (projectId, key, enabled) =>
  prisma.ow_target_configs.upsert({
    where: {
      target_type_target_id_key: {
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key,
      },
    },
    create: {
      target_type: PROJECT_CONFIG_TARGET_TYPE,
      target_id: String(projectId),
      key,
      value: enabled ? "true" : "false",
    },
    update: {
      value: enabled ? "true" : "false",
    },
    select: {
      value: true,
      updated_at: true,
    },
  });

const setProjectCloudAnonymousWriteConfig = (projectId, enabled) =>
  setProjectCloudConfig(projectId, PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE, enabled);

const setProjectCloudHistoryEnabledConfig = (projectId, enabled) =>
  setProjectCloudConfig(projectId, PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED, enabled);

const loadCloudConfigFromDb = async (projectId) => {
  const records = await prisma.ow_target_configs.findMany({
    where: {
      target_type: PROJECT_CONFIG_TARGET_TYPE,
      target_id: String(projectId),
      key: { in: [PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE, PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED] },
    },
    select: { key: true, value: true },
  });
  const recordMap = new Map(records.map((row) => [row.key, row.value]));
  const anonymousParsed = parseBooleanInput(recordMap.get(PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE));
  const historyParsed = parseBooleanInput(recordMap.get(PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED));
  return {
    anonymousWriteEnabled: anonymousParsed === null ? false : anonymousParsed,
    historyEnabled: historyParsed === null ? true : historyParsed,
  };
};

const refreshCloudConfigCache = async (projectId, config) => {
  if (!redisClient.client || !redisClient.isConnected) return;
  const cacheKey = cloudConfigRedisKey(projectId);
  try {
    await redisClient.client.hset(cacheKey, {
      anonymousWriteEnabled: config.anonymousWriteEnabled ? "true" : "false",
      historyEnabled: config.historyEnabled ? "true" : "false",
    });
    await redisClient.client.expire(cacheKey, CLOUD_CONFIG_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn(`[cloud-config] 刷新Redis缓存失败: ${cacheKey}`, error);
  }
};

// 中间件，确保所有请求均经过该处理

// 抽离的函数
async function checkProjectPermission(projectid, userid, permission) {
  await ensureProjectVisible(projectid, userid);
  if (permission === "write") await assertCanWrite(userid, "project", "update");
  const hasPermission = await hasProjectPermission(
    projectid,
    userid,
    permission
  );
  if (!hasPermission) {
    throw projectNotFound();
  }
}


// 获取项目分析数据
router.get("/analytics/:id", needLogin, requireResource("project", "read", "id"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    // 验证日期格式
    if (
      !start_date ||
      !end_date ||
      !Date.parse(start_date) ||
      !Date.parse(end_date)
    ) {
      return res.status(400).send({
        status: "error",
        message: "无效的日期格式",
      });
    }

    // 验证项目权限
    await ensureProjectVisible(id, res.locals.userid);
    const hasPermission = await hasProjectPermission(
      id,
      res.locals.userid,
      "read"
    );
    if (!hasPermission) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
      });
    }

    const analytics = await getAnalytics(
      "project",
      Number(id),
      start_date,
      end_date
    );

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: analytics,
    });
  } catch (err) {
    logger.error("Error fetching project analytics:", err);
    next(err);
  }
});
// 根据类型查询项目
router.get("/query", async (req, res, next) => {
  try {
    const { type, target, limit = 20, offset = 0 } = req.query;
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    const visibility = await visibleWhere("project", userId);

    if (!type || !target) {
      return res.status(400).send({
        status: "error",
        message: "缺少必要的参数",
      });
    }

    let projects;
    let totalCount;

    // Fork 类型查询
    if (type === "fork") {
      [projects, totalCount] = await Promise.all([
        prisma.ow_projects.findMany({
          where: {
            fork: Number(target),
            AND: [visibility],
          },
          select: projectSelectionFields(),
          take: Number(limit),
          skip: Number(offset),
          orderBy: { time: "desc" },
        }),
        prisma.ow_projects.count({
          where: {
            fork: Number(target),
            AND: [visibility],
          },
        }),
      ]);
    }
    // Tag 类型查询
    else if (type === "tag") {
      [projects, totalCount] = await Promise.all([
        prisma.ow_projects.findMany({
          where: {
            state: "public",
            project_tags: {
              some: {
                name: target,
              },
            },
            AND: [visibility],
          },
          select: projectSelectionFields(),
          take: Number(limit),
          skip: Number(offset),
          orderBy: { time: "desc" },
        }),
        prisma.ow_projects.count({
          where: {
            state: "public",
            project_tags: {
              some: {
                name: target,
              },
            },
            AND: [visibility],
          },
        }),
      ]);
    }
    // 作者类型查询
    else if (type === "author") {
      [projects, totalCount] = await Promise.all([
        prisma.ow_projects.findMany({
          where: {
            authorid: Number(target),
            AND: [visibility],
          },
          select: projectSelectionFields(),
          take: Number(limit),
          skip: Number(offset),
          orderBy: { time: "desc" },
        }),
        prisma.ow_projects.count({
          where: {
            authorid: Number(target),
            AND: [visibility],
          },
        }),
      ]);
    }

    // 不支持的查询类型
    else {
      return res.status(400).send({
        status: "error",
        message: "不支持的查询类型",
      });
    }

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: {
        projects: await sanitizeProjectAuthors(projects, userId),
        total: totalCount,
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (err) {
    logger.error("Error querying projects:", err);
    next(err);
  }
});

// 创建新作品
router.post("/", needLogin, requireScope("project:create"), projectWriteGuard("create"), async (req, res, next) => {
  try {
    const existingProject = await prisma.ow_projects.findFirst({
      where: {
        authorid: res.locals.userid,
        name: req.body.name,
      },
    });

    if (existingProject) {
      return res.status(200).send({
        status: "error",
        message: "作品名称被占用",
      });
    }

    const projectType = req.body.type || "scratch";
    const outputJson = {
      type: projectType,
      authorid: res.locals.userid,
      title: req.body.title || "新建作品",
      name: req.body.name,
      state: req.body.state || "public",
      description: req.body.description || "",
      license: req.body.license || "None",
      thumbnail: req.body.thumbnail || "",
    };

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.ow_projects.create({ data: { ...outputJson, default_branch: "main" } });
      await initializeEmptyProject(tx, {
        projectId: created.id,
        userId: res.locals.userid,
        projectType,
      });
      return created;
    });

    // 根据项目状态决定事件是否公开
    const isPrivate = outputJson.state === "private";

    await createEvent(
      "project_create",
      res.locals.userid,
      "project",
      result.id,
      {
        event_type: "project_create",
        actor_id: res.locals.userid,
        target_type: "project",
        target_id: Number(result.id),
        project_name: result.name,
        project_type: result.type,
        project_title: result.title,
        project_description: result.description,
        project_state: result.state,
        notification_title: `${res.locals.username || "有人"} 创建了新项目`,
        notification_content: `${res.locals.username || "有人"} 创建了项目《${result.title || result.name}》`,
      },
      isPrivate // 传入是否强制私密
    );

    queueManager.enqueueProjectGorseSync(Number(result.id), {
      reason: "project_create",
      delayMs: 30000,
    }).catch((error) => {
      logger.debug(`[gorse] create project sync enqueue failed project=${result.id}: ${error.message}`);
    });

    res.status(200).send({
      status: "success",
      message: "保存成功",
      id: result.id,
    });
  } catch (err) {
    logger.error("Error creating new project:", err);
    res.status(500).send({
      status: "error",
      message: "创建新作品时出错",
    });
  }
});

// 保存源代码
router.post("/savefile", needLogin, requireResource("project", "update", (req) =>
  req.body?.projectid || req.query?.projectid || req.headers["x-project-id"],
  { allowDelegation: true }
), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    let source;
    const shouldFormatJson = req.query.json === "true";
    const sourcePath = req.query.source || "index";

    // 处理 form-data 类型的文件上传
    if (req.is("multipart/form-data")) {
      if (!req.files || !req.files.source) {
        return res.status(400).send({
          status: "error",
          message: "未找到上传的文件",
        });
      }
      source = req.files.source.data.toString();
    }
    else if(req.is("application/x-www-form-urlencoded")){
      source = req.body.source;
    }
    else if(req.is("text/plain")){
      source = req.body;
    }
    // 处理 JSON 类型的请求
    else if (req.is("application/json")) {
      // 如果指定了 json=true，则处理压缩/格式化的 JSON
      if (shouldFormatJson) {
        try {
          const jsonData = req.body;
          if (typeof jsonData !== "object") {
            throw new Error("Invalid JSON data");
          }
          source = JSON.stringify(jsonData); // 格式化的 JSON
        } catch (err) {
          logger.error("Error processing JSON source:", err);
          return res.status(400).send({
            status: "error",
            message: "无效的 JSON 格式",
          });
        }
      }
      // 否则从指定路径读取源代码
      else {
        try {
          const data = req.body;
          // 根据 sourcePath 解析 JSON 路径
          const pathParts = sourcePath.split(".");
          let currentData = data;
          for (const part of pathParts) {
            if (currentData === undefined || currentData === null) {
              throw new Error(`Invalid path: ${sourcePath}`);
            }
            currentData = currentData[part];
          }
          if (typeof currentData !== "string") {
            throw new Error("Source code must be a string");
          }
          source = currentData;
        } catch (err) {
          logger.error("Error extracting source from JSON:", err);
          return res.status(400).send({
            status: "error",
            message: "无法从指定路径获取源代码",
          });
        }
      }
    } else {
      return res.status(400).send({
        status: "error",
        message: "不支持的内容类型",
      });
    }

    // 确保 source 是字符串类型
    if (typeof source !== "string") {
      source = String(source);
    }

    const sha256 = createHash("sha256").update(source).digest("hex");
    logger.debug(sha256);

    await saveProjectFile(source, { sha256, userId: res.locals.userid });

    const accessFileToken = await issueProjectFileAccessToken(
      sha256,
      res.locals.userid,
      projectIdFromRequest(req),
      true
    );
    res.status(200).send({
      status: "success",
      message: "保存成功",
      sha256,
      accessFileToken,
    });
  } catch (err) {
    logger.error("Error saving source code:", err);
    res.status(500).send({
      status: "error",
      message: "保存源代码时出错",
    });
  }
});

// 获取项目文件 放最后最后匹配免得冲突
router.get("/commit", async (req, res, next) => {
  try {
    const { projectid, commitid } = req.query;
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    await ensureProjectVisible(projectid, userId);
    const hasPermission = await hasProjectPermission(projectid, userId, "read");

    if (!hasPermission) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
        code: "404",
      });
    }

    let commit;

    commit = await findReachableCommit(projectid, { commitId: String(commitid) });

    if (!commit) {
      return res.status(200).send({
        status: "error",
        message: "获取失败",
        commit: {
          error_code: "no_commit",
          commit_message: "No commit found",
        },
      });
    }

    const accessFileToken = await issueProjectFileAccessToken(
      commit.commit_file,
      userId,
      req.query.projectid || req.params.id
    );

    res.status(200).send({
      status: "success",
      message: "获取成功",
      commit,
      accessFileToken,
    });
  } catch (err) {
    logger.error("Error fetching project file:", err);
    next(err);
  }
});
// 提交代码
router.put("/commit/id/:id", needLogin, requireResource("project", "update", (req) =>
  req.body?.projectid || req.query?.projectid || req.headers["x-project-id"],
  { allowDelegation: true }
), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    const {
      branch = "main",
      projectid,
      accessFileToken,
      message = "edit",
      parent_commit,
      commit_description,
    } = req.body;
    logger.debug(req.body);
    if (!projectid || !accessFileToken) {
      return res.status(400).send({
        status: "error",
        message: "缺少必要的参数",
      });
    }

    // 验证项目权限
    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(projectid) },
    });
    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
      });
    }

    // 提交权限已由 requireResource("project","update",...) 中间件校验（作者或编辑者及以上协作者）。

    // 检查项目是否已初始化（至少存在一次提交）
    const commitCount = await prisma.ow_projects_branch.count({
      where: { projectid: Number(projectid), latest_commit_hash: { not: null } },
    });
    if (commitCount === 0) {
      return res.status(400).send({
        status: "error",
        message: "项目尚未初始化，请先初始化项目",
        code: "PROJECT_NOT_INITIALIZED",
      });
    }

    const decodedFileToken = jwt.verify(
      accessFileToken,
      await zcconfig.get("security.jwttoken")
    );
    logger.debug(decodedFileToken);
    if (!decodedFileToken) {
      return res.status(200).send({
        status: "error",
        message: "无效的文件访问令牌 #2",
      });
    }

    const { sha256, type, action, userid } = decodedFileToken.data;
    if (
      decodedFileToken.type !== "file" ||
      action !== "read" ||
      Number(decodedFileToken.data.project_id) !== Number(projectid) ||
      Number(userid) !== Number(res.locals.userid)
    ) {
      return res.status(200).send({
        status: "error",
        message: "无效的文件访问令牌 #1",
      });
    }

    // 检查分支是否存在，不存在则创建
    await createBranchIfNotExists(projectid, branch, res.locals.userid);

    let parent_commit_id = await getCommitParentId(
      projectid,
      res.locals.userid,
      parent_commit,
      branch // 传入分支信息
    );
    if (!parent_commit_id) {
      const sourceBranch = await prisma.ow_projects_branch.findFirst({
        where: { projectid: Number(projectid), name: branch },
        select: { latest_commit_hash: true },
      });
      if (parent_commit && !(await findReachableCommit(projectid, { commitId: String(parent_commit) }))) {
        throw projectNotFound();
      }
      parent_commit_id = parent_commit || sourceBranch?.latest_commit_hash || null;
    }
    const timestamp = Date.now();
    // 计算提交的哈希值作为 id
    const commitContent = JSON.stringify({
      userid: res.locals.userid,
      project_id: Number(projectid),
      source_sha256: sha256,
      commit_message: message,
      parent_commit: parent_commit_id,
      commit_description: commit_description,
      timestamp,
    });
    const commitId = createHash("sha256").update(commitContent).digest("hex");

    const result = await prisma.ow_projects_commits.create({
      data: {
        id: commitId,
        project_id: Number(projectid),
        author_id: res.locals.userid,
        branch,
        commit_file: sha256,
        commit_message: message,
        commit_description: commit_description,
        parent_commit_id,
        commit_date: new Date(timestamp),
      },
    });

    await updateBranchLatestCommit(projectid, branch, commitId);

    // 根据项目状态决定事件是否公开
    const isPrivate = project.state === "private";

    // 创建提交事件，添加更多项目信息
    await createEvent(
      "project_commit",
      res.locals.userid,
      "project",
      Number(projectid),
      {
        event_type: "project_commit",
        actor_id: res.locals.userid,
        target_type: "project",
        target_id: Number(projectid),
        commit_id: commitId,
        commit_message: message,
        branch: branch,
        default_branch: project.default_branch || 'main',
        commit_file: sha256,
        // 添加项目相关信息
        project_name: project.name,
        project_title: project.title,
        project_type: project.type,
        project_description: project.description,
        project_state: project.state,
        notification_title: `${res.locals.username || "有人"} 推送了 ${branch} 分支代码`,
        notification_content: `项目《${project.title || project.name}》的 ${branch} 分支有新提交：${message || commitId.slice(0, 8)}`,
      },
      isPrivate // 传入是否强制私密
    );

    try {
      await queueManager.enqueueGitSyncCommit(projectid, commitId, {
        triggeredBy: 'project-commit',
        actorId: res.locals.userid,
        authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] },
      });
    } catch (error) {
      logger.warn(`[git-sync] enqueue failed project=${projectid} commit=${commitId}: ${error.message}`);
    }

    if (String(project.type || '').toLowerCase() === 'article') {
      try {
        await queueManager.enqueueBlogSyncArticle(projectid, project.authorid, {
          reason: 'project-commit',
          commitId,
          actorId: res.locals.userid,
          authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] },
        });
      } catch (error) {
        logger.warn(`[blog-sync] enqueue failed project=${projectid}: ${error.message}`);
      }
    }

    res.status(200).send({
      status: "success",
      message: "保存成功",
      data: result,
    });
  } catch (err) {
    logger.error("Error saving source code:", err);
    res.status(500).send({
      status: "error",
      message: "提交代码时出错",
    });
  }
});

// 批量获取项目信息
router.post("/batch", async (req, res, next) => {
  try {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds)) {
      return res.status(400).send({
        status: "error",
        message: "无效的项目ID数组",
      });
    }

    const userId = res.locals.userid || 0; // 未登录用户为匿名用户

    // 获取所有项目
    const projects = await prisma.ow_projects.findMany({
      where: await visibleProjectWhere({ id: { in: projectIds.map(Number) } }, userId),
      select: projectSelectionFields(),
    });

    // 并行化权限检查
    const projectsWithPermission = await Promise.all(
      projects.map(async (project) => {
        const hasPermission = await hasProjectPermission(
          project.id,
          userId,
          "read"
        );
        return hasPermission ? project : null;
      })
    );

    // 过滤掉没有权限的项目
    const filteredProjects = projectsWithPermission.filter(
      (project) => project !== null
    );

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: await sanitizeProjectAuthors(filteredProjects, userId),
    });
  } catch (err) {
    logger.error("Error fetching batch project information:", err);
    res.status(500).send({
      status: "error",
      message: "批量获取项目信息时出错",
    });
  }
});

router.get("/branches", async (req, res, next) => {
  try {
    const { projectid } = req.query;
    await checkProjectPermission(projectid, res.locals.userid, "read");

    const result = await prisma.ow_projects_branch.findMany({
      where: { projectid: Number(projectid) },
      select: {
        id: true,
        name: true,
        description: true,
        latest_commit_hash: true,
      },
    });
    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: result,
    });
  } catch (err) {
    logger.error("Error getting project information:", err);
    next(err);
  }
});
router.get("/commits", async (req, res, next) => {
  try {
    const { projectid, branch } = req.query;
    await checkProjectPermission(projectid, res.locals.userid, "read");

    // 1. 获取分支信息
    const branchQuery = branch
      ? { where: { projectid: Number(projectid), name: branch } }
      : { where: { projectid: Number(projectid) } };

    const branches = await prisma.ow_projects_branch.findMany({
      ...branchQuery,
      select: {
        name: true,
        latest_commit_hash: true,
      },
    });

    if (branch && branches.length === 0) {
      return res.status(404).send({
        status: "error",
        message: "分支不存在",
      });
    }

    const latestCommits = branches
      .filter((b) => b.latest_commit_hash)
      .map((b) => b.latest_commit_hash);

    // 3. 首先尝试使用 depth 获取提交历史
    const maxDepth = await prisma.ow_projects_commits.findFirst({
      where: {
        id: { in: latestCommits },
        depth: { not: null },
      },
      orderBy: {
        depth: 'desc',
      },
      select: {
        depth: true,
      },
    });

    if (maxDepth?.depth != null) {
      // 如果存在 depth，使用 depth 范围查询
      const depthResults = await prisma.ow_projects_commits.findMany({
        where: {
          project_id: Number(projectid),
          depth: {
            lte: maxDepth.depth,
            gte: 0,
          },
        },
        orderBy: {
          commit_date: 'desc',
        },
      });

      // 验证结果的完整性
      const hasAllCommits = latestCommits.every(hash =>
        depthResults.some(commit => commit.id === hash)
      );

      if (hasAllCommits) {
        return res.status(200).send({
          status: "success",
          message: "获取成功 使用depth",
          data: depthResults,
        });
      }
    }

    // Traverse the complete ancestry in one query, including retained fork history.
    const commits = await listReachableCommitIds(latestCommits);

    // 5. 获取所有提交的详细信息
    const result = await prisma.ow_projects_commits.findMany({
      where: {
        id: {
          in: commits,
        },
      },
      select: {
        id: true,
        commit_date: true,
        commit_message: true,
        commit_file: true,
        commit_description: true,
        depth: true,
        parent_commit_id: true,
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            display_name: true,
          },
        },

      },
      orderBy: {
        commit_date: "desc",
      },
    });

    const authors = await sanitizeProfiles(result.map(commit => commit.author), res.locals.userid);
    res.status(200).send({
      status: "success",
      message: "获取成功 使用BFS",
      data: result.map((commit, index) => ({ ...commit, author: authors[index] })),
    });
  } catch (err) {
    logger.error("Error getting project commits:", err);
    next(err);
  }
});

router.post("/branches", needLogin, requireResource("project", "update", "projectid", { allowDelegation: true }), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    const { name, branch, projectid } = req.body;
    const sourceBranch = await prisma.ow_projects_branch.findFirst({
      where: { projectid: Number(projectid), name: branch },
    });
    if (!sourceBranch) {
      return res.status(200).send({
        status: "error",
        message: "源分支不存在",
      });
    }
    const { latest_commit_hash } = sourceBranch;
    if (!latest_commit_hash) {
      return res.status(200).send({
        status: "error",
        message: "分支不存在",
      });
    }
    await prisma.ow_projects_branch.create({
      data: {
        projectid: Number(projectid),
        name: name,
        description: "",
        latest_commit_hash: latest_commit_hash,
      },
    });

    res.status(200).send({
      status: "success",
      message: "创建成功",
      data: latest_commit_hash,
    });
  } catch (err) {
    logger.error("Error getting project information:", err);
    next(err);
  }
});
// 获取项目信息
router.get("/id/:id", (req, res, next) => req.headers["x-zerocat-delegation"] !== undefined
  ? requireResource("project", "read", "id", { allowDelegation: true })(req, res, next) : next(), async (req, res, next) => {
  try {
  const userId = res.locals.userid || 0; // 未登录用户为匿名用户
  if (res.locals.authorization?.allowed) await ensureProjectVisible(req.params.id, userId, { ignorePrivacy: true });
  else await checkProjectPermission(req.params.id, userId, "read");

  const project = await prisma.ow_projects.findFirst({
    where: { id: Number(req.params.id) },
    select: {
      ...projectSelectionFields(),
      project_tags: { select: { name: true, id: true, created_at: true } },
    },
  });

  project.tags = project.project_tags;
  project.project_tags = project.tags.map(({ id, name }) => ({ id, name }));
  logger.debug(project.tags);
  logger.debug(project);
  res.status(200).send((await sanitizeProjectAuthors([project], userId))[0]);
  } catch (error) { next(error); }
});

// 获取项目云变量配置
router.get("/id/:id/cloudconfig", async (req, res, next) => {
  try {
    const projectId = Number(req.params.id);
    const userId = res.locals.userid || 0;
    await ensureProjectVisible(projectId, userId);

    const hasPermission = await hasProjectPermission(projectId, userId, "read");
    if (!hasPermission) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
      });
    }

    const config = await loadCloudConfigFromDb(projectId);
    await refreshCloudConfigCache(projectId, config);
    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: [
        {
          target_type: PROJECT_CONFIG_TARGET_TYPE,
          target_id: String(projectId),
          key: PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE,
          value: config.anonymousWriteEnabled,
          raw_value: config.anonymousWriteEnabled ? "true" : "false",
          updated_at: null,
        },
        {
          target_type: PROJECT_CONFIG_TARGET_TYPE,
          target_id: String(projectId),
          key: PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED,
          value: config.historyEnabled,
          raw_value: config.historyEnabled ? "true" : "false",
          updated_at: null,
        },
      ],
    });
  } catch (err) {
    logger.error("Error getting project cloud config:", err);
    next(err);
  }
});

// 更新项目云变量匿名写入配置
router.put("/id/:id/cloudconfig", needLogin, requireResource("project", "update", "id", { allowDelegation: true }), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    const projectId = Number(req.params.id);
    // 权限已由 requireResource("project","update","id") 中间件校验（含协作者）。
    const project = await prisma.ow_projects.findFirst({
      where: { id: projectId },
      select: { id: true },
    });

    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在或无权访问",
      });
    }

    const rawAnonymousWrite = req.body?.anonymouswrite ?? req.body?.[PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE];
    const rawHistoryEnabled = req.body?.historyenabled ?? req.body?.[PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED];

    if (rawAnonymousWrite === undefined && rawHistoryEnabled === undefined) {
      return res.status(400).send({
        status: "error",
        message: "缺少配置项",
      });
    }

    const updates = [];

    if (rawAnonymousWrite !== undefined) {
      const enabled = parseBooleanInput(rawAnonymousWrite);
      if (enabled === null) {
        return res.status(400).send({
          status: "error",
          message: "anonymouswrite 必须是布尔值",
        });
      }
      const saved = await setProjectCloudAnonymousWriteConfig(projectId, enabled);
      updates.push({
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key: PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE,
        value: parseBooleanConfigValue(saved.value, false),
        raw_value: saved.value,
        updated_at: saved.updated_at,
      });
    }

    if (rawHistoryEnabled !== undefined) {
      const enabled = parseBooleanInput(rawHistoryEnabled);
      if (enabled === null) {
        return res.status(400).send({
          status: "error",
          message: "historyenabled 必须是布尔值",
        });
      }
      const saved = await setProjectCloudHistoryEnabledConfig(projectId, enabled);
      updates.push({
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key: PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED,
        value: parseBooleanConfigValue(saved.value, true),
        raw_value: saved.value,
        updated_at: saved.updated_at,
      });
    }

    // Reuse the canonical read for both the response and the cache refresh.
    const fullConfig = await loadCloudConfigFromDb(projectId);
    await refreshCloudConfigCache(projectId, fullConfig);
    const fullResponse = [
      {
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key: PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE,
        value: fullConfig.anonymousWriteEnabled,
        raw_value: fullConfig.anonymousWriteEnabled ? "true" : "false",
        updated_at: updates.find((item) => item.key === PROJECT_CONFIG_KEY_CLOUD_ANON_WRITE)?.updated_at ?? null,
      },
      {
        target_type: PROJECT_CONFIG_TARGET_TYPE,
        target_id: String(projectId),
        key: PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED,
        value: fullConfig.historyEnabled,
        raw_value: fullConfig.historyEnabled ? "true" : "false",
        updated_at: updates.find((item) => item.key === PROJECT_CONFIG_KEY_CLOUD_HISTORY_ENABLED)?.updated_at ?? null,
      },
    ];

    res.status(200).send({
      status: "success",
      message: "保存成功",
      data: fullResponse,
    });
  } catch (err) {
    logger.error("Error updating project cloud config:", err);
    next(err);
  }
});

// 更新作品信息
router.put("/id/:id", needLogin, requireResource("project", "update", "id", { allowDelegation: true }), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    // 权限已由 requireResource 中间件校验（作者或编辑者及以上协作者）。
    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(req.params.id) },
    });

    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在或无权访问",
      });
    }

    const updatedData = extractProjectData(req.body);
    if (updatedData.type === "article") {
      const authorization = res.locals.authorization;
      for (const userId of new Set([res.locals.userid, ...(authorization?.allowed ? [authorization.principalId] : [])])) {
        await assertCanWrite(userId, "blog", "update");
      }
    }
    // 可见性(state)属于高风险设置：仅作者/管理员协作者可改，编辑者通过本接口改 state 时忽略。
    if (updatedData.state !== undefined) {
      const { authorize } = await import("../services/auth/authorization.js");
      const decision = await authorize({
        userId: res.locals.userid, requiredScope: `project:${req.params.id}:manage`,
        tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [],
        allowDelegation: true, delegationId: req.headers["x-zerocat-delegation"],
      });
      const canManage = decision.allowed;
      if (!canManage) {
        delete updatedData.state;
      }
    }
    await prisma.ow_projects.update({
      where: { id: Number(req.params.id) },
      data: updatedData,
    });

    // 处理标签
    if (req.body.tags) {
      await handleTagsChange(Number(req.params.id), req.body.tags);
    }

    // 收集变更的字段信息
    const changes = {
      updated_fields: [],
      old_values: {},
      new_values: {},
    };

    // 必须记录的字段
    ["title", "type", "state"].forEach((field) => {
      if (updatedData[field] !== undefined) {
        changes.updated_fields.push(field);
        changes.old_values[field] = project[field];
        changes.new_values[field] = updatedData[field];
      }
    });

    // 其他可能变更的字段
    ["description", "license", "thumbnail"].forEach((field) => {
      if (
        updatedData[field] !== undefined &&
        updatedData[field] !== project[field]
      ) {
        changes.updated_fields.push(field);
        changes.old_values[field] = project[field];
        changes.new_values[field] = updatedData[field];
      }
    });

    // 创建项目信息更新事件
    await createEvent(
      "project_info_update",
      res.locals.userid,
      "project",
      Number(req.params.id),
      {
        updated_fields: changes.updated_fields,
        old_values: changes.old_values,
        new_values: changes.new_values,
        // 基本项目信息
        project_name: project.name,
        project_title: updatedData.title || project.title,
        project_type: updatedData.type || project.type,
        project_description: updatedData.description || project.description,
        project_state: updatedData.state || project.state,
        notification_title: `${res.locals.username || "有人"} 更新了项目信息`,
        notification_content: changes.updated_fields.length > 0
          ? `${res.locals.username || "有人"} 更新了项目《${updatedData.title || project.title || project.name}》的 ${changes.updated_fields.join("、")}`
          : `${res.locals.username || "有人"} 更新了项目《${updatedData.title || project.title || project.name}》的信息`,
      },
      project.state === "private" // 根据项目状态决定是否私密
    );

    queueManager.enqueueProjectGorseSync(Number(req.params.id), {
      reason: "project_update",
      delayMs: 15000,
    }).catch((error) => {
      logger.debug(`[gorse] update project sync enqueue failed project=${req.params.id}: ${error.message}`);
    });

    res.status(200).send({
      status: "success",
      message: "保存成功",
    });
  } catch (err) {
    logger.error("Error updating project information:", err);
    next(err);
  }
});

// 根据 authorname 和 projectname 获取项目
router.get("/namespace/:authorname/:projectname", async (req, res, next) => {
  try {
    const { authorname, projectname } = req.params;
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户

    const author = await prisma.ow_users.findUnique({ where: { username: authorname }, select: authorSelectionFields() });
    if (!author) {
      return res.status(404).send({
        status: "error",
        message: "用户不存在",
      });
    }

    const project = await prisma.ow_projects.findFirst({
      where: await visibleProjectWhere({ authorid: author.id, name: projectname }, userId),
      select: projectSelectionFields(),
    });

    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
      });
    }

    await checkProjectPermission(project.id, userId, "read");

    const tags = await prisma.ow_projects_tags.findMany({
      where: { projectid: project.id },
      select: { name: true, id: true, created_at: true },
    });

    project.author = await sanitizeProfile(author, userId);
    project.tags = tags;
    logger.debug(tags);
    logger.debug(project);
    res.status(200).send((await sanitizeProjectAuthors([project], userId))[0]);
  } catch (err) {
    logger.error("Error fetching project by authorname and projectname:", err);
    res.status(404).send({
      status: "error",
      message: "找不到页面",
    });
  }
});

// 根据文件哈希读取文件
router.get("/files/:sha256", async (req, res, next) => {
  try {
    const { sha256 } = req.params;
    const { accessFileToken } = req.query;
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    const content = req.query.content;
    try {
      const tokenHash = await verifyFileAccessToken(accessFileToken, userId);
      if (tokenHash !== sha256) throw projectNotFound();
      const decoded = jwt.verify(accessFileToken, await zcconfig.get("security.jwttoken"));
      const projectId = decoded.data?.project_id;
      if (!projectId) throw projectNotFound();
      await ensureProjectVisible(projectId, userId);
      const reachable = await findReachableCommit(projectId, { sha256 });
      if (!reachable) {
        const staged = decoded.data.staged && userId && Number(decoded.data.userid) === Number(userId);
        if (!staged) throw projectNotFound();
      }
    } catch (err) {
      logger.error("Error verifying file access token:", err);
      return res.status(404).send({
        status: "error",
        message: "文件不存在",
      });
    }

    const file = await readProjectFile(sha256);

    if (!file) {
      return res.status(200).send({
        status: "error",
        message: "文件不存在",
      });
    }
    res.contentType("text/plain");
    if (content == "true") {
      res.status(200).send(file.source);
    } else {
      res.status(200).send({
        status: "success",
        message: "获取成功",
        file,
      });
    }
  } catch (err) {
    logger.error("Error fetching file by hash:", err);
    next(err);
  }
});

// 删除作品
import { requireSudo } from "../middleware/sudo.js"; // 放顶部已有import区

router.get(["/recycle-bin", "/deleted"], needLogin, requireScope("project:read"), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 100000);
    const ownerWhere = { authorid: Number(res.locals.userid), deleted_at: { not: null } };
    const projects = await prisma.ow_projects.findMany({
      where: { ...ownerWhere, ...(req.query.cursor ? { id: { lt: Number(req.query.cursor) } } : {}) },
      orderBy: { id: "desc" },
      take: limit,
      ...(req.query.page && !req.query.cursor ? { skip: (page - 1) * limit } : {}),
      select: { ...projectSelectionFields(), deleted_at: true, deletion_source: true },
    });
    res.json({
      status: "success",
      data: {
        total: await prisma.ow_projects.count({ where: ownerWhere }),
        page,
        limit,
        projects: projects.map(({ deletion_source, ...project }) => ({ ...project, can_restore: deletion_source !== "admin" && deletion_source !== "administrative" })),
        next_cursor: projects.length === limit ? String(projects[projects.length - 1].id) : null,
        has_more: projects.length === limit,
      },
    });
  } catch (error) { next(error); }
});

router.post("/:id/restore", needLogin, requireResource("project", "delete", "id", { includeDeleted: true }), async (req, res, next) => {
  try {
    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(req.params.id), authorid: Number(res.locals.userid) },
      select: { id: true, type: true },
    });
    if (!project) throw projectNotFound();
    await assertCanWrite(res.locals.userid, "project", "restore");
    if (project.type === "article") await assertCanWrite(res.locals.userid, "blog", "restore");
    await restoreContent("project", project.id, res.locals.userid, {
      authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] },
    });
    res.json({ status: "success", message: "恢复成功" });
  } catch (error) { next(error); }
});

router.delete("/:id", needLogin, requireResource("project", "delete", "id", { allowDelegation: true }), requireSudo, projectWriteGuard("delete", projectIdFromRequest), async (req, res, next) => {
  try {
    await softDeleteContent("project", Number(req.params.id), res.locals.userid, {
      reason: String(req.body?.reason || ""),
      authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [], delegationId: req.headers["x-zerocat-delegation"], allowDelegation: true },
    });
    res.status(200).send({ status: "success", message: "删除成功" });
  } catch (err) {
    logger.error("Error deleting project:", err);
    next(err);
  }
});

// 重命名项目
router.put("/rename/:id", needLogin, requireResource("project", "update", "id", { allowDelegation: true }), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newName } = req.body;

    if (!newName) {
      return res.status(400).send({
        status: "error",
        message: "缺少必要的参数",
      });
    }

    // 权限已由 requireResource 中间件校验（作者或编辑者及以上协作者）。
    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(id) },
    });

    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在或无权访问",
      });
    }

    // 重名校验针对项目作者的项目集合（协作者重命名时作者仍是原作者）。
    const existingProject = await prisma.ow_projects.findFirst({
      where: { name: newName, authorid: project.authorid, NOT: { id: Number(id) } },
    });

    if (existingProject) {
      return res.status(200).send({
        status: "error",
        message: "项目名称已存在",
      });
    }

    await prisma.ow_projects.update({
      where: { id: Number(id) },
      data: { name: newName },
    });

    // 创建重命名事件
    await createEvent(
      "project_rename",
      res.locals.userid,
      "project",
      Number(id),
      {
        event_type: "project_rename",
        actor_id: res.locals.userid,
        target_type: "project",
        target_id: Number(id),
        old_name: project.name,
        new_name: newName,
        project_title: project.title,
        project_type: project.type,
        project_state: project.state,
        notification_title: `${res.locals.username || "有人"} 重命名了项目`,
        notification_content: `${res.locals.username || "有人"} 将项目《${project.name}》重命名为《${newName}》`,
      },
      project.state === "private" // 根据项目状态决定是否私密
    );

    queueManager.enqueueProjectGorseSync(Number(id), {
      reason: "project_rename",
      delayMs: 15000,
    }).catch((error) => {
      logger.debug(`[gorse] rename project sync enqueue failed project=${id}: ${error.message}`);
    });

    res.status(200).send({
      status: "success",
      message: "重命名成功",
    });
  } catch (err) {
    logger.error("Error renaming project:", err);
    next(err);
  }
});

// 重命名项目
router.put("/changevisibility/:id", needLogin, requireResource("project", "manage", "id", { allowDelegation: true }), requireSudo, projectWriteGuard("manage", projectIdFromRequest), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newState } = req.body;

    if (!newState || (newState !== "public" && newState !== "private")) {
      return res.status(400).send({
        status: "error",
        message: "缺少必要的参数",
      });
    }

    // 权限已由 requireResource("project","manage","id") 校验（作者或管理员协作者）。
    await prisma.ow_projects
      .update({
        where: { id: Number(id) },
        data: { state: newState },
      })
      .catch((err) => {
        return res.status(400).send({
          status: "error",
          message: "无权操作",
        });
      })
      .then((result) => {
        queueManager.enqueueProjectGorseSync(Number(id), {
          reason: "project_visibility",
          delayMs: 0,
        }).catch((error) => {
          logger.debug(`[gorse] visibility project sync enqueue failed project=${id}: ${error.message}`);
        });

        res.status(200).send({
          status: "success",
          message: "操作成功",
        });
      });
  } catch (err) {
    logger.error("Error renaming project:", err);
    next(err);
  }
});

// 修改分支简介
router.post("/branches/description", needLogin, requireResource("project", "update", "projectid", { allowDelegation: true }), projectWriteGuard("update", projectIdFromRequest), async (req, res, next) => {
  try {
    const { projectid, branch } = req.query;
    const { description } = req.body;

    if (!description || typeof branch !== 'string' || !branch
      || !Number.isSafeInteger(Number(projectid)) || Number(projectid) <= 0) {
      return res.status(400).send({
        status: "error",
        message: "缺少必要的参数",
      });
    }


    const updated = await prisma.ow_projects_branch.updateMany({
      where: { projectid: Number(projectid), name: branch },
      data: { description },
    });

    if (updated.count === 0) {
      return res.status(404).send({
        status: "error",
        message: "分支不存在",
      });
    }

    res.status(200).send({
      status: "success",
      message: "分支简介更新成功",
    });
  } catch (err) {
    logger.error("Error updating branch description:", err);
    next(err);
  }
});

router.post("/fork", needLogin, requireScope("project:create"), projectWriteGuard("create", projectIdFromRequest), async (req, res, next) => {
  const { projectid, branch, name } = req.body;

  try {
    await checkProjectPermission(projectid, res.locals.userid, "read");

    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(projectid) },
    });

    if (!project) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
      });
    }
    console.log(res.locals.userid);
    const existingProject = await prisma.ow_projects.findFirst({
      where: {
        authorid: res.locals.userid,
        name: name,
      },
      select: { id: true },
    });
    logger.debug(existingProject);
    if (existingProject) {
      return res.status(200).send({
        status: "error",
        message: "同名项目已存在",
      });
    }

    let branches;
    if (branch == "all") {
      branches = await prisma.ow_projects_branch.findMany({
        where: { projectid: Number(projectid) },
      });
    } else {
      branches = [
        await prisma.ow_projects_branch.findFirst({
          where: { projectid: Number(projectid), name: project.default_branch },
        }),
      ];
    }
    // 过滤掉 null（未初始化或不存在的分支）
    branches = branches.filter((b) => b !== null);
    if (branches.length == 0) {
      return res.status(404).send({
        status: "error",
        message: "分支不存在或项目尚未初始化",
      });
    }
    const forkedProject = await prisma.ow_projects.create({
      data: {
        name: name,
        type: project.type,
        state: project.state,
        license: project.license,
        authorid: res.locals.userid,
        title: project.title,
        description: project.description,
        fork: projectid,
        default_branch: project.default_branch,
        thumbnail: project.thumbnail,
      },
    });

    await prisma.ow_projects_branch.createMany({
      data: branches.map((branch) => ({
        projectid: forkedProject.id,
        name: branch.name,
        creator: res.locals.userid,
        latest_commit_hash: branch.latest_commit_hash,
        description: branch.description,
        protected: branch.protected,
      })),
    });

    res.status(200).send({
      status: "success",
      message: "项目已成功分叉",
    });
    // 根据原项目和新项目的状态决定事件是否公开
    const isPrivate =
      project.state === "private" || forkedProject.state === "private";
    logger.error(project);
    await createEvent(
      "project_fork",
      res.locals.userid,
      "project",
      Number(forkedProject.id),
      {
        NotificationTo: [project.authorid],
        event_type: "project_fork",
        actor_id: res.locals.userid,
        target_type: "project",
        target_id: Number(forkedProject.id),
        project_name: forkedProject.name,
        project_title: forkedProject.title,
        source_project_name: project.name,
        source_project_title: project.title,
        notification_title: `${res.locals.username || "有人"} 派生了你的项目`,
        notification_content: `${res.locals.username || "有人"} 将你的项目《${project.title || project.name}》派生为《${forkedProject.title || forkedProject.name}》`,
      },
      isPrivate
    );
  } catch (err) {
    logger.error("Error forking project:", err);
    res.status(500).send({
      status: "error",
      message: "服务器内部错误",
    });
  }
});

// 获取项目访问统计数据
router.get("/stats/:id", async (req, res, next) => {
  try {
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    await checkProjectPermission(req.params.id, userId, "read");

    // 获取分析数据（最近30天）
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [analytics, forkCount] = await Promise.all([
      getAnalytics(
        "project",
        Number(req.params.id),
        thirtyDaysAgo.toISOString().split("T")[0],
        now.toISOString().split("T")[0]
      ),
      prisma.ow_projects.count({
        where: {
          fork: Number(req.params.id),
          ...await visibleWhere("project", userId),
        },
      }),
    ]);

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: {
        pageviews: analytics.overview.pageviews.value,
        visitors: analytics.overview.visitors.value,
        forks: forkCount,
      },
    });
  } catch (err) {
    logger.error("Error getting project stats:", err);
    next(err);
  }
});

// 获取项目信息（包含分析数据）
router.get("/info/:id", async (req, res, next) => {
  try {
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    await checkProjectPermission(req.params.id, userId, "read");

    // Fetch the author and tags with the project, including tag timestamps for this response.
    const project = await prisma.ow_projects.findFirst({
      where: { id: Number(req.params.id) },
      select: {
        ...projectSelectionFields(),
        project_tags: { select: { name: true, id: true, created_at: true } },
      },
    });

    // 获取分析数据
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const analytics = await getAnalytics(
      "project",
      Number(req.params.id),
      thirtyDaysAgo.toISOString().split("T")[0],
      now.toISOString().split("T")[0]
    );

    // 组合所有数据
    project.tags = project.project_tags;
    project.project_tags = project.tags.map(({ id, name }) => ({ id, name }));
    project.analytics = {
      pageviews: analytics.overview.pageviews.value,
      visitors: analytics.overview.visitors.value,
    };

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: (await sanitizeProjectAuthors([project], userId))[0],
    });
  } catch (err) {
    logger.error("Error getting project information with analytics:", err);
    next(err);
  }
});

// 获取当前用户项目推荐（基于用户兴趣向量）
router.get("/recommend/me", needLogin, requireScope("project:read"), async (req, res, next) => {
  try {
    const userId = Number(res.locals.userid);
    const { limit = 20, offset = 0, min_similarity = null } = req.query;

    const data = await getRecommendedProjectsForUser({
      userId,
      limit,
      offset,
      minSimilarity: min_similarity,
    });

    return res.status(200).send({
      status: "success",
      message: data.message || "获取成功",
      data,
    });
  } catch (err) {
    logger.error("Error getting recommended projects for user:", err);
    next(err);
  }
});

// 获取当前用户 + 当前项目上下文推荐
router.get("/recommend/context/:projectId", needLogin, requireResource("project", "read", "projectId"), async (req, res, next) => {
  try {
    const userId = Number(res.locals.userid);
    const projectId = Number(req.params.projectId);
    const { limit = 20, offset = 0, min_similarity = null } = req.query;

    const data = await getContextRecommendedProjects({
      userId,
      projectId,
      limit,
      offset,
      minSimilarity: min_similarity,
    });

    return res.status(200).send({
      status: "success",
      message: data.message || "获取成功",
      data,
    });
  } catch (err) {
    logger.error("Error getting context recommended projects:", err);
    next(err);
  }
});

router.post("/:id/read", needLogin, requireResource("project", "interact", "id"), async (req, res, next) => {
  try {
    const userId = Number(res.locals.userid);
    const projectId = Number(req.params.id);

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ status: "error", message: "无效的项目 ID" });
    }

    await checkProjectPermission(projectId, userId, "read");

    gorseService.feedbackProjectRead(userId, projectId).catch((error) => {
      logger.debug("[gorse] feedbackProjectRead failed:", error.message);
    });

    return res.status(200).json({
      status: "success",
      data: { acknowledged: true, reported: true },
    });
  } catch (err) {
    logger.error("Error marking project read:", err);
    next(err);
  }
});

// 基于项目查找相似项目
router.get("/similar/:projectId", async (req, res, next) => {
  try {
    const userId = res.locals.userid || null;
    const projectId = Number(req.params.projectId);
    const { limit = 20, offset = 0, min_similarity = null } = req.query;

    const data = await getSimilarProjectsByProject({
      userId,
      projectId,
      limit,
      offset,
      minSimilarity: min_similarity,
    });

    return res.status(200).send({
      status: "success",
      message: data.message || "获取成功",
      data,
    });
  } catch (err) {
    logger.error("Error getting similar projects:", err);
    next(err);
  }
});

// 获取项目文件 放最后最后匹配免得冲突
router.get("/:id/:branch/:ref", async (req, res, next) => {
  try {
    const { id, branch, ref } = req.params;
    const userId = res.locals.userid || 0; // 未登录用户为匿名用户
    await ensureProjectVisible(id, userId);
    const hasPermission = await hasProjectPermission(id, userId, "read");

    if (!hasPermission) {
      return res.status(404).send({
        status: "error",
        message: "项目不存在",
        code: "404",
      });
    }

    // 首先验证分支是否属于目标项目
    const branchExists = await prisma.ow_projects_branch.findFirst({
      where: {
        projectid: Number(id),
        name: branch,
      },
    });

    if (!branchExists) {
      return res.status(200).send({
        status: "error",
        message: "分支不存在",
        code: "404",
      });
    }

    let commit;
    if (ref === "latest") {
      // 对于最新提交，我们使用分支记录中存储的最新提交哈希
      if (branchExists.latest_commit_hash) {
        commit = await prisma.ow_projects_commits.findFirst({
          where: { id: branchExists.latest_commit_hash },
        });
      }
    } else {
      // 对于特定提交，我们只需要验证提交ID
      commit = await findReachableCommit(id, { commitId: ref });
    }

    if (!commit) {
      const project = await prisma.ow_projects.findFirst({
        where: { id: Number(id) },
      });
      const defaultSource = default_project[project.type];
      if (!defaultSource) {
        return res.status(200).send({
          status: "error",
          message: "默认作品不存在",
        });
      }

      return res.status(200).send({
        status: "error",
        message: "无有效提交",
        commit: {
          error_code: "NoFirstCommit",
          commit_message: "仓库无有效提交",
        },
      });
    }

    const accessFileToken = await issueProjectFileAccessToken(
      commit.commit_file,
      userId,
      req.query.projectid || req.params.id
    );

    res.status(200).send({
      status: "success",
      message: "获取成功",
      commit,
      accessFileToken,
    });
  } catch (err) {
    logger.error("Error fetching project file:", err);
    next(err);
  }
});

export default router;
