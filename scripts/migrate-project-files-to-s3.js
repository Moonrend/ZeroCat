#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULTS = { dryRun: true, batchSize: 50, concurrency: 4, limit: null, after: null };

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数`);
    }
    return number;
}

function normalizeOptions(options = {}) {
    const result = { ...DEFAULTS, ...options };
    if (typeof result.dryRun !== 'boolean') throw new Error('dryRun 必须是布尔值');
    result.batchSize = positiveInteger(result.batchSize, '--batch-size', 1000);
    result.concurrency = positiveInteger(result.concurrency, '--concurrency', 32);
    if (result.limit !== null) result.limit = positiveInteger(result.limit, '--limit');
    if (result.after !== null && (typeof result.after !== 'string' || !/^[a-f0-9]{64}$/.test(result.after))) {
        throw new Error('--after 必须是 64 位小写 SHA256');
    }
    return result;
}

export function parseMigrationOptions(argv) {
    const options = {};
    let apply = false;
    let dryRun = false;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--apply') apply = true;
        else if (arg === '--dry-run') dryRun = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else {
            const key = { '--batch-size': 'batchSize', '--concurrency': 'concurrency', '--limit': 'limit', '--after': 'after' }[arg];
            if (!key) throw new Error(`未知参数: ${arg}`);
            const value = argv[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
            options[key] = value;
        }
    }
    if (apply && dryRun) throw new Error('--apply 与 --dry-run 不能同时使用');
    return normalizeOptions({ ...options, dryRun: !apply });
}

// Storage details and source clearing belong to migrateLegacyProjectFile.
export async function migrateProjectFiles({ db, migrate, select, options = {}, onProgress = () => {}, onError = () => {} }) {
    const config = normalizeOptions(options);
    let cursor = config.after;
    const summary = {
        dryRun: config.dryRun, scanned: 0, migrated: 0, skipped: 0, planned: 0, failed: 0,
        lastScanned: cursor, resumeAfter: cursor,
    };
    let checkpointBlocked = false;

    while (config.limit === null || summary.scanned < config.limit) {
        const remaining = config.limit === null ? config.batchSize : config.limit - summary.scanned;
        const rows = await db.ow_projects_file.findMany({
            where: { source: { not: null }, ...(cursor ? { sha256: { gt: cursor } } : {}) },
            orderBy: { sha256: 'asc' },
            take: Math.min(config.batchSize, remaining),
            ...(select ? { select } : {}),
        });
        if (!rows.length) break;

        const checkpointSafe = new Array(rows.length).fill(false);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < rows.length) {
                const index = nextIndex++;
                const row = rows[index];
                try {
                    const result = await migrate(row, { db, dryRun: config.dryRun });
                    if (result?.sha256 !== row.sha256 || !['migrated', 'skipped', 'dry-run'].includes(result.status)) {
                        throw new Error('正文存储服务返回了无效迁移结果');
                    }
                    summary[result.status === 'dry-run' ? 'planned' : result.status]++;
                    // A skipped CAS may leave a changed legacy body for a later run.
                    checkpointSafe[index] = result.status !== 'skipped';
                } catch (error) {
                    summary.failed++;
                    onError({ sha256: row.sha256, error });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(config.concurrency, rows.length) }, worker));

        // Never resume past a failed or concurrently changed row.
        for (let index = 0; index < rows.length; index++) {
            if (!checkpointSafe[index]) checkpointBlocked = true;
            if (!checkpointBlocked) summary.resumeAfter = rows[index].sha256;
        }
        summary.scanned += rows.length;
        cursor = rows.at(-1).sha256;
        summary.lastScanned = cursor;
        onProgress({ ...summary });
    }
    return summary;
}

const HELP = `迁移项目正文到私有 S3（默认仅预演）

用法: migrate-project-files-to-s3.js [选项]
  --dry-run          检查历史正文，不上传或修改数据库（默认）
  --apply            上传、验证正文并清空数据库中的历史正文
  --batch-size N     每页记录数，1-1000，默认 50
  --concurrency N    同时处理的记录数，1-32，默认 4
  --limit N          本次最多检查的记录数（包括失败和跳过）
  --after SHA256     从该 SHA256 之后继续，使用上次 apply 的 resumeAfter
  --help, -h         显示帮助

失败记录会保留原文并逐条记录。失败时退出码为 1。
重新执行会自动排除已清空正文的记录；不要用 lastScanned 跳过失败记录。`;

async function loadDependencies() {
    const [{ prisma }, { migrateLegacyProjectFile, PROJECT_FILE_SELECT }] = await Promise.all([
        import('../apps/api/src/services/prisma.js'),
        import('../apps/api/src/services/projectFileStorage.js'),
    ]);
    return { db: prisma, migrate: migrateLegacyProjectFile, select: PROJECT_FILE_SELECT };
}

export async function runMigrationCli(argv, { load = loadDependencies, log = console } = {}) {
    let dependencies;
    try {
        const options = parseMigrationOptions(argv);
        if (options.help) {
            log.log(HELP);
            return 0;
        }
        dependencies = await load();
        const summary = await migrateProjectFiles({
            ...dependencies,
            options,
            onProgress: progress => log.log(`[project-files] ${JSON.stringify(progress)}`),
            onError: ({ sha256, error }) => log.error(`[project-files] ${sha256}: ${error.message}`),
        });
        log.log(`[project-files] 完成 ${JSON.stringify(summary)}`);
        return summary.failed ? 1 : 0;
    } catch (error) {
        log.error(`[project-files] 迁移失败: ${error.message}`);
        return 1;
    } finally {
        if (dependencies?.db?.$disconnect) await dependencies.db.$disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runMigrationCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[project-files] ${error.message}`);
        process.exitCode = 1;
    });
}
