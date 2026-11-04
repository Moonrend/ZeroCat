import logger from "../services/logger.js";
import zcconfig from "../services/config/zcconfig.js";
import { Router } from "express";
import { prisma } from "../services/prisma.js";
import { needLogin } from "../middleware/auth.js";
import { requireResource, requireScope } from "../middleware/scope.js";
import { hasProjectPermission } from "../services/auth/permissionManager.js";
import { setReviewStatus, isAutoApproveUser } from "../services/extensionReview.js";
import { authorize } from "../services/auth/authorization.js";
import { findProjectCommit } from "../services/projectCommitAccess.js";
import { readProjectFile } from "../services/projectFileStorage.js";
import { canViewContent, sanitizeProfile, sanitizeProfiles, visibleWhere } from "../services/moderation/visibility.js";

async function sanitizeExtension(extension, res) {
  const viewerId = res.locals.userid;
  if (!extension || !await canViewContent('extension', extension, viewerId)) return null;
  if (viewerId) {
    for (const requiredScope of [`extension:${extension.id}:read`, `project:${extension.projectid}:read`]) {
      const decision = await authorize({ actorId: viewerId, tokenType: res.locals.tokenType,
        tokenScopes: res.locals.scopes || [], requiredScope });
      if (!decision.allowed) return null;
    }
  }
  if (extension.project?.author) extension.project.author = await sanitizeProfile(extension.project.author, viewerId);
  if (extension.sample_project && !await canViewContent('project', extension.sample_project, viewerId)) {
    extension.sample_project = null;
  } else if (extension.sample_project?.author) {
    extension.sample_project.author = await sanitizeProfile(extension.sample_project.author, viewerId);
  }
  return extension;
}

// Call only for rows selected with visibleWhere('extension', viewerId) in this request.
async function sanitizeVisibleExtensions(extensions, res) {
  const viewerId = res.locals.userid;
  const allowed = [];
  for (const extension of extensions) {
    let permitted = true;
    if (viewerId) {
      for (const requiredScope of [`extension:${extension.id}:read`, `project:${extension.projectid}:read`]) {
        const decision = await authorize({ actorId: viewerId, tokenType: res.locals.tokenType,
          tokenScopes: res.locals.scopes || [], requiredScope });
        if (!decision.allowed) { permitted = false; break; }
      }
    }
    if (permitted) allowed.push(extension);
  }
  const sampleIds = [...new Set(allowed.map(extension => extension.sample_project?.id).filter(Boolean))];
  const visibleSamples = new Set();
  if (sampleIds.length) {
    const visibility = await visibleWhere('project', viewerId);
    for (let offset = 0; offset < sampleIds.length; offset += 500) {
      const samples = await prisma.ow_projects.findMany({
        where: { id: { in: sampleIds.slice(offset, offset + 500) }, AND: [visibility] }, select: { id: true },
      });
      samples.forEach(sample => visibleSamples.add(sample.id));
    }
  }
  const authoredProjects = [];
  for (const extension of allowed) {
    if (extension.sample_project && !visibleSamples.has(extension.sample_project.id)) extension.sample_project = null;
    for (const project of [extension.project, extension.sample_project]) {
      if (project?.author) authoredProjects.push(project);
    }
  }
  const profiles = await sanitizeProfiles(authoredProjects.map(project => ({
    ...project.author, id: project.author.id ?? project.authorid,
  })), viewerId);
  authoredProjects.forEach((project, index) => { if (!profiles[index]) project.author = null; });
  return allowed;
}

async function requireExtensionProject(req, res, next) {
  try {
    const extension = await prisma.ow_scratch_extensions.findUnique({
      where: { id: Number(req.params.id) }, include: { project: true },
    });
    if (!extension) return res.status(404).send({ status: 'error', message: '扩展不存在' });
    const decision = await authorize({
      actorId: res.locals.userid, tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [],
      requiredScope: `project:${extension.projectid}:update`, action: 'manage',
    });
    if (!decision.allowed) return res.status(decision.status).send({ status: 'error', code: decision.code, message: decision.message });
    res.locals.extension = extension;
    next();
  } catch (error) { next(error); }
}

const router = Router();
let s3staticurl=await zcconfig.get("s3.staticurl");
async function validateBranchAndCommit(projectid, branch, commit, userid, loadedProject = null) {
  const project = loadedProject || await prisma.ow_projects.findFirst({
    where: { id: Number(projectid) },
  });

  if (!project) {
    throw new Error("项目不存在");
  }

  const hasPermission = await hasProjectPermission(projectid, userid, "read");
  if (!hasPermission || !await canViewContent('project', project, userid)) {
    throw new Error("无权访问该项目");
  }

  const targetBranch = branch || project.default_branch;

  const branchRecord = await prisma.ow_projects_branch.findFirst({
    where: {
      projectid: Number(projectid),
      name: targetBranch,
    },
  });

  if (!branchRecord) {
    throw new Error("分支不存在");
  }

  let targetCommit;
  if (!commit || commit === "latest") {
    //targetCommit = branchRecord.latest_commit_hash;
    targetCommit = "latest";
  } else {
    const commitRecord = await findProjectCommit(projectid, commit, targetBranch);
    if (!commitRecord) {
      throw new Error("提交不存在");
    }
    targetCommit = commit;
  }

  return {
    project,
    branch: targetBranch,
    commit: targetCommit,
  };
}

router.post("/manager/create", needLogin, requireResource("project", "update", "projectid"), requireScope("extension:manage"), async (req, res, next) => {
  try {
    const { projectid, branch, commit, image, samples, docs, scratchCompatible } = req.body;

    if (!projectid) {
      return res.status(400).send({
        status: "error",
        message: "缺少项目ID",
      });
    }

    const project = await prisma.ow_projects.findFirst({
      where: {
        id: Number(projectid),
        authorid: res.locals.userid,
      },
    });

    if (!project) {
      return res.status(403).send({
        status: "error",
        message: "项目不存在或无权访问",
      });
    }

    const {
      project: validatedProject,
      branch: validatedBranch,
      commit: validatedCommit,
    } = await validateBranchAndCommit(
      projectid,
      branch,
      commit,
      res.locals.userid,
      project
    );

    let samplesProjectId = null;
    if (samples) {
      const samplesProject = await prisma.ow_projects.findFirst({
        where: {
          id: Number(samples),
          authorid: res.locals.userid,
        },
      });
      if (!samplesProject) {
        return res.status(400).send({
          status: "error",
          message: "示例项目不存在或无权访问",
        });
      }
      samplesProjectId = Number(samples);
    }

    const existingExtension = await prisma.ow_scratch_extensions.findFirst({
      where: { projectid: Number(projectid) },
    });

    if (existingExtension) {
      return res.status(400).send({
        status: "error",
        message: "该项目已存在扩展",
      });
    }

    const extension = await prisma.ow_scratch_extensions.create({
      data: {
        projectid: Number(projectid),
        branch: validatedBranch,
        commit: validatedCommit,
        image: image || "",
        samples: samplesProjectId,
        docs: docs || null,
        scratchCompatible: scratchCompatible || false,
        status: "developing",
      },
    });

    // Check if user is in auto-approve list
    const user = await prisma.ow_users.findUnique({
      where: { id: res.locals.userid },
      select: { username: true },
    });
    if (user && await isAutoApproveUser(user.username)) {
      await setReviewStatus(projectid, "approved");
      await prisma.ow_scratch_extensions.update({
        where: { id: extension.id },
        data: { status: "verified" },
      });
      extension.status = "verified";
    }

    res.status(200).send({
      status: "success",
      message: "扩展创建成功",
      data: extension,
    });
  } catch (err) {
    logger.error("Error creating extension:", err);
    res.status(500).send({
      status: "error",
      message: err.message || "创建扩展时出错",
    });
  }
});

router.put("/manager/edit/:id", needLogin, requireResource("extension", "manage", "id"), requireExtensionProject, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { branch, commit, image, samples, docs, scratchCompatible } = req.body;

    const extension = res.locals.extension;

    if (!extension) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }

    if (extension.project.authorid !== res.locals.userid) {
      return res.status(403).send({
        status: "error",
        message: "无权编辑该扩展",
      });
    }

    const updateData = {};

    if (branch !== undefined || commit !== undefined) {
      const { branch: validatedBranch, commit: validatedCommit } =
        await validateBranchAndCommit(
          extension.projectid,
          branch,
          commit,
          res.locals.userid,
          extension.project
        );
      updateData.branch = validatedBranch;
      updateData.commit = validatedCommit;
    }

    if (image !== undefined) {
      updateData.image = image;
    }

    if (samples !== undefined) {
      if (samples) {
        const samplesProject = await prisma.ow_projects.findFirst({
          where: {
            id: Number(samples),
            authorid: res.locals.userid,
          },
        });
        if (!samplesProject) {
          return res.status(400).send({
            status: "error",
            message: "示例项目不存在或无权访问",
          });
        }
        updateData.samples = Number(samples);
      } else {
        updateData.samples = null;
      }
    }

    if (docs !== undefined) {
      updateData.docs = docs || null;
    }

    if (scratchCompatible !== undefined) {
      updateData.scratchCompatible = Boolean(scratchCompatible);
    }
    logger.debug(updateData);
    const updatedExtension = await prisma.ow_scratch_extensions.update({
      where: { id: Number(id) },
      data: updateData,
    });

    res.status(200).send({
      status: "success",
      message: "扩展更新成功",
      data: updatedExtension,
    });
  } catch (err) {
    logger.error("Error updating extension:", err);
    res.status(500).send({
      status: "error",
      message: err.message || "更新扩展时出错",
    });
  }
});

router.post("/manager/update/:id", needLogin, requireResource("extension", "manage", "id"), requireExtensionProject, async (req, res, next) => {
  try {
    const { id } = req.params;

    const extension = res.locals.extension;

    if (!extension) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }

    if (extension.project.authorid !== res.locals.userid) {
      return res.status(403).send({
        status: "error",
        message: "无权更新该扩展",
      });
    }

    // 如果当前commit已经是"latest"，则无需更新
    if (extension.commit === "latest") {
      return res.status(200).send({
        status: "success",
        message: "扩展已是最新提交",
        data: extension,
      });
    }

    // 获取当前分支的最新提交
    const branchRecord = await prisma.ow_projects_branch.findFirst({
      where: {
        projectid: extension.projectid,
        name: extension.branch,
      },
    });

    if (!branchRecord) {
      return res.status(400).send({
        status: "error",
        message: "无法获取分支最新提交",
      });
    }

    // 更新扩展的commit为最新提交
    const updatedExtension = await prisma.ow_scratch_extensions.update({
      where: { id: Number(id) },
      data: {
        commit: branchRecord.latest_commit_hash,
      },
    });

    res.status(200).send({
      status: "success",
      message: "扩展已更新到最新提交",
      data: updatedExtension,
    });
  } catch (err) {
    logger.error("Error updating extension commit:", err);
    res.status(500).send({
      status: "error",
      message: err.message || "更新扩展提交时出错",
    });
  }
});

router.post("/manager/submit/:id", needLogin, requireResource("extension", "manage", "id"), requireExtensionProject, async (req, res, next) => {
  try {
    const { id } = req.params;
    // 查找扩展及其项目作者
    const extension = res.locals.extension;
    if (!extension) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }
    if (extension.project.authorid !== res.locals.userid) {
      return res.status(403).send({
        status: "error",
        message: "无权提交该扩展",
      });
    }
    if (extension.status !== "developing") {
      return res.status(400).send({
        status: "error",
        message: "仅开发中的扩展可以提交审核",
      });
    }

    // Check if user is in auto-approve list
    const user = await prisma.ow_users.findUnique({
      where: { id: res.locals.userid },
      select: { username: true },
    });
    const autoApproved = user && await isAutoApproveUser(user.username);

    if (autoApproved) {
      await setReviewStatus(extension.projectid, "approved");
      const updated = await prisma.ow_scratch_extensions.update({
        where: { id: Number(id) },
        data: { status: "verified" },
      });
      return res.status(200).send({
        status: "success",
        message: "扩展已自动通过审核",
        data: updated,
      });
    }

    await setReviewStatus(extension.projectid, "pending");
    const updated = await prisma.ow_scratch_extensions.update({
      where: { id: Number(id) },
      data: { status: "pending" },
    });
    res.status(200).send({
      status: "success",
      message: "扩展已提交审核，待管理员审核",
      data: updated,
    });
  } catch (err) {
    logger.error("Error submitting extension for review:", err);
    res.status(500).send({
      status: "error",
      message: err.message || "提交扩展审核时出错",
    });
  }
});

router.get("/manager/my", needLogin, requireScope("extension:read"), async (req, res, next) => {
  try {
    const extensions = await prisma.ow_scratch_extensions.findMany({
      where: {
        project: { authorid: res.locals.userid },
        AND: [await visibleWhere('extension', res.locals.userid)],
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            title: true,
            description: true,
            authorid: true,
            author: {
              select: { id: true, username: true, display_name: true, avatar: true },
            },
          },
        },
        sample_project: {
          select: {
            id: true,
            name: true,
            title: true,
          },
        },
      },
    });

    res.status(200).send({
      status: "success",
      message: "获取成功",
      data: await sanitizeVisibleExtensions(extensions, res),
    });
  } catch (err) {
    logger.error("Error getting my extensions:", err);
    res.status(500).send({
      status: "error",
      message: "获取我的扩展时出错",
    });
  }
});

router.delete("/manager/:id", needLogin, requireResource("extension", "manage", "id"), requireExtensionProject, async (req, res, next) => {
  try {
    const { id } = req.params;

    const extension = res.locals.extension;

    if (!extension) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }

    if (extension.project.authorid !== res.locals.userid) {
      return res.status(403).send({
        status: "error",
        message: "无权删除该扩展",
      });
    }

    await prisma.ow_scratch_extensions.delete({
      where: { id: Number(id) },
    });

    res.status(200).send({
      status: "success",
      message: "扩展删除成功",
    });
  } catch (err) {
    logger.error("Error deleting extension:", err);
    res.status(500).send({
      status: "error",
      message: "删除扩展时出错",
    });
  }
});


// 统一的单个扩展详情查询接口 - 支持查询公开扩展和用户自己的扩展
router.get("/detail/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // 构建查询条件
    const where = { id: Number(id), AND: [await visibleWhere('extension', res.locals.userid)] };


    const extension = await prisma.ow_scratch_extensions.findFirst({
      where,
      include: {
        project: {
          include: {
            author: {
              select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true
              }
            }
          }
        },
        sample_project: {
          include: {
            author: {
              select: {
                username: true,
                display_name: true
              }
            }
          }
        }
      }
    });

    if (!extension || !await sanitizeExtension(extension, res)) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在或未通过审核"
      });
    } if (extension.status !== "verified" && extension.project.authorid !== res.locals.userid) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在或未通过审核"
      });

    }


    res.status(200).send({
      status: "success",
      data: extension
    });
  } catch (err) {
    logger.error("Error getting extension detail:", err);
    res.status(500).send({
      status: "error",
      message: "获取扩展详情时出错"
    });
  }
});

// 统一的单个扩展详情查询接口 - 支持查询公开扩展和用户自己的扩展
router.get("/detailbyprojectid/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // 构建查询条件



    const extension = await prisma.ow_scratch_extensions.findFirst({
      where:{
        projectid: Number(id),
        AND: [await visibleWhere('extension', res.locals.userid)]
      },
      include: {
        project: {
          include: {
            author: {
              select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true
              }
            }
          }
        },
        sample_project: {
          include: {
            author: {
              select: {
                username: true,
                display_name: true
              }
            }
          }
        }
      }
    });

    if (!extension || !await sanitizeExtension(extension, res)) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在或未通过审核"
      });
    }
    if (extension.status !== "verified" && extension.project.authorid !== res.locals.userid) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在或未通过审核"
      });

    }




    res.status(200).send({
      status: "success",
      data: extension
    });
  } catch (err) {
    logger.error("Error getting extension detail:", err);
    res.status(500).send({
      status: "error",
      message: "获取扩展详情时出错"
    });
  }
});

// 批量扩展详情查询接口 - 仅返回可见扩展信息，并标记是否已验证
router.post("/detail/batch", needLogin, requireResource("extension", "read", (req) => req.body?.ids), async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).send({
        status: "error",
        message: "缺少扩展ID列表",
      });
    }

    const numericIds = ids
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));

    if (numericIds.length === 0) {
      return res.status(400).send({
        status: "error",
        message: "扩展ID列表无效",
      });
    }

    const extensions = await prisma.ow_scratch_extensions.findMany({
      where: { id: { in: numericIds }, AND: [await visibleWhere('extension', res.locals.userid)] },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            title: true,
            description: true,
            authorid: true,
            author: {
              select: { id: true, username: true, display_name: true, avatar: true },
            },
          },
        },
        sample_project: {
          select: {
            id: true,
            name: true,
            title: true,
          },
        },
      },
    });

    const extensionMap = new Map(
      (await sanitizeVisibleExtensions(extensions, res))
        .filter((ext) => ext && (ext.status === 'verified' || ext.project.authorid === res.locals.userid))
        .map((ext) => [ext.id, ext])
    );

    const data = numericIds.map((id) => {
      const ext = extensionMap.get(id);
      if (!ext) {
        return { id, exists: false, verified: false };
      }

      const isVerified = ext.status === "verified";

      return {
        id,
        exists: true,
        verified: isVerified,
        data: ext,
      };
    });

    res.status(200).send({
      status: "success",
      data,
    });
  } catch (err) {
    logger.error("Error getting batch extension detail:", err);
    res.status(500).send({
      status: "error",
      message: "批量获取扩展详情时出错",
    });
  }
});


router.get("/", async (req, res, next) => {
  try {
    const frontendUrl = await zcconfig.get("urls.frontend");

    const extensions = await prisma.ow_scratch_extensions.findMany({
      where: { status: "verified", AND: [await visibleWhere('extension', res.locals.userid)] },
      include: {
        project: {
          include: {
            author: {
              select: {
                username: true,
                display_name: true,
              },
            },
          },
        },
        sample_project: {
          include: {
            author: {
              select: {
                username: true,
              },
            },
          },
        },
      },
    });

    const visibleExtensions = (await sanitizeVisibleExtensions(extensions, res)).filter(Boolean);
    const formattedExtensions = visibleExtensions.map((ext) => {
      logger.debug(ext)
      const result = {
        slug: String(ext.id),
        id: String(ext.id),
        name: ext.project.title,
        description: ext.project.description,
        image: `${s3staticurl}/assets/${ext.project.thumbnail.substring(0, 2)}/${ext.project.thumbnail.substring(2, 4)}/${ext.project.thumbnail}`,
        by: [
          {
            name: ext.project.author?.display_name || '',
            link: ext.project.author ? `${frontendUrl}/${ext.project.author.username}` : '',
          },
        ],
      };

      if (ext.sample_project?.author) {
        result.samples = [
          `${ext.sample_project.author.username}/${ext.sample_project.name}`,
        ];
      }

      if (ext.docs) {
        result.docs = true;
      }

      if (ext.scratchCompatible) {
        result.scratchCompatible = true;
      }

      return result;
    });

    res.status(200).send({
      extensions: formattedExtensions,
    });
  } catch (err) {
    logger.error("Error listing extensions:", err);
    res.status(500).send({
      status: "error",
      message: "获取扩展列表时出错",
    });
  }
});
router.get("/{:id}.js", async (req, res, next) => {
  try {
    const { id } = req.params;
    let extension = await prisma.ow_scratch_extensions.findFirst({
      where: { id: Number(id), AND: [await visibleWhere('extension', res.locals.userid)] },
      include: { project: true },
    });
    if (!extension) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }
    if ((extension.status !== 'verified' && extension.project.authorid !== res.locals.userid)
      || !await sanitizeExtension(extension, res)) {
      return res.status(404).send({ status: 'error', message: '扩展不存在' });
    }
    if (extension.branch == "") {
      extension.branch = extension.project.default_branch;
    }
    if (extension.commit == "latest") {
      const branchRecord = await prisma.ow_projects_branch.findFirst({
        where: {
            projectid: extension.project.id,
            name: extension.branch,
          },
        });
        if (branchRecord) {
            extension.commit = branchRecord.latest_commit_hash;
        }
    }
    const commitRecord = await findProjectCommit(extension.project.id, extension.commit, extension.branch);
    if (!commitRecord) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }
    logger.debug(commitRecord);
    const file = await readProjectFile(commitRecord.commit_file);
    if (!file) {
      return res.status(404).send({
        status: "error",
        message: "扩展不存在",
      });
    }
    res.contentType("text/plain");
    res.status(200).send(file.source);
  } catch (err) {
    logger.error("Error getting extension:", err);
    res.status(500).send({
      status: "error",
      message: "获取扩展时出错",
    });
  }
});
router.get("/{:id}", async (req, res, next) => {
  try {
    const { id } = req.params;
    const frontendUrl = await zcconfig.get("urls.frontend");
    res.redirect(`${frontendUrl}/app/extensions/${id}`);
  } catch (err) {
    logger.error("Error getting extension:", err);
  }
});
export default router;
