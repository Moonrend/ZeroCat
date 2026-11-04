import { createHash } from "crypto";
import { prisma } from "./prisma.js";
import { saveProjectFile } from "./projectFileStorage.js";

export async function createBranchIfNotExists(projectid, branch, userid) {
  let branchRecord = await prisma.ow_projects_branch.findFirst({
    where: { projectid: Number(projectid), name: branch },
  });
  if (!branchRecord) {
    branchRecord = await prisma.ow_projects_branch.create({
      data: {
        name: branch,
        creator: userid,
        description: "",
        latest_commit_hash: "",
        project: { connect: { id: Number(projectid) } },
      },
    });
  }
  return branchRecord;
}

export async function getCommitParentId(projectid, userid, parent_commit, branch) {
  if (/^[a-fA-F0-9]{64}$/.test(parent_commit || "")) {
    const parentCommit = await prisma.ow_projects_commits.findFirst({
      where: { project_id: Number(projectid), id: parent_commit, branch },
    });
    return parentCommit ? parentCommit.id : null;
  }
  const latestCommit = await prisma.ow_projects_commits.findFirst({
    where: { project_id: Number(projectid), branch },
    orderBy: { commit_date: "desc" },
  });
  return latestCommit ? latestCommit.id : null;
}

export async function updateBranchLatestCommit(projectid, branch, commitId) {
  await prisma.ow_projects_branch.update({
    where: { projectid_name: { projectid: Number(projectid), name: branch } },
    data: { latest_commit_hash: commitId },
  });
}

export async function getLatestCommit(projectid, branch = "main") {
  return prisma.ow_projects_commits.findFirst({
    where: { project_id: Number(projectid), branch },
    orderBy: { commit_date: "desc" },
  });
}

export async function writeSourceFile(source, userid) {
  const normalized = typeof source === "string" ? source : String(source ?? "");
  const file = await saveProjectFile(normalized, { userId: userid });
  return file.sha256;
}

export async function createCommit({
  projectid,
  userid,
  branch = "main",
  sha256,
  message = "edit",
  commit_description = "",
  parent_commit = null,
}) {
  await createBranchIfNotExists(projectid, branch, userid);
  const parent_commit_id = await getCommitParentId(projectid, userid, parent_commit, branch);

  const timestamp = Date.now();
  const commitContent = JSON.stringify({
    userid,
    project_id: Number(projectid),
    source_sha256: sha256,
    commit_message: message,
    parent_commit: parent_commit_id,
    commit_description,
    timestamp,
  });
  const commitId = createHash("sha256").update(commitContent).digest("hex");

  const commit = await prisma.ow_projects_commits.create({
    data: {
      id: commitId,
      project_id: Number(projectid),
      author_id: userid,
      branch,
      commit_file: sha256,
      commit_message: message,
      commit_description,
      parent_commit_id,
      commit_date: new Date(timestamp),
    },
  });

  await updateBranchLatestCommit(projectid, branch, commitId);
  return commit;
}
