export function getExtensionURLs({ sha256, source }) {
    if (!source) return null;
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch {
        console.warn(`Skip ${sha256}: invalid JSON`);
        return null;
    }
    const urls = parsed?.extensionURLs;
    if (!urls || typeof urls !== 'object') return null;
    return urls;
}

export function hasMigratableExtensions(urls) {
    return Object.values(urls || {}).some(value => {
        if (typeof value !== 'string') return false;
        const url = value.trim();
        return url.startsWith('data:text/javascript') || url.startsWith('https://extensions.turbowarp.org');
    });
}

export async function fetchExtensionReferences(prisma, shas) {
    const references = new Map(shas.map(sha => [sha, { commits: [], projects: [] }]));
    if (!references.size) return references;

    const commits = await prisma.ow_projects_commits.findMany({
        where: { commit_file: { in: [...references.keys()] } },
        select: { id: true, project_id: true, commit_file: true },
    });
    const projectIds = [...new Set(commits.map(commit => commit.project_id).filter(Boolean))];
    const projects = [];
    for (let offset = 0; offset < projectIds.length; offset += 1000) {
        projects.push(...await prisma.ow_projects.findMany({
            where: { id: { in: projectIds.slice(offset, offset + 1000) } },
            select: { id: true, name: true, title: true },
        }));
    }

    for (const commit of commits) {
        references.get(commit.commit_file).commits.push({ id: commit.id, project_id: commit.project_id });
    }
    for (const reference of references.values()) {
        const ids = new Set(reference.commits.map(commit => commit.project_id));
        reference.projects = projects.filter(project => ids.has(project.id));
    }
    return references;
}
