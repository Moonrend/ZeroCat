import {saveProjectFile} from './projectFileStorage.js';
import {SitemapStream, streamToPromise} from 'sitemap';
import {Readable} from 'stream';
import {createGzip} from 'zlib';
import {prisma} from './prisma.js';
import logger from './logger.js';
import zcconfig from './config/zcconfig.js';
import { visibleWhere } from './moderation/visibility.js';

class SitemapService {
    constructor() {
        this.isGenerating = false;
    }

    async initialize() {
        const enabled = await zcconfig.get('sitemap.enabled');
        if (!enabled) {
            logger.info('[sitemap] Sitemap service is disabled');
            await this.syncQueueSchedule();
            return;
        }

        await this.syncQueueSchedule();
        logger.info('[sitemap] Sitemap service initialized');
    }

    async getUrls() {
        const urls = [];

        try {
            // 获取公开项目
            const projects = await prisma.ow_projects.findMany({
                where: {
                    state: 'public',
                    AND: [await visibleWhere('project'), { author: await visibleWhere('profile') }]
                },
                select: {
                    id: true,
                    name: true,
                    time: true,
                    author: {
                        select: {
                            username: true
                        }
                    }
                },
                orderBy: {time: 'desc'}
            });

            // 获取活跃用户
            const users = await prisma.ow_users.findMany({
                where: {
                    status: 'active',
                    AND: [await visibleWhere('profile')]
                },
                select: {
                    id: true,
                    username: true,
                    loginTime: true
                }
            });

            // 添加项目URL
            for (const project of projects) {
                if (project.author?.username) {
                    urls.push({
                        url: `/${project.author.username}/${project.name}`,
                        changefreq: 'daily',
                        priority: 0.8,
                        lastmod: project.time
                    });
                }
            }

            // 添加用户主页URL
            for (const user of users) {
                urls.push({
                    url: `/${user.username}`,
                    changefreq: 'weekly',
                    priority: 0.7,
                    lastmod: user.loginTime
                });
            }

        } catch (error) {
            logger.error('[sitemap] Error collecting URLs:', error);
            throw error;
        }

        return urls;
    }

    async getCurrentSitemapBuffer() {
        const stream = new SitemapStream({ hostname: await zcconfig.get('urls.frontend'), xmlns: { news: false, xhtml: true, image: true, video: false } });
        const compressed = stream.pipe(createGzip());
        Readable.from(await this.getUrls()).pipe(stream);
        return streamToPromise(compressed);
    }

    async generateSitemap(isIncremental = false) {
        if (this.isGenerating) {
            throw new Error('Sitemap generation already in progress');
        }

        this.isGenerating = true;
        const frontendUrl = await zcconfig.get('urls.frontend');

        try {
            // 创建sitemap流
            const smStream = new SitemapStream({
                hostname: frontendUrl,
                xmlns: {news: false, xhtml: true, image: true, video: false}
            });

            // 使用gzip压缩
            const pipeline = smStream.pipe(createGzip());

            // 获取并写入URL
            const urls = await this.getUrls();
            const stream = Readable.from(urls).pipe(smStream);

            // 获取最终的buffer
            const buffer = await streamToPromise(pipeline);

            // Preserve the Base64 reader contract; new IDs hash the stored text.
            const { sha256: hash } = await saveProjectFile(buffer.toString('base64'), { userId: 1 });

            // 更新配置
            await zcconfig.set('sitemap.current_file_hash', hash);

            if (isIncremental) {
                await zcconfig.set('sitemap.last_incremental_update', new Date().toISOString());
            } else {
                await zcconfig.set('sitemap.last_full_update', new Date().toISOString());
            }

            logger.info(`[sitemap] Generated sitemap with hash: ${hash}`);
            return hash;
        } catch (error) {
            logger.error('[sitemap] Error generating sitemap:', error);
            throw error;
        } finally {
            this.isGenerating = false;
        }
    }

    async generateFullSitemap() {
        return this.generateSitemap(false);
    }

    async generateIncrementalSitemap() {
        return this.generateSitemap(true);
    }

    async getCurrentSitemapHash() {
        return zcconfig.get('sitemap.current_file_hash');
    }

    async getSitemapStatus() {
        const [
            enabled,
            autoUpdate,
            updateCron,
            currentFileHash,
            lastFullUpdate,
            lastIncrementalUpdate
        ] = await Promise.all([
            zcconfig.get('sitemap.enabled'),
            zcconfig.get('sitemap.auto_update'),
            zcconfig.get('sitemap.update_cron'),
            zcconfig.get('sitemap.current_file_hash'),
            zcconfig.get('sitemap.last_full_update'),
            zcconfig.get('sitemap.last_incremental_update')
        ]);

        return {
            enabled,
            autoUpdate,
            updateCron,
            currentFileHash,
            lastFullUpdate,
            lastIncrementalUpdate,
            isGenerating: this.isGenerating,
        };
    }

    async syncQueueSchedule() {
        try {
            const { default: queueManager } = await import('./queue/queueManager.js');
            if (queueManager.isInitialized()) {
                await queueManager.registerRepeatableJobs();
            }
        } catch (error) {
            logger.warn('[sitemap] Failed to sync queue schedule:', error.message);
        }
    }
}

// 创建单例实例
const sitemapService = new SitemapService();
export default sitemapService;
