import express from 'express';
import {prisma} from "../services/prisma.js";
import logger from "../services/logger.js";
import {UAParser} from 'ua-parser-js';
import ipLocation from '../services/ip/ipLocation.js';

const router = express.Router();

// URL 解析函数
function parseURL(url) {
    try {
        if (!url) return {};
        const urlObj = new URL(url);
        return {
            path: urlObj.pathname,
            query: urlObj.search || null,
            domain: urlObj.hostname,
        };
    } catch (error) {
        logger.error('[analytics] Failed to parse URL:', error);
        return {
            path: url,
            query: null,
            domain: null,
        };
    }
}

// UA 解析函数
function parseUserAgent(userAgent) {
    try {
        const parser = new UAParser(userAgent);
        const result = parser.getResult();

        return {
            browser: result.browser.name || null,
            browser_version: result.browser.version || null,
            os: result.os.name || null,
            os_version: result.os.version || null,
            device_type: result.device.type || 'desktop',
            device_vendor: result.device.vendor || null,
        };
    } catch (error) {
        logger.error('[analytics] Failed to parse User-Agent:', error);
        return {};
    }
}

// IP 地理位置解析函数
async function parseIpLocation(ip) {
    try {
        const result = await ipLocation.getIPLocation(ip);
        return {
            country: result.most_specific_country_or_region || null,
            region: result.address || null,
            city: result.most_specific_country_or_region || null,
            timezone: result.location?.timeZone || null
        };
    } catch (error) {
        logger.error('[analytics] Failed to parse IP location:', error);
        return {
            country: null,
            region: null,
            city: null,
            timezone: null
        };
    }
}

// 统一的数据发送接口
router.post('/send', async (req, res) => {
    try {
        const {
            fingerprint,
            hostname,
            screen,
            language,
            url,
            referrer,
            page_title,
            target_type,
            target_id,
        } = req.body;

        const userAgent = req.headers['user-agent'];
        const uaInfo = parseUserAgent(userAgent);
        const ipInfo = await parseIpLocation(req.ip);

        // 解析 URL 和 referrer
        const urlInfo = parseURL(url);
        const referrerInfo = parseURL(referrer);

        // 获取当前用户ID（如果已登录）
        const currentUserId = res.locals.userid !== 0 ? res.locals.userid : null;

        // 事务处理确保数据一致性
        await prisma.$transaction(async (tx) => {
            const deviceData = {
                hostname,
                screen,
                language,
                browser: uaInfo.browser,
                browser_version: uaInfo.browser_version,
                os: uaInfo.os,
                os_version: uaInfo.os_version,
                device_type: uaInfo.device_type,
                device_vendor: uaInfo.device_vendor,
                user_agent: userAgent,
            };

            let device;

            if (currentUserId) {
                // 已登录用户使用原子 upsert，避免并发请求导致唯一键冲突
                device = await tx.ow_analytics_device.upsert({
                    where: {
                        fingerprint_user_id: {
                            fingerprint,
                            user_id: currentUserId
                        }
                    },
                    update: {
                        ...deviceData,
                        last_seen: new Date(),
                    },
                    create: {
                        fingerprint,
                        user_id: currentUserId,
                        ...deviceData,
                    },
                    select: { id: true },
                });
            } else {
                // 未登录用户沿用匿名设备记录
                device = await tx.ow_analytics_device.findFirst({
                    where: {
                        fingerprint,
                        user_id: null
                    },
                    select: { id: true },
                });

                if (device) {
                    device = await tx.ow_analytics_device.update({
                        where: {id: device.id},
                        data: {
                            ...deviceData,
                            last_seen: new Date(),
                        },
                        select: { id: true },
                    });
                } else {
                    device = await tx.ow_analytics_device.create({
                        data: {
                            fingerprint,
                            user_id: null,
                            ...deviceData,
                        },
                        select: { id: true },
                    });
                }
            }

            // 创建事件记录
            await tx.ow_analytics_event.create({
                data: {
                    device_id: device.id,
                    user_id: currentUserId,
                    url,
                    url_path: urlInfo.path,
                    url_query: urlInfo.query,
                    referrer,
                    referrer_domain: referrerInfo.domain,
                    referrer_path: referrerInfo.path,
                    referrer_query: referrerInfo.query,
                    page_title,
                    target_type,
                    target_id: Number(target_id),
                    ip_address: req.ip,
                    country: ipInfo.country,
                    region: ipInfo.region,
                    city: ipInfo.city,
                    timezone: ipInfo.timezone,
                },
                select: { id: true },
            });
        });

        res.json({success: true});
    } catch (error) {
        logger.error('[analytics] Failed to record analytics data:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

// 获取统计数据
router.get('/stats', async (req, res) => {
    try {
        const {start_at, end_at, fingerprint, user_id} = req.query;

        const where = {
            created_at: {
                gte: new Date(start_at),
                lte: new Date(end_at),
            }
        };

        if (fingerprint) {
            where.device = {
                fingerprint
            };
        }

        if (user_id) {
            where.user_id = parseInt(user_id);
        }

        const events = await prisma.ow_analytics_event.findMany({
            where,
            include: {
                device: true
            }
        });

        res.json({success: true, data: events});
    } catch (error) {
        logger.error('[analytics] Failed to get stats:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

export default router;