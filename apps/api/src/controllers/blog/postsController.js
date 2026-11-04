import {prisma} from "../../services/prisma.js";
import { createHash } from "crypto";
import { hydrateProjectFile, saveProjectFile } from "../../services/projectFileStorage.js";
import { projectSelectionFields, sanitizeProjectAuthors } from "../projects.js";
import { visibleWhere, canViewContent, sanitizePublicUser, sanitizeProfiles, assertCanWrite } from "../../services/moderation/visibility.js";
import { authorizeResourceOperation, resourceAuthorizationContext } from "../../services/auth/resourceOperation.js";

async function ensureBlogOwner(req, res, action) {
  const actorId = Number(res.locals.userid);
  const decision = await authorizeResourceOperation(actorId, "blog", req.params.id, action, resourceAuthorizationContext(req, res));
  await assertCanWrite(actorId, "blog", action);
  await assertCanWrite(actorId, "projects", action);
  if (decision.principalId !== actorId) {
    await assertCanWrite(decision.principalId, "blog", action);
    await assertCanWrite(decision.principalId, "projects", action);
  }
  return prisma.ow_projects.findFirst({
    where: { id: Number(req.params.id), type: "article",
      ...(decision.delegationId != null ? { authorid: decision.principalId } : {}),
      AND: [await visibleWhere("project", actorId, { ignorePrivacy: true })] },
  });
}

const MAX_PROJECT_NAME_LENGTH = 128;
const ASSET_HASH_PATTERN = /^[a-f0-9]{32}$/i;
const ASSET_HASH_WITH_EXTENSION_PATTERN = /^([a-f0-9]{32})\.([a-z0-9]+)$/i;

const normalizeArticleState = (state) =>
  String(state || "").toLowerCase() === "public" ? "public" : "private";

const toSafeProjectName = (input) => {
  const normalized = String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\-_\s]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return `article-${Date.now().toString(36)}`;
  return normalized.slice(0, MAX_PROJECT_NAME_LENGTH);
};

const withNameSuffix = (base, suffix) => {
  const suffixText = `-${suffix}`;
  const maxBaseLength = Math.max(1, MAX_PROJECT_NAME_LENGTH - suffixText.length);
  return `${base.slice(0, maxBaseLength)}${suffixText}`;
};

const ensureUniqueProjectName = async (authorid, preferred) => {
  for (let offset = 0; ; offset += 32) {
    const candidates = Array.from({ length: 32 }, (_, index) => {
      const suffix = offset + index;
      return suffix === 0 ? preferred : withNameSuffix(preferred, suffix);
    });
    const existing = await prisma.ow_projects.findMany({
      where: { authorid: Number(authorid), name: { in: candidates } },
      select: { name: true },
    });
    const usedNames = new Set(existing.map(project => project.name));
    const available = candidates.find(candidate => !usedNames.has(candidate));
    if (available) return available;
  }
};

function compactThumbnailRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (ASSET_HASH_PATTERN.test(raw) || ASSET_HASH_WITH_EXTENSION_PATTERN.test(raw)) {
    return raw;
  }

  const directAssetPathMatch = raw.match(/\/assets\/[a-f0-9]{2}\/[a-f0-9]{2}\/([a-f0-9]{32}\.[a-z0-9]+)$/i);
  if (directAssetPathMatch) {
    return directAssetPathMatch[1].toLowerCase();
  }

  return "";
}

// 获取所有公开已发表博客
export const getPosts = async (req, res) => {
  const { author, tag, keyword, sort = "latest", page = 1, limit = 20 } = req.query;
  const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {
    type: "article",
    state: "public",
    AND: [await visibleWhere("project", res.locals.userid)],
  };

  if (author) {
    where.author = { username: author };
  }
  if (tag) {
    where.project_tags = { some: { name: tag } };
  }
  if (keyword) {
    where.OR = [
      { title: { contains: keyword, mode: "insensitive" } },
      { description: { contains: keyword, mode: "insensitive" } },
      { author: { username: { contains: keyword, mode: "insensitive" } } },
      { author: { display_name: { contains: keyword, mode: "insensitive" } } },
    ];
  }

  const orderBy = [];
  if (sort === "latest") orderBy.push({ time: "desc" });
  else if (sort === "popular") orderBy.push({ view_count: "desc" });
  else orderBy.push({ time: "desc" });

  try {
    const posts = await prisma.ow_projects.findMany({
      where,
      skip,
      take,
      orderBy,
      select: projectSelectionFields()
    });

    const projectIds = posts.map(p => String(p.id));
    const configs = await prisma.ow_target_configs.findMany({
      where: {
        target_type: "blog_post",
        target_id: { in: projectIds },
        key: "blog.config",
      },
      select: {
        target_id: true,
        value: true,
      },
    });
    const configMap = configs.reduce((acc, curr) => {
      if (!acc[curr.target_id]) acc[curr.target_id] = {};
      try {
         acc[curr.target_id] = JSON.parse(curr.value || "{}");
      } catch(e) {}
      return acc;
    }, {});

    const authors = await sanitizeProfiles(posts.map(post => post.author), res.locals.userid);
    posts.forEach((post, index) => {
      post.blogConfig = configMap[String(post.id)] || {};
      post.author = authors[index];
    });

    const total = await prisma.ow_projects.count({ where });

    res.json({
      status: "success",
      data: {
        posts,
        total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "获取博客列表失败" });
  }
};

export const getPostsByAuthor = async (req, res) => {
  req.query.author = req.params.username;
  return getPosts(req, res);
};

export const getPostDetail = async (req, res) => {
  const idStr = req.params.id || req.params.slug;
  if (!idStr) return res.status(400).json({ status: "error", message: "缺少ID参数" });

  let id = parseInt(idStr, 10);
  let post = null;

  try {
    if (!isNaN(id)) {
      post = await prisma.ow_projects.findFirst({
        where: {
          id,
          type: "article"
        },
        include: {
          author: {
            select: { id: true, username: true, display_name: true, avatar: true }
          },
          project_tags: true
        }
      });
    }

    if (!post && req.params.username) {
      post = await prisma.ow_projects.findFirst({
        where: {
          name: idStr,
          type: "article",
          author: { username: req.params.username }
        },
        include: {
          author: {
            select: { id: true, username: true, display_name: true, avatar: true }
          },
          project_tags: true
        }
      });
      if (post) {
        id = post.id;
      }
    }

    if (!post) {
      const configs = await prisma.ow_target_configs.findMany({
        where: {
          target_type: "blog_post",
          key: "blog.config",
          value: { contains: `"slug":"${idStr}"` }
        }
      });
      let matchedTargetId = null;
      for (const row of configs) {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed.slug === idStr) {
            matchedTargetId = parseInt(row.target_id, 10);
            break;
          }
        } catch(e) {}
      }

      if (matchedTargetId && !isNaN(matchedTargetId)) {
        id = matchedTargetId;
        post = await prisma.ow_projects.findFirst({
          where: {
            id,
            type: "article",
            ...(req.params.username ? {
              author: { username: req.params.username }
            } : {})
          },
          include: {
            author: {
              select: { id: true, username: true, display_name: true, avatar: true }
            },
            project_tags: true
          }
        });
      }
    }

    let decision;
    if (req.headers?.["x-zerocat-delegation"] !== undefined || (post && post.state !== "public")) {
      decision = await authorizeResourceOperation(res.locals.userid, "blog", post?.id || idStr, "read", resourceAuthorizationContext(req, res));
    }
    if (!post || !await canViewContent("project", post, res.locals.userid, { ignorePrivacy: true }) ||
        (post.state !== "public" && (!decision?.allowed || decision.delegationId != null)
          && post.authorid !== (decision?.principalId ?? Number(res.locals.userid)))) {
      return res.status(404).json({ status: "error", message: "文章不存在" });
    }

    const configRow = await prisma.ow_target_configs.findUnique({
      where: {
        target_type_target_id_key: {
          target_type: "blog_post",
          target_id: String(id),
          key: "blog.config",
        },
      },
      select: {
        value: true,
      },
    });
    let configObj = {};
    if (configRow && configRow.value) {
      try {
        configObj = JSON.parse(configRow.value);
      } catch(e) {}
    }

    const defaultBranch = post.default_branch || "main";
    const [content] = await prisma.$queryRaw`
      SELECT c.commit_file, f.sha256, f.source, f.create_time, f.create_userid,
             f.storage_provider, f.storage_bucket, f.storage_key,
             f.content_size, f.content_sha256, f.content_type
      FROM ow_projects_branch b
      JOIN ow_projects_commits c ON c.id = b.latest_commit_hash
      LEFT JOIN ow_projects_file f ON f.sha256 = c.commit_file
      WHERE b.projectid = ${id} AND b.name = ${defaultBranch}
      LIMIT 1
    `;
    if (content?.commit_file) {
      const { commit_file, ...metadata } = content;
      const file = metadata.sha256 === null ? null : await hydrateProjectFile(metadata);
      post.file = file ? {
        sha256: file.sha256, source: file.source,
        create_time: file.create_time, create_userid: file.create_userid,
      } : null;
    }

    post.blogConfig = configObj;
    post.author = await sanitizePublicUser(post.author, res.locals.userid);
    for (const key of ["is_shadowbanned", "shadowban_expires_at", "shadowban_by", "shadowban_reason", "deleted_at", "deleted_by", "deletion_source", "deletion_reason"]) delete post[key];
    res.json({ status: "success", data: post });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || err.status || 500).json({ status: "error", code: err.code, message: err.statusCode || err.status ? err.message : "查询文章详情失败" });
  }
};

export const updatePostMeta = async (req, res) => {
  const { id } = req.params;
  const { title, summary, state, cover, slug, seo, tags } = req.body;
  const projectId = Number(id);

  try {
    const post = await ensureBlogOwner(req, res, "update");
    if (!post) return res.status(403).json({ status: "error", message: "无权修改或文章不存在" });

    const toUpdate = {};
    if (title !== undefined) toUpdate.title = title;
    if (summary !== undefined) toUpdate.description = summary;
    if (state !== undefined) toUpdate.state = normalizeArticleState(state);
    if (cover !== undefined) toUpdate.thumbnail = compactThumbnailRef(cover);

    if (Object.keys(toUpdate).length > 0) {
      await prisma.ow_projects.update({
        where: { id: projectId },
        data: toUpdate
      });
    }

    if (tags !== undefined && Array.isArray(tags)) {
      const existingTags = await prisma.ow_projects_tags.findMany({
        where: { projectid: projectId },
        select: { id: true, name: true },
      });

      const incomingTags = new Set(tags.filter(Boolean).map(t => String(t).trim()));
      const toDelete = existingTags.filter(t => !incomingTags.has(t.name));
      const existingNames = new Set(existingTags.map(t => t.name));
      const toCreate = Array.from(incomingTags).filter(t => !existingNames.has(t));

      if (toDelete.length > 0) {
        await prisma.ow_projects_tags.deleteMany({
          where: { id: { in: toDelete.map(t => t.id) } },
        });
      }
      if (toCreate.length > 0) {
        await prisma.ow_projects_tags.createMany({
          data: toCreate.map(name => ({ projectid: projectId, name })),
        });
      }
    }

    const newConfig = {
      cover: cover !== undefined ? cover : undefined,
      slug: slug !== undefined ? slug : undefined,
      seo: seo !== undefined ? seo : undefined
    };

    if (Object.keys(newConfig).some(k => newConfig[k] !== undefined)) {
      const existingCfg = await prisma.ow_target_configs.findUnique({
        where: {
          target_type_target_id_key: {
            target_type: "blog_post",
            target_id: String(id),
            key: "blog.config",
          },
        },
        select: {
          value: true,
        },
      });
      let baseJson = {};
      if (existingCfg && existingCfg.value) {
         try { baseJson = JSON.parse(existingCfg.value); } catch(e){}
      }
      const finalJson = { ...baseJson };
      if (cover !== undefined) finalJson.cover = cover;
      if (slug !== undefined) finalJson.slug = slug;
      if (seo !== undefined) finalJson.seo = {...(finalJson.seo || {}), ...seo};

      await prisma.ow_target_configs.upsert({
        where: {
          target_type_target_id_key: {
            target_type: "blog_post",
            target_id: String(id),
            key: "blog.config",
          },
        },
        create: {
          target_type: "blog_post",
          target_id: String(id),
          key: "blog.config",
          value: JSON.stringify(finalJson),
        },
        update: {
          value: JSON.stringify(finalJson),
        },
      });
    }

    res.json({ status: "success", message: "元数据已更新" });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || err.status || 500).json({ status: "error", code: err.code, message: err.statusCode || err.status ? err.message : "修改元数据失败" });
  }
};

export const unpublishPost = async (req, res) => {
  const { id } = req.params;
  const projectId = Number(id);
  try {
    const post = await ensureBlogOwner(req, res, "update");
    if (!post) return res.status(403).json({ status: "error", message: "无权修改或文章不存在" });

    await prisma.ow_projects.update({
      where: { id: projectId },
      data: { state: "private" }
    });

    res.json({ status: "success", message: "已下架此文章" });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || err.status || 500).json({ status: "error", code: err.code, message: err.statusCode || err.status ? err.message : "下架文章失败" });
  }
};

export const createPost = async (req, res) => {
  try {
    const { title, summary, state, cover, slug, seo } = req.body || {};
    const userId = Number(res.locals.userid);
    await assertCanWrite(userId, "blog", "create");
    await assertCanWrite(userId, "projects", "create");

    const preferredName = toSafeProjectName(slug || title || "untitled-post");
    const projectName = await ensureUniqueProjectName(userId, preferredName);

    const normalizedTitle = String(title || "未命名文章").trim() || "未命名文章";
    const normalizedDescription = typeof summary === "string" ? summary : "";
    const normalizedState = normalizeArticleState(state);
    const normalizedCover = compactThumbnailRef(cover);

    const emptySource = "";
    const sourceSha256 = createHash("sha256").update(emptySource).digest("hex");
    // Complete object storage I/O before opening the database transaction.
    await saveProjectFile(emptySource, { userId, sha256: sourceSha256 });

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.ow_projects.create({
        data: {
          name: projectName,
          title: normalizedTitle,
          description: normalizedDescription,
          state: normalizedState,
          type: "article",
          authorid: userId,
          license: "None",
          thumbnail: normalizedCover,
          default_branch: "main",
        },
      });

      const now = Date.now();
      const commitContent = JSON.stringify({
        userid: userId,
        project_id: created.id,
        source_sha256: sourceSha256,
        commit_message: "初始化提交",
        parent_commit: null,
        timestamp: now,
      });
      const commitId = createHash("sha256").update(commitContent).digest("hex");

      await tx.ow_projects_branch.create({
        data: {
          projectid: created.id,
          latest_commit_hash: commitId,
          name: "main",
          creator: userId,
          description: "默认分支",
        },
      });

      await tx.ow_projects_commits.create({
        data: {
          id: commitId,
          project_id: created.id,
          author_id: userId,
          branch: "main",
          commit_file: sourceSha256,
          commit_message: "初始化提交",
          parent_commit_id: null,
          commit_date: new Date(now),
          commit_description: "# 初始化提交",
        },
      });

      if (cover !== undefined || slug !== undefined || seo !== undefined) {
        const configPayload = {
          ...(cover !== undefined ? { cover } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(seo !== undefined ? { seo } : {}),
        };

        await tx.ow_target_configs.upsert({
          where: {
            target_type_target_id_key: {
              target_type: "blog_post",
              target_id: String(created.id),
              key: "blog.config",
            },
          },
          create: {
            target_type: "blog_post",
            target_id: String(created.id),
            key: "blog.config",
            value: JSON.stringify(configPayload),
          },
          update: {
            value: JSON.stringify(configPayload),
          },
        });
      }

      return created;
    });

    res.json({ status: "success", data: project });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "创建博客报错" });
  }
};

export const getRelatedPosts = async (req, res) => {
  try {
     const post = await prisma.ow_projects.findFirst({where: {id: Number(req.params.id), AND: [await visibleWhere("project", res.locals.userid)], OR: [{ state: "public" }, ...(res.locals.userid ? [{ authorid: Number(res.locals.userid) }] : [])]}});
     if (!post) return res.status(404).json({status: "error"});

     const posts = await prisma.ow_projects.findMany({
       where: { type: "article", state: "public", id: { not: post.id }, AND: [await visibleWhere("project", res.locals.userid)] },
       take: 5,
       orderBy: { time: "desc" },
       select: projectSelectionFields()
     });
     res.json({ status: "success", data: await sanitizeProjectAuthors(posts, res.locals.userid) });
  } catch (err) {
     res.status(500).json({ status: "error", message: "Error" });
  }
};
