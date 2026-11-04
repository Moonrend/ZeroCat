import { prisma } from './prisma.js';

const FIND_NODE_LIMIT = 10000;

// Fork branches can retain source-project commits. Callers authorize the visible project first.
export async function findReachableProjectCommit(projectId, { commitId = null, sha256 = null, branch = null } = {}, { db = prisma } = {}) {
    if (!commitId && !sha256) return null;
    const rows = await db.$queryRaw`
        WITH RECURSIVE reachable AS (
            SELECT c.id, c.parent_commit_id
            FROM ow_projects_commits c
            JOIN ow_projects_branch b ON b.latest_commit_hash = c.id
            WHERE b.projectid = ${Number(projectId)}
                AND b.latest_commit_hash <> ''
                AND (${branch || null}::text IS NULL OR b.name = ${branch || null}::text)
            UNION
            SELECT parent.id, parent.parent_commit_id
            FROM ow_projects_commits parent
            JOIN reachable child ON parent.id = child.parent_commit_id
            WHERE child.parent_commit_id <> ''
        ), bounded AS MATERIALIZED (
            SELECT id FROM reachable LIMIT ${FIND_NODE_LIMIT}
        )
        SELECT c.*
        FROM bounded
        JOIN ow_projects_commits c ON c.id = bounded.id
        WHERE c.id = ${commitId || null}::text OR c.commit_file = ${sha256 || null}::text
        LIMIT 1
    `;
    return rows[0] || null;
}

export async function findProjectCommit(projectId, commitId, branch = null, { db = prisma } = {}) {
    return findReachableProjectCommit(projectId, { commitId, branch }, { db });
}

export async function listReachableCommitIds(heads, { db = prisma } = {}) {
    const uniqueHeads = [...new Set(heads.filter(head => typeof head === 'string' && head.length > 0))];
    if (!uniqueHeads.length) return [];
    const rows = await db.$queryRaw`
        WITH RECURSIVE reachable AS (
            SELECT c.id, c.parent_commit_id
            FROM ow_projects_commits c
            WHERE c.id = ANY(${uniqueHeads}::text[])
            UNION
            SELECT parent.id, parent.parent_commit_id
            FROM ow_projects_commits parent
            JOIN reachable child ON parent.id = child.parent_commit_id
            WHERE child.parent_commit_id <> ''
        )
        SELECT id FROM reachable
    `;
    return rows.map(row => row.id);
}
