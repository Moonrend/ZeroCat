import { pathToFileURL } from 'node:url';

export function calculateDepths(commits) {
    const byId = new Map(commits.map(commit => [commit.id, commit]));
    const depths = new Map();

    for (const commit of commits) {
        const path = [];
        const visiting = new Set();
        let currentId = commit.id;
        while (!depths.has(currentId)) {
            const current = byId.get(currentId);
            // Keep the original depth convention for roots and missing parents.
            if (!current || !current.parent_commit_id) {
                depths.set(currentId, 0);
                break;
            }
            if (visiting.has(currentId)) {
                throw new Error(`提交父链包含循环: ${currentId}`);
            }
            visiting.add(currentId);
            path.push(currentId);
            currentId = current.parent_commit_id;
        }

        let depth = depths.get(currentId);
        for (let index = path.length - 1; index >= 0; index--) {
            depths.set(path[index], ++depth);
        }
    }

    return depths;
}

export async function updateCommitDepths(prisma) {
    const commits = await prisma.ow_projects_commits.findMany({
        select: { id: true, parent_commit_id: true, depth: true },
    });
    const depths = calculateDepths(commits);
    const idsByDepth = new Map();
    for (const commit of commits) {
        const depth = depths.get(commit.id);
        if (commit.depth === depth) continue;
        if (!idsByDepth.has(depth)) idsByDepth.set(depth, []);
        idsByDepth.get(depth).push(commit.id);
    }

    let updated = 0;
    for (const [depth, ids] of idsByDepth) {
        // Bound parameters even when many independent projects share a depth.
        for (let offset = 0; offset < ids.length; offset += 1000) {
            const batch = ids.slice(offset, offset + 1000);
            const result = await prisma.ow_projects_commits.updateMany({
                where: { id: { in: batch } },
                data: { depth },
            });
            if (result.count !== batch.length) {
                throw new Error('更新过程中提交已被删除，请重新运行深度迁移');
            }
            updated += result.count;
        }
    }
    return { total: commits.length, updated };
}

async function main() {
    const { prisma } = await import('../apps/api/src/services/prisma.js');
    try {
        console.log('开始更新提交深度...');
        const { total, updated } = await updateCommitDepths(prisma);
        console.log(`找到 ${total} 个提交，更新 ${updated} 个提交深度`);
        console.log('提交深度更新完成');
    } finally {
        await prisma.$disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error('迁移出错:', error);
        process.exitCode = 1;
    });
}
