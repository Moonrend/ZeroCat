import { prisma } from '../../prisma.js';
import { buildContext, getAdminEmail } from './notifyContext.js';
import { getEnabledProviders } from './providers/index.js';
import logger from '../../logger.js';
import { canViewContent, assertCanWrite, sanitizeProfiles } from '../../moderation/visibility.js';

/**
 * 通知编排服务
 *
 * 所有渠道平等对待，仅根据开关决定是否发送，无兜底逻辑。
 *
 * 管理员通知: 遍历所有已启用渠道发送
 * 回复通知:   遍历所有已启用渠道发送 + 站内信（邮箱匹配站内用户时始终发送）
 */
const notifyService = {
    /**
     * 主入口：分发通知
     */
    async run(type, comment, spaceConfig, spaceCuid, log) {
        const jobLog = log || (() => {});
        comment = await prisma.ow_comment_service.findUnique({ where: { id: Number(comment.id) } });
        if (!comment || !await canViewContent('comment_service', comment, null)) {
            return { skipped: true, reason: 'comment_unavailable' };
        }
        if (comment.account_user_id) {
            try {
                await assertCanWrite(Number(comment.account_user_id), 'comments', 'sync');
            } catch (error) {
                if (error.statusCode === 403 || error.status === 403) return { skipped: true, reason: 'actor_restricted' };
                throw error;
            }
        }

        // 查找父评论
        let parent = null;
        if (comment.pid) {
            parent = await prisma.ow_comment_service.findUnique({
                where: { id: parseInt(comment.pid) },
            });
        }

        if (parent && !await canViewContent('comment_service', parent, null)) {
            return { skipped: true, reason: 'parent_unavailable' };
        }

        const records = [comment, parent].filter(record => record?.account_user_id);
        const profiles = await sanitizeProfiles(records.map(record => ({ id: record.account_user_id })));
        for (const [index, record] of records.entries()) {
            if (!profiles[index]) {
                record.nick = '用户';
                record.mail = null;
                record.link = null;
            }
        }

        // 构建标准化上下文
        const context = await buildContext(comment, parent, spaceConfig, spaceCuid);
        context._adminEmail = await getAdminEmail(spaceConfig, spaceCuid);

        switch (type) {
            case 'admin_new_comment':
                return this._handleAdminNotify(context, spaceConfig, jobLog);
            case 'reply_notification':
                return this._handleReplyNotify(comment, parent, context, spaceConfig, spaceCuid, jobLog);
            default:
                await jobLog(`Unknown notification type: ${type}`);
                return { skipped: true, reason: 'unknown_type' };
        }
    },

    /**
     * 管理员新评论通知 — 遍历所有已启用渠道，无兜底
     */
    async _handleAdminNotify(context, spaceConfig, jobLog) {
        const providers = getEnabledProviders(spaceConfig);
        if (providers.length === 0) {
            await jobLog('No notification channel enabled, skipping');
            return { skipped: true, reason: 'no_channel_enabled' };
        }

        const results = [];
        for (const provider of providers) {
            try {
                const result = await provider.send('admin_new_comment', context, spaceConfig);
                results.push({ provider: provider.name, ...result });
                if (result.success) {
                    await jobLog(`[${provider.name}] Sent successfully`);
                } else {
                    await jobLog(`[${provider.name}] Failed: ${result.error}`);
                }
            } catch (err) {
                results.push({ provider: provider.name, success: false, error: err.message });
                await jobLog(`[${provider.name}] Error: ${err.message}`);
            }
        }

        logger.debug('[notify] Admin notify results:', JSON.stringify(results));
        return { results };
    },

    /**
     * 回复通知 — 已启用渠道 + 站内信
     */
    async _handleReplyNotify(comment, parent, context, spaceConfig, spaceCuid, jobLog) {
        if (spaceConfig.disableAuthorNotify === 'true') {
            await jobLog('Author notify disabled');
            return { skipped: true, reason: 'notify_disabled' };
        }

        if (comment.status !== 'approved') {
            await jobLog(`Comment status is '${comment.status}', skip reply notify`);
            return { skipped: true, reason: 'not_approved' };
        }

        if (!parent) {
            await jobLog('No parent comment');
            return { skipped: true, reason: 'no_parent' };
        }

        // 自回复跳过
        if (comment.account_user_id && parent.account_user_id && comment.account_user_id === parent.account_user_id) {
            await jobLog('Self-reply (same user_id)');
            return { skipped: true, reason: 'self_reply' };
        }
        if (comment.mail && parent.mail && comment.mail === parent.mail) {
            await jobLog('Self-reply (same mail)');
            return { skipped: true, reason: 'self_reply' };
        }

        const results = [];

        // 1) 遍历所有已启用渠道发送回复通知
        const providers = getEnabledProviders(spaceConfig);
        for (const provider of providers) {
            try {
                const result = await provider.send('reply_notification', context, spaceConfig);
                results.push({ provider: provider.name, ...result });
                if (result.success) {
                    await jobLog(`[${provider.name}] Reply sent`);
                } else {
                    await jobLog(`[${provider.name}] Reply failed: ${result.error}`);
                }
            } catch (err) {
                results.push({ provider: provider.name, success: false, error: err.message });
                await jobLog(`[${provider.name}] Reply error: ${err.message}`);
            }
        }

        // 2) 站内信：通过可信父评论账号归属发送
        const inappResult = await this._sendInAppNotification(comment, parent, context, spaceCuid, jobLog);
        if (inappResult) results.push({ provider: 'inapp', ...inappResult });

        logger.debug('[notify] Reply notify results:', JSON.stringify(results));
        return { results };
    },

    /**
     * 站内信：通过可信父评论账号归属创建 ow_notifications 记录
     */
    async _sendInAppNotification(comment, parent, context, spaceCuid, jobLog) {
        if (!parent?.account_user_id) return null;

        try {
            const user = await prisma.ow_users.findFirst({
                where: { id: Number(parent.account_user_id) },
                select: { id: true },
            });

            if (!user) {
                await jobLog('[inapp] Parent email not matched to site user');
                return null;
            }

            const { self, site } = context;

            await prisma.ow_notifications.create({
                data: {
                    user_id: user.id,
                    title: `${self.nick} 回复了您的评论`,
                    content: self.comment || '(empty)',
                    link: site.postUrl,
                    notification_type: 'comment_reply',
                    actor_id: comment.account_user_id ? Number(comment.account_user_id) : null,
                    target_type: 'comment_service',
                    target_id: comment.id,
                    data: { spaceCuid, commentId: comment.id, parentId: parent.id },
                    push_channels: ['browser'],
                    push_results: {},
                    push_error: false,
                    read: false,
                },
            });

            await jobLog(`[inapp] Notification created for user #${user.id}`);
            return { success: true, userId: user.id };
        } catch (err) {
            await jobLog(`[inapp] Error: ${err.message}`);
            logger.error('[notify:inapp] Failed:', err.message);
            return { success: false, error: err.message };
        }
    },
};

export default notifyService;
