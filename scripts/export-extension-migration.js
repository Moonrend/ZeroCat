import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { getExtensionURLs, hasMigratableExtensions, fetchExtensionReferences } from './extension-migration-data.js';
import { prisma } from '../apps/api/src/services/prisma.js';
import { hydrateProjectFiles, PROJECT_FILE_SELECT } from '../apps/api/src/services/projectFileStorage.js';

const OUTPUT_ROOT = path.resolve('migration-output/extensions');
const INLINE_DIR = path.join(OUTPUT_ROOT, 'inline-scripts');
const CSV_PATH = path.join(OUTPUT_ROOT, 'extension-migration.csv');
const BATCH_SIZE = 100;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function randomSuffix() {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

function csvEscape(value) {
  const str = value ?? '';
  if (typeof str !== 'string') {
    return csvEscape(String(str));
  }
  const needsQuotes = str.includes(',') || str.includes('"') || str.includes('\n');
  if (needsQuotes) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function parseDataUrl(dataUrl) {
  const firstComma = dataUrl.indexOf(',');
  if (firstComma === -1) return null;
  const meta = dataUrl.slice(0, firstComma).toLowerCase();
  const payload = dataUrl.slice(firstComma + 1);
  if (meta.includes(';base64')) {
    return Buffer.from(payload, 'base64').toString('utf8');
  }
  try {
    return decodeURIComponent(payload);
  } catch (err) {
    return null;
  }
}

async function processFile(record, references) {
  const { sha256, extensionURLs } = record;
  if (!references) return [];

  const rows = [];
  const { commits, projects } = references;

  for (const [key, value] of Object.entries(extensionURLs)) {
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url) continue;

    const isDataUrl = url.startsWith('data:text/javascript');
    const isTurboWarp = url.startsWith('https://extensions.turbowarp.org');

    if (!isDataUrl && !isTurboWarp) {
      continue;
    }

    let savedFile = '';
    if (isDataUrl) {
      const decoded = parseDataUrl(url);
      if (!decoded) {
        console.warn(`Skip inline extension ${key} of ${sha256}: cannot parse data URL`);
        continue;
      }
      const filename = `${key}-${randomSuffix()}.js`;
      const filePath = path.join(INLINE_DIR, filename);
      await fs.writeFile(filePath, decoded, 'utf8');
      savedFile = path.relative(OUTPUT_ROOT, filePath);
    }

    const commitIds = commits.map((c) => c.id).join('|');
    const projectIds = projects.map((p) => String(p.id)).join('|');
    const projectNames = projects
      .map((p) => (p.title || p.name || '').trim())
      .filter(Boolean)
      .join('|');

    rows.push([
      sha256,
      key,
      isDataUrl ? 'data-url' : 'turbowarp',
      url,
      savedFile,
      commitIds,
      projectIds,
      projectNames,
    ]);
  }

  return rows;
}

export async function loadExportBatch(db, after = null) {
  const rows = await db.ow_projects_file.findMany({
    where: after ? { sha256: { gt: after } } : {},
    take: BATCH_SIZE,
    orderBy: { sha256: 'asc' },
    select: PROJECT_FILE_SELECT,
  });
  return rows.length ? hydrateProjectFiles(rows) : [];
}

async function main() {
  await ensureDir(OUTPUT_ROOT);
  await ensureDir(INLINE_DIR);

  const csvRows = [
    [
      'sha256',
      'extension_key',
      'url_type',
      'url',
      'saved_file',
      'commit_ids',
      'project_ids',
      'project_names',
    ],
  ];

  let cursor = null;
  let processed = 0;
  let matched = 0;

  while (true) {
    const batch = await loadExportBatch(prisma, cursor);

    if (!batch.length) break;

    const prepared = batch.map(record => ({
      sha256: record.sha256,
      extensionURLs: getExtensionURLs(record),
    }));
    const references = await fetchExtensionReferences(prisma, prepared
      .filter(record => hasMigratableExtensions(record.extensionURLs))
      .map(record => record.sha256));

    for (const record of prepared) {
      const rows = await processFile(record, references.get(record.sha256));
      if (rows.length) {
        matched += rows.length;
        csvRows.push(...rows);
      }
      processed += 1;
      if (processed % 100 === 0) {
        console.log(`Scanned ${processed} records, found ${matched} extensions`);
      }
    }

    cursor = batch[batch.length - 1].sha256;
  }

  const csvContent = csvRows.map((row) => row.map(csvEscape).join(',')).join('\n');
  await fs.writeFile(CSV_PATH, csvContent, 'utf8');

  console.log(`Done. Processed ${processed} records, found ${matched} extensions.`);
  console.log(`CSV written to ${CSV_PATH}`);
  console.log(`Inline scripts saved under ${INLINE_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}