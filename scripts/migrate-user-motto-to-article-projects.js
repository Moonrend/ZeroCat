#!/usr/bin/env node

import { createHash } from "crypto";
import { pathToFileURL } from "node:url";
import { prisma } from "../apps/api/src/services/prisma.js";
import { saveProjectFile } from "../apps/api/src/services/projectFileStorage.js";
import logger from "../apps/api/src/services/logger.js";
import defaultProject from "../apps/api/src/default_project.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TARGET_TYPE = "article";
const DEFAULT_BRANCH = "main";
const MIGRATION_COMMIT_MESSAGE = "迁移README.md内容";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: null,
    userId: null,
    clearMotto: true,
    concurrency: 8,
    batchSize: 200,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--no-clear-motto") {
      args.clearMotto = false;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      i += 1;
      args.limit = Number(value);
      continue;
    }

    if (arg === "--user-id") {
      const value = argv[i + 1];
      i += 1;
      args.userId = Number(value);
      continue;
    }

    if (arg === "--concurrency") {
      const value = argv[i + 1];
      i += 1;
      args.concurrency = Number(value);
      continue;
    }

    if (arg === "--batch-size") {
      const value = argv[i + 1];
      i += 1;
      args.batchSize = Number(value);
      continue;
    }
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    args.concurrency = 1;
  }
  args.concurrency = Math.floor(args.concurrency);

  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) {
    args.batchSize = 200;
  }
  args.batchSize = Math.floor(args.batchSize);

  if (Number.isFinite(args.limit) && args.limit <= 0) {
    args.limit = null;
  }

  return args;
}

function makeCommitId(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function makeSourceSha(source) {
  return createHash("sha256").update(source).digest("hex");
}

async function createProjectForUser(user, dryRun) {
  const projectName = user.username;

  const existingSameName = await prisma.ow_projects.findFirst({
    where: {
      authorid: user.id,
      name: projectName,
    },
    select: {
      id: true,
      type: true,
      state: true,
      name: true,
      title: true,
      description: true,
      default_branch: true,
      authorid: true,
    },
  });

  if (existingSameName) {
    if (existingSameName.type !== TARGET_TYPE) {
      throw new Error(`用户 ${user.username} 已有同名项目，但类型为 ${existingSameName.type}，无法迁移到 article`);
    }
    return { project: existingSameName, created: false };
  }

  const projectData = {
    type: TARGET_TYPE,
    authorid: user.id,
    title: user.username,
    name: projectName,
    state: "public",
    description: user.username,
    license: "None",
    thumbnail: "",
  };

  if (dryRun) {
    return {
      project: {
        id: -1,
        ...projectData,
        default_branch: null,
      },
      created: true,
    };
  }

  const project = await prisma.ow_projects.create({ data: projectData });

  return { project, created: true };
}

async function ensureInitialized(project, userId, dryRun) {
  const projectId = Number(project.id);
  const firstCommit = await prisma.ow_projects_commits.findFirst({
    where: { project_id: projectId },
    select: { id: true },
  });

  if (firstCommit) {
    return { initialized: false };
  }

  const defaultSource = defaultProject[TARGET_TYPE] || defaultProject[project.type] || EMPTY_SHA256;

  const timestamp = new Date();
  const initCommitPayload = {
    userid: userId,
    project_id: projectId,
    project_branch: DEFAULT_BRANCH,
    source_sha256: defaultSource,
    commit_message: "初始化提交",
    parent_commit: null,
    timestamp,
  };
  const initCommitId = makeCommitId(initCommitPayload);

  if (dryRun) {
    return { initialized: true, initCommitId };
  }

  await prisma.ow_projects_branch.upsert({
    where: {
      projectid_name: {
        projectid: projectId,
        name: DEFAULT_BRANCH,
      },
    },
    create: {
      projectid: projectId,
      latest_commit_hash: initCommitId,
      name: DEFAULT_BRANCH,
      creator: userId,
      description: "默认分支",
    },
    update: {
      latest_commit_hash: initCommitId,
    },
  });

  await prisma.ow_projects_commits.create({
    data: {
      id: initCommitId,
      project_id: projectId,
      author_id: userId,
      branch: DEFAULT_BRANCH,
      commit_file: defaultSource,
      commit_message: "初始化提交",
      parent_commit_id: null,
      commit_date: new Date(timestamp),
      commit_description: "# 初始化提交",
    },
  });

  await prisma.ow_projects.update({
    where: { id: projectId },
    data: { default_branch: DEFAULT_BRANCH },
  });

  return { initialized: true, initCommitId };
}

async function saveSource(source, userId, dryRun) {
  const sha256 = makeSourceSha(source);

  if (!dryRun) {
    await saveProjectFile(source, { userId, sha256, db: prisma });
  }

  return sha256;
}

export async function createMigrationCommit(project, user, motto, dryRun) {
  const projectId = Number(project.id);

  const latestCommit = await prisma.ow_projects_commits.findFirst({
    where: {
      project_id: projectId,
      branch: DEFAULT_BRANCH,
    },
    orderBy: { commit_date: "desc" },
    select: { id: true, commit_file: true, commit_message: true },
  });

  const parentCommitId = latestCommit?.id || null;
  const source = `${motto.trim()}\n`;
  const sourceSha = makeSourceSha(source);

  if (
    latestCommit?.commit_file === sourceSha &&
    latestCommit?.commit_message === MIGRATION_COMMIT_MESSAGE
  ) {
    return { commitId: latestCommit.id, sourceSha, created: false };
  }

  await saveSource(source, user.id, dryRun);
  const timestamp = Date.now();
  const commitPayload = {
    userid: user.id,
    project_id: projectId,
    source_sha256: sourceSha,
    commit_message: MIGRATION_COMMIT_MESSAGE,
    parent_commit: parentCommitId,
    commit_description: "将用户README.md内容迁移到 article 项目",
    timestamp,
  };
  const commitId = makeCommitId(commitPayload);

  if (dryRun) {
    return { commitId, sourceSha, created: true };
  }

  await prisma.ow_projects_commits.create({
    data: {
      id: commitId,
      project_id: projectId,
      author_id: user.id,
      branch: DEFAULT_BRANCH,
      commit_file: sourceSha,
      commit_message: MIGRATION_COMMIT_MESSAGE,
      commit_description: "将用户README.md内容迁移到 article 项目",
      parent_commit_id: parentCommitId,
      commit_date: new Date(timestamp),
    },
  });

  await prisma.ow_projects_branch.upsert({
    where: {
      projectid_name: {
        projectid: projectId,
        name: DEFAULT_BRANCH,
      },
    },
    create: {
      projectid: projectId,
      latest_commit_hash: commitId,
      name: DEFAULT_BRANCH,
      creator: user.id,
      description: "默认分支",
    },
    update: {
      latest_commit_hash: commitId,
    },
  });

  return { commitId, sourceSha, created: true };
}

async function clearUserMotto(userId, dryRun) {
  if (dryRun) return;

  await prisma.ow_users.update({
    where: { id: userId },
    data: { motto: null },
  });
}

async function migrateOneUser(user, options) {
  const motto = String(user.motto || "").trim();
  if (!motto) {
    return { skipped: true, reason: "empty_motto" };
  }

  const { project, created } = await createProjectForUser(user, options.dryRun);
  const initResult = await ensureInitialized(project, user.id, options.dryRun);
  const commitResult = await createMigrationCommit(project, user, motto, options.dryRun);

  if (options.clearMotto) {
    await clearUserMotto(user.id, options.dryRun);
  }

  return {
    skipped: false,
    userId: user.id,
    username: user.username,
    projectId: project.id,
    createdProject: created,
    initializedProject: initResult.initialized,
    createdCommit: commitResult.created,
    commitId: commitResult.commitId,
  };
}

async function processWithConcurrency(users, concurrency, worker) {
  const results = [];
  let index = 0;

  const runner = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= users.length) return;

      const user = users[current];
      const result = await worker(user);
      results.push(result);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, users.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

function buildUserWhere(options) {
  const andConditions = [{ motto: { not: null } }, { motto: { not: "" } }];

  if (options.userId) {
    andConditions.push({ id: options.userId });
  }

  return { AND: andConditions };
}

async function fetchUsersBatch(options, cursorId, remainingLimit) {
  const where = buildUserWhere(options);
  if (cursorId !== null) {
    where.id = { gt: cursorId };
  }

  const takeByLimit = Number.isFinite(remainingLimit) ? remainingLimit : options.batchSize;
  const take = Math.min(options.batchSize, takeByLimit);

  if (take <= 0) {
    return [];
  }

  return prisma.ow_users.findMany({
    where,
    select: {
      id: true,
      username: true,
      display_name: true,
      motto: true,
    },
    orderBy: { id: "asc" },
    take,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  logger.info("[motto-migration] 开始执行用户 motto 迁移到 article 项目");
  logger.info(`[motto-migration] 参数: ${JSON.stringify(options)}`);

  const stats = {
    total: 0,
    processed: 0,
    skipped: 0,
    createdProject: 0,
    initializedProject: 0,
    createdCommit: 0,
    errors: 0,
  };

  let cursorId = null;
  let remainingLimit = options.limit;

  while (true) {
    const users = await fetchUsersBatch(options, cursorId, remainingLimit);
    if (users.length === 0) {
      break;
    }

    stats.total += users.length;
    cursorId = users[users.length - 1].id;
    if (Number.isFinite(remainingLimit)) {
      remainingLimit -= users.length;
    }

    const results = await processWithConcurrency(users, options.concurrency, async (user) => {
      try {
        const result = await migrateOneUser(user, options);

        if (result.skipped) {
          logger.info(`[motto-migration] 跳过用户 ${user.username}: ${result.reason}`);
        } else {
          logger.info(
            `[motto-migration] 完成用户 ${result.username} -> project=${result.projectId}, commit=${result.commitId}`
          );
        }

        return { ok: true, user, result };
      } catch (error) {
        logger.error(`[motto-migration] 用户 ${user.username} 迁移失败:`, error);
        return { ok: false, user, error };
      }
    });

    for (const item of results) {
      if (!item.ok) {
        stats.errors += 1;
        continue;
      }

      const { result } = item;
      if (result.skipped) {
        stats.skipped += 1;
        continue;
      }

      stats.processed += 1;
      if (result.createdProject) stats.createdProject += 1;
      if (result.initializedProject) stats.initializedProject += 1;
      if (result.createdCommit) stats.createdCommit += 1;
    }

    if (Number.isFinite(remainingLimit) && remainingLimit <= 0) {
      break;
    }
  }

  logger.info("[motto-migration] 迁移结束");
  logger.info(`[motto-migration] 统计: ${JSON.stringify(stats)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      logger.error("[motto-migration] 迁移执行异常:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
