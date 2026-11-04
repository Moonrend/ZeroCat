import { prisma } from '../prisma.js';
import { readProjectFiles } from '../projectFileStorage.js';

// Keep the latest commit lookup bounded by project count, using the existing
// (project_id, commit_date DESC) index instead of loading each project's history.
export async function loadArticleData(projectIds) {
    const result = new Map();
    const ids = [...new Set(projectIds)];
    for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        const commits = await prisma.$queryRaw`
            SELECT latest.id, latest.project_id, latest.commit_file, latest.commit_date
            FROM unnest(${batch}::int[]) AS requested(project_id)
            CROSS JOIN LATERAL (
                SELECT id, project_id, commit_file, commit_date
                FROM ow_projects_commits
                WHERE project_id = requested.project_id
                ORDER BY commit_date DESC
                LIMIT 1
            ) AS latest
        `;
        if (!commits.length) continue;
        const [fileByHash, tags] = await Promise.all([
            readProjectFiles([...new Set(commits.map(commit => commit.commit_file))]),
            prisma.ow_projects_tags.findMany({
                where: { projectid: { in: commits.map(commit => commit.project_id) } },
                select: { projectid: true, name: true },
            }),
        ]);
        const tagsByProject = new Map();
        for (const tag of tags) {
            if (!tagsByProject.has(tag.projectid)) tagsByProject.set(tag.projectid, []);
            tagsByProject.get(tag.projectid).push({ name: tag.name });
        }
        for (const commit of commits) {
            result.set(commit.project_id, {
                commit,
                source: fileByHash.get(commit.commit_file)?.source || '',
                tags: tagsByProject.get(commit.project_id) || [],
            });
        }
    }
    return result;
}
