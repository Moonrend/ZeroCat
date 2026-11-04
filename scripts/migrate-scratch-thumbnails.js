#!/usr/bin/env node

/**
 * Scratch Thumbnails Migration Tool
 *
 * This tool migrates existing scratch thumbnails from scratch_slt/ directory
 * to the new thumbnail format with proper compression, conversion to webp,
 * and MD5-based naming.
 *
 * Source format: scratch_slt/{projectid}
 * Target format: assets/{hash[0:2]}/{hash[2:4]}/{hash}.webp
 * Database: Updates ow_projects.thumbnail field with {hash}.webp
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../apps/api/src/services/prisma.js';
import { processImage, generateMD5, uploadToS3 } from '../apps/api/src/services/assets.js';
import zcconfig from '../apps/api/src/services/config/zcconfig.js';
import logger from '../apps/api/src/services/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ScratchThumbnailMigrator {
    constructor() {
        this.s3Client = null;
        this.bucketName = null;
        this.sourcePrefix = 'scratch_slt/';
        this.dryRun = false;
        this.stats = {
            total: 0,
            processed: 0,
            skipped: 0,
            errors: 0,
            projectNotFound: 0
        };
    }

    async initialize() {
        try {
            // Initialize zcconfig
            await zcconfig.initialize();

            // Get S3 configuration
            const s3Config = {
                endpoint: await zcconfig.get('s3.endpoint'),
                region: await zcconfig.get('s3.region'),
                credentials: {
                    accessKeyId: await zcconfig.get('s3.AWS_ACCESS_KEY_ID'),
                    secretAccessKey: await zcconfig.get('s3.AWS_SECRET_ACCESS_KEY')
                }
            };

            this.bucketName = await zcconfig.get('s3.bucket');

            // Validate configuration
            if (!s3Config.endpoint || !s3Config.region || !s3Config.credentials.accessKeyId ||
                !s3Config.credentials.secretAccessKey || !this.bucketName) {
                throw new Error('S3配置不完整，请检查zcconfig中的S3相关配置');
            }

            // Initialize S3 client
            this.s3Client = new S3Client(s3Config);

            logger.info('[缩略图迁移] S3客户端初始化完成');
            logger.info(`[缩略图迁移] 存储桶: ${this.bucketName}`);
            logger.info(`[缩略图迁移] 源路径: ${this.sourcePrefix}`);

            return true;
        } catch (error) {
            logger.error('[缩略图迁移] 初始化失败:', error);
            throw error;
        }
    }

    /**
     * List all thumbnails in scratch_slt directory
     */
    async listScratchThumbnails() {
        const thumbnails = [];
        let continuationToken = null;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: this.sourcePrefix,
                ContinuationToken: continuationToken
            });

            try {
                const response = await this.s3Client.send(command);

                if (response.Contents) {
                    for (const object of response.Contents) {
                        // Skip directories
                        if (object.Key.endsWith('/')) {
                            continue;
                        }

                        // Extract project ID from path (scratch_slt/{projectid})
                        const projectId = object.Key.replace(this.sourcePrefix, '');

                        // Skip if projectId is not a valid number
                        if (!/^\d+$/.test(projectId)) {
                            logger.warn(`[缩略图迁移] 跳过无效项目ID: ${projectId}`);
                            continue;
                        }

                        thumbnails.push({
                            key: object.Key,
                            projectId: parseInt(projectId),
                            size: object.Size,
                            lastModified: object.LastModified
                        });
                    }
                }

                continuationToken = response.NextContinuationToken;
            } catch (error) {
                logger.error('[缩略图迁移] 列举缩略图失败:', error);
                throw error;
            }
        } while (continuationToken);

        return thumbnails;
    }

    /**
     * Download image from S3
     */
    async downloadImage(key) {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key
            });

            const response = await this.s3Client.send(command);

            // Convert stream to buffer
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }

            return Buffer.concat(chunks);
        } catch (error) {
            logger.error(`[缩略图迁移] 下载图片失败 ${key}:`, error);
            throw error;
        }
    }

    /**
     * Check if project exists in database
     */
    async checkProjectExists(projectId) {
        try {
            const project = await prisma.ow_projects.findUnique({
                where: { id: projectId },
                select: { id: true, title: true, thumbnail: true }
            });

            return project;
        } catch (error) {
            logger.error(`[缩略图迁移] 检查项目存在性失败 ${projectId}:`, error);
            return null;
        }
    }

    /**
     * Update project thumbnail in database
     */
    async updateProjectThumbnail(projectId, thumbnailFilename) {
        try {
            if (!this.dryRun) {
                await prisma.ow_projects.update({
                    where: { id: projectId },
                    data: { thumbnail: thumbnailFilename }
                });
            }

            logger.info(`[缩略图迁移] ${this.dryRun ? '[DRY RUN] ' : ''}更新项目缩略图字段: ${projectId} -> ${thumbnailFilename}`);
            return true;
        } catch (error) {
            logger.error(`[缩略图迁移] 更新项目缩略图字段失败 ${projectId}:`, error);
            return false;
        }
    }

    /**
     * Process a single thumbnail
     */
    async processThumbnail(thumbnail, prefetchedProject) {
        try {
            const { key, projectId } = thumbnail;

            logger.info(`[缩略图迁移] 处理项目 ${projectId} 的缩略图...`);

            // Check if project exists
            const project = prefetchedProject === undefined
                ? await this.checkProjectExists(projectId)
                : prefetchedProject;
            if (!project) {
                logger.warn(`[缩略图迁移] 项目不存在，跳过: ${projectId}`);
                this.stats.projectNotFound++;
                return;
            }

            // Check if project already has a new thumbnail
            if (project.thumbnail && project.thumbnail.includes('.webp')) {
                logger.info(`[缩略图迁移] 项目已有新格式缩略图，跳过: ${projectId} (${project.thumbnail})`);
                this.stats.skipped++;
                return;
            }

            // Download original image
            logger.info(`[缩略图迁移] 下载原始缩略图: ${key}`);
            const originalBuffer = await this.downloadImage(key);

            if (!originalBuffer || originalBuffer.length === 0) {
                logger.error(`[缩略图迁移] 下载的图片为空: ${key}`);
                this.stats.errors++;
                return;
            }

            // Process image: compress to 758x576, convert to webp, highest quality
            logger.info(`[缩略图迁移] 处理图片: ${projectId}`);
            const imageResult = await processImage(originalBuffer, {
                width: 758,
                height: 576,
                format: 'webp',
                quality: 100, // 最高质量
                sanitize: true
            });

            // Generate MD5 hash
            const md5Hash = generateMD5(imageResult.buffer);
            const thumbnailFilename = `${md5Hash}.webp`;

            // Upload to new location
            const s3Key = `assets/${md5Hash.substring(0, 2)}/${md5Hash.substring(2, 4)}/${thumbnailFilename}`;

            if (!this.dryRun) {
                logger.info(`[缩略图迁移] 上传新缩略图: ${s3Key}`);
                await uploadToS3(imageResult.buffer, s3Key, 'image/webp');
            } else {
                logger.info(`[缩略图迁移] [DRY RUN] 模拟上传: ${s3Key}`);
            }

            // Update database
            const updateSuccess = await this.updateProjectThumbnail(projectId, thumbnailFilename);

            if (updateSuccess) {
                this.stats.processed++;
                logger.info(`[缩略图迁移] 处理成功: 项目 ${projectId}, 缩略图 ${thumbnailFilename}`);
                logger.debug(`[缩略图迁移] 处理详情: {
                    projectId: ${projectId},
                    originalSize: ${originalBuffer.length},
                    processedSize: ${imageResult.size},
                    compressionRatio: ${(imageResult.compressionRatio * 100).toFixed(2)}%,
                    dimensions: ${imageResult.width}x${imageResult.height},
                    hash: ${md5Hash}
                }`);
            } else {
                this.stats.errors++;
            }

        } catch (error) {
            logger.error(`[缩略图迁移] 处理缩略图失败: 项目 ${thumbnail.projectId}`, error);
            this.stats.errors++;
        }
    }

    /**
     * Run the migration
     */
    async migrate(options = {}) {
        this.dryRun = options.dryRun || false;

        try {
            logger.info(`[缩略图迁移] 开始迁移${this.dryRun ? ' (DRY RUN 模式)' : ''}`);

            // List all scratch thumbnails
            logger.info('[缩略图迁移] 列举scratch缩略图...');
            const thumbnails = await this.listScratchThumbnails();
            this.stats.total = thumbnails.length;

            logger.info(`[缩略图迁移] 找到 ${thumbnails.length} 个缩略图`);

            if (thumbnails.length === 0) {
                logger.info('[缩略图迁移] 没有找到需要迁移的缩略图');
                return;
            }

            // Process thumbnails in batches to avoid overwhelming S3
            const batchSize = 5; // Smaller batch size since image processing is intensive
            for (let i = 0; i < thumbnails.length; i += batchSize) {
                const batch = thumbnails.slice(i, i + batchSize);
                let projects;
                try {
                    const rows = await prisma.ow_projects.findMany({
                        where: { id: { in: [...new Set(batch.map(thumbnail => thumbnail.projectId))] } },
                        select: { id: true, title: true, thumbnail: true },
                    });
                    projects = new Map(rows.map(project => [project.id, project]));
                } catch (error) {
                    // Preserve per-project error handling if a batch cannot be loaded.
                    logger.warn('[缩略图迁移] 批量检查项目失败，逐个检查:', error);
                }
                const promises = batch.map(thumbnail => this.processThumbnail(thumbnail,
                    projects ? projects.get(thumbnail.projectId) || null : undefined));

                await Promise.all(promises);

                logger.info(`[缩略图迁移] 进度: ${Math.min(i + batchSize, thumbnails.length)}/${thumbnails.length}`);

                // Delay between batches for image processing
                if (i + batchSize < thumbnails.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Print final statistics
            logger.info('[缩略图迁移] 迁移完成');
            logger.info(`[缩略图迁移] 统计信息:`);
            logger.info(`  - 总缩略图数: ${this.stats.total}`);
            logger.info(`  - 已处理: ${this.stats.processed}`);
            logger.info(`  - 已跳过: ${this.stats.skipped}`);
            logger.info(`  - 项目不存在: ${this.stats.projectNotFound}`);
            logger.info(`  - 错误数: ${this.stats.errors}`);

        } catch (error) {
            logger.error('[缩略图迁移] 迁移过程中发生错误:', error);
            throw error;
        }
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run') || args.includes('-d');
    const help = args.includes('--help') || args.includes('-h');

    if (help) {
        console.log(`
Scratch Thumbnails Migration Tool

用法:
  node migrate-scratch-thumbnails.js [选项]

选项:
  --dry-run, -d    执行预演模式，不实际处理文件和更新数据库
  --help, -h       显示帮助信息

说明:
  此工具将 scratch_slt/ 目录下的所有缩略图迁移到新的格式：

  1. 压缩图片为 758x576 像素
  2. 转换为 webp 格式，保持最高质量
  3. 生成 MD5 哈希值重命名
  4. 上传到新的目录结构: assets/{hash[0:2]}/{hash[2:4]}/{hash}.webp
  5. 更新数据库 ow_projects.thumbnail 字段

  源格式: scratch_slt/{projectid}
  目标格式: assets/{hash[0:2]}/{hash[2:4]}/{hash}.webp

  注意: 会自动跳过不存在的项目和已经迁移过的缩略图
`);
        process.exit(0);
    }

    const migrator = new ScratchThumbnailMigrator();

    try {
        await migrator.initialize();
        await migrator.migrate({ dryRun });
    } catch (error) {
        logger.error('[缩略图迁移] 程序执行失败:', error);
        process.exit(1);
    }
}


if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().catch(error => {
        console.error('程序异常退出:', error);
        process.exit(1);
    });
}

export default ScratchThumbnailMigrator;