/**
 * Gorse 推荐系统服务模块
 *
 * 提供与 Gorse 推荐引擎的集成：
 * - 用户/物品插入与更新
 * - 用户反馈(feedback)上报
 * - 个性化推荐获取
 * - 全量同步管理
 */
import { Gorse } from 'gorsejs';
import zcconfig from './config/zcconfig.js';
import logger from './logger.js';
import { prisma } from './prisma.js';
import { visibleWhere, canViewContent } from './moderation/visibility.js';
import { activeRestrictionWhere } from './moderation/restrictions.js';

const PUBLIC_MODELS = { post: 'ow_posts', project: 'ow_projects', profile: 'ow_users' };

async function filterPublicRecords(kind, records) {
    const ids = [...new Set((records || []).filter(Boolean).map(record => Number(record.id))
        .filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return [];
    const visibility = await visibleWhere(kind);
    const allowed = new Set();
    for (let start = 0; start < ids.length; start += 500) {
        const rows = await prisma[PUBLIC_MODELS[kind]].findMany({
            where: { id: { in: ids.slice(start, start + 500) }, AND: [visibility] },
            select: { id: true },
        });
        for (const row of rows) allowed.add(row.id);
    }
    return (records || []).filter(record => record && allowed.has(Number(record.id)));
}
import * as embeddingService from './embedding.js';

async function feedbackIsPublic(userId, itemId) {
    if (!await canViewContent('activity', { actor_id: Number(userId) }, null)) return false;
    const match = String(itemId).match(/^(post|project|user)_(\d+)$/);
    if (!match) return false;
    const kind = match[1] === 'user' ? 'profile' : match[1];
    const model = { post: 'ow_posts', project: 'ow_projects', profile: 'ow_users' }[kind];
    const record = await prisma[model].findUnique({ where: { id: Number(match[2]) } });
    return Boolean(record && await canViewContent(kind, record, null) && (kind !== 'project' || record.state === 'public'));
}

async function filterPublicFeedbacks(rows, userId, itemId) {
    if (!rows.length) return [];
    const entries = rows.map(row => {
        const match = String(itemId(row)).match(/^(post|project|user)_(\d+)$/);
        return match ? { row, actorId: Number(userId(row)),
            kind: match[1] === 'user' ? 'profile' : match[1], id: Number(match[2]) } : null;
    }).filter(Boolean);
    if (!entries.length) return [];
    const actorIds = [...new Set(entries.map(entry => entry.actorId))];
    const hidden = new Set();
    for (let start = 0; start < actorIds.length; start += 500) {
        const rules = await prisma.ow_user_restrictions.findMany({
            where: { user_id: { in: actorIds.slice(start, start + 500) }, ...activeRestrictionWhere('shadowban', 'activity') },
            select: { user_id: true },
        });
        for (const rule of rules) hidden.add(rule.user_id);
    }
    const allowed = new Map();
    for (const kind of Object.keys(PUBLIC_MODELS)) {
        const records = entries.filter(entry => entry.kind === kind && !hidden.has(entry.actorId))
            .map(entry => ({ id: entry.id }));
        allowed.set(kind, new Set((await filterPublicRecords(kind, records)).map(record => record.id)));
    }
    return entries.filter(entry => !hidden.has(entry.actorId) && allowed.get(entry.kind).has(entry.id)).map(entry => entry.row);
}

// Gorse 反馈类型常量
export const FEEDBACK_TYPES = {
    LIKE: 'like',
    BOOKMARK: 'bookmark',
    REPLY: 'reply',
    RETWEET: 'retweet',
    QUOTE: 'quote',
    STAR: 'star',           // 项目收藏
    FOLLOW: 'follow',       // 关注用户
    READ: 'read',           // 阅读/浏览
};

// 物品前缀
const ITEM_PREFIX = {
    POST: 'post_',
    PROJECT: 'project_',
};

let gorseClient = null;
let gorseEnabled = false;

/**
 * 初始化 Gorse 客户端
 */
async function initGorseClient() {
    try {
        const endpoint = await zcconfig.get('gorse.endpoint');
        const secret = await zcconfig.get('gorse.secret');

        if (!endpoint) {
            logger.info('[gorse] Gorse 未配置 endpoint，推荐服务未启用');
            gorseEnabled = false;
            return null;
        }

        gorseClient = new Gorse({
            endpoint,
            secret: secret || '',
        });

        gorseEnabled = true;
        logger.info(`[gorse] Gorse 推荐服务已连接: ${endpoint}`);
        return gorseClient;
    } catch (error) {
        logger.error('[gorse] 初始化 Gorse 客户端失败:', error);
        gorseEnabled = false;
        return null;
    }
}

/**
 * 获取 Gorse 客户端（懒初始化）
 */
async function getClient() {
    if (!gorseClient) {
        await initGorseClient();
    }
    return gorseClient;
}

/**
 * 检查 Gorse 是否可用
 */
function isEnabled() {
    return gorseEnabled && gorseClient !== null;
}

// ======================== 用户操作 ========================

/** 携带 embedding 向量时单批最大条目数（避免 Gorse HTTP 请求体过大） */
const GORSE_UPSERT_BATCH_SIZE = 20;

/**
 * 将 items 分批调用 client.upsertItems，避免单次请求体因 embedding 向量过大而超时
 * @param {object} client - Gorse 客户端
 * @param {Array} items - 待上传的 item 列表
 * @param {number} [batchSize=GORSE_UPSERT_BATCH_SIZE] - 每批大小
 */
async function upsertItemsInBatches(client, items, batchSize = GORSE_UPSERT_BATCH_SIZE) {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        logger.debug(`[gorse] upsertItemsInBatches: 正在上传第 ${Math.floor(i / batchSize) + 1} 批，共 ${Math.ceil(items.length / batchSize)} 批，当前批次大小: ${batch.length}`);
        //logger.debug(batch[0])
        await client.upsertItems(batch);
    }
}

/**
 * 为缺失 embedding 的用户内联生成向量并存储
 * 仅在 embedding 服务已启用时生效，服务未启用则静默跳过
 * @param {Array} usersWithoutEmbedding - 需要生成的用户列表，每项包含 { id, username, display_name, bio }
 * @returns {Promise<Map<number, number[]>>} 新生成的 embedding map
 */
async function generateMissingUserEmbeddings(usersWithoutEmbedding) {
    const result = new Map();
    if (!usersWithoutEmbedding.length) return result;

    const CHUNK_SIZE = 20;
    for (let i = 0; i < usersWithoutEmbedding.length; i += CHUNK_SIZE) {
        const chunk = usersWithoutEmbedding.slice(i, i + CHUNK_SIZE);
        const validItems = chunk
            .map(u => ({ user: u, text: embeddingService.buildUserProfileText(u) }))
            .filter(item => item.text && item.text.trim().length > 0);

        if (!validItems.length) continue;

        try {
            const vectors = await embeddingService.generateEmbeddings(validItems.map(item => item.text));
            for (let j = 0; j < validItems.length; j++) {
                const { user, text } = validItems[j];
                const vector = vectors[j];
                if (vector) {
                    const textHash = embeddingService.hashText(text);
                    await embeddingService.saveEmbedding('user', user.id, vector, textHash, null);
                    result.set(user.id, vector);
                }
            }
            logger.debug(`[gorse] 内联生成用户 embedding: ${result.size} 条`);
        } catch (e) {
            // embedding 服务未启用或 API 失败，跳过后续批次
            logger.debug(`[gorse] 内联生成用户 embedding 失败（跳过）: ${e.message}`);
            break;
        }
    }
    return result;
}

/**
 * 将用户插入/更新到 Gorse
 */
export async function upsertUser(userId, { username, labels, display_name } = {}) {
    try {
        if (!await canViewContent('profile', { id: Number(userId) }, null)) return;
        const client = await getClient();
        if (!client) return;

        // 获取用户 embedding 向量
        let userLabels = { embedding: [] };
        try {
            const embedding = await embeddingService.getEmbedding('user', userId);
            if (embedding) userLabels.embedding = embedding;
        } catch (e) {
            // 获取失败不影响主流程
        }

        await client.insertUser({
            UserId: String(userId),
            Comment: username || '',
            Labels: userLabels,
        });

        // 同时将用户作为 item 写入（含 embedding 向量，确保 Labels.embedding 不为 nil）
        await upsertUserItem(userId, { username, display_name });

        logger.debug(`[gorse] 用户已同步: ${userId}`);
    } catch (error) {
        logger.warn(`[gorse] 同步用户 ${userId} 失败:`, error.message);
    }
}

/**
 * 批量插入用户到 Gorse
 */
export async function insertUsers(users) {
    try {
        users = await filterPublicRecords('profile', users);
        if (!users.length) return;
        const client = await getClient();
        if (!client) return;

        // 同时将用户批量写为 items，携带已存储的 embedding 向量
        const userIds = users.map(u => u.id);
        let userEmbeddingMap = new Map();
        try {
            userEmbeddingMap = await embeddingService.getEmbeddings('user', userIds);
        } catch (e) {
            logger.warn('[gorse] 批量读取用户 embedding 失败:', e.message);
        }

        // 对未找到 embedding 的用户尝试内联生成
        const usersWithoutEmbedding = users.filter(u => !userEmbeddingMap.has(u.id));
        if (usersWithoutEmbedding.length > 0) {
            logger.debug(`[gorse] ${usersWithoutEmbedding.length} 个用户缺少 embedding，尝试内联生成`);
            const newEmbeddings = await generateMissingUserEmbeddings(usersWithoutEmbedding);
            for (const [id, vec] of newEmbeddings) {
                userEmbeddingMap.set(id, vec);
            }
        }

        // insertUsers 携带 embedding 向量
        const gorseUsers = users.map(u => ({
            UserId: String(u.id),
            Comment: u.username || u.display_name || '',
            Labels: { embedding: userEmbeddingMap.get(u.id) || [] },
        }));
        await client.insertUsers(gorseUsers);

        const userItems = users.map(u => {
            const item = buildUserItem(u);
            const embedding = userEmbeddingMap.get(u.id);
            if (embedding) item.Labels.embedding = embedding;
            return item;
        });
        logger.debug('[gorse] insertUsers userItems: ' + JSON.stringify(
            userItems.map(it => ({ ...it, Labels: { ...it.Labels, embedding: it.Labels.embedding?.length ?? 0 } }))
        ));
        await upsertItemsInBatches(client, userItems);

        logger.debug(`[gorse] 批量同步 ${gorseUsers.length} 个用户`);
    } catch (error) {
        logger.warn(`[gorse] 批量同步用户失败:`, error.message);
    }
}

// ======================== 物品操作 ========================

/**
 * 将帖子作为物品插入/更新到 Gorse
 * 纯转推不作为独立 item 推送给 Gorse
 */
export async function upsertPost(post) {
    try {
        if (!await canViewContent('post', post, null)) { await hidePost(post.id); return; }
        // 纯转推不单独推送到 Gorse
        if (post.post_type === 'retweet') {
            logger.debug(`[gorse] 帖子 ${post.id} 是纯转推，跳过 Gorse 同步`);
            return;
        }

        // 已删除的帖子跳过同步（删除时由 hidePost 单独处理）
        if (post.is_deleted) {
            logger.debug(`[gorse] 帖子 ${post.id} 已删除，跳过 Gorse 同步`);
            return;
        }

        const client = await getClient();
        if (!client) return;

        // 获取 embedding，无向量则跳过（embedding 生成后由 Worker 自动同步）
        let embedding = null;
        try {
            embedding = await embeddingService.getEmbedding('post', post.id);
        } catch (e) {
            // 获取失败视为无向量
        }
        if (!embedding) {
            logger.debug(`[gorse] 帖子 ${post.id} 暂无 embedding，跳过 Gorse 同步（将在向量生成后自动同步）`);
            return;
        }

        const categories = buildPostCategories(post);
        const labels = buildPostLabels(post);
        labels.embedding = embedding;

        await client.upsertItem({
            ItemId: `${ITEM_PREFIX.POST}${post.id}`,
            Comment: (post.content || '').substring(0, 200),
            IsHidden: false,
            Timestamp: post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString(),
            Categories: categories,
            Labels: labels,
        });
        logger.debug(`[gorse] 帖子已同步: ${post.id}`);
    } catch (error) {
        logger.warn(`[gorse] 同步帖子 ${post.id} 失败:`, error.message);
    }
}

/**
 * 构建项目类别标签
 */
function buildProjectCategories(project) {
    const categories = ['project'];
    if (project?.type) {
        categories.push(`type:${project.type}`);
    }
    return categories;
}

/**
 * 构建项目标签（对象格式，支持 embedding 字段）
 */
function buildProjectLabels(project) {
    const labels = { embedding: [] };
    if (project?.authorid) {
        labels.author = String(project.authorid);
    }
    if (project?.type) {
        labels.type = String(project.type);
    }
    if (project?.state) {
        labels.state = String(project.state);
    }

    const tags = Array.isArray(project?.project_tags)
        ? project.project_tags.map(tag => String(tag?.name || '').trim()).filter(Boolean).slice(0, 40)
        : [];
    if (tags.length > 0) {
        labels.tags = tags;
    }

    return labels;
}

/**
 * 将项目作为物品插入/更新到 Gorse
 * 仅同步有 embedding 的项目
 */
export async function upsertProject(project) {
    try {
        const client = await getClient();
        if (!client) return;

        const projectId = Number(project?.id);
        if (!Number.isInteger(projectId) || projectId <= 0) return;

        if (project?.state !== 'public' || !await canViewContent('project', project, null)) {
            await hideProject(projectId);
            return;
        }

        let embedding = null;
        try {
            embedding = await embeddingService.getEmbedding('project', projectId);
        } catch (e) {
            // 获取失败视为无向量
        }

        if (!embedding) {
            logger.debug(`[gorse] 项目 ${projectId} 暂无 embedding，跳过 Gorse 同步`);
            return;
        }

        const labels = buildProjectLabels(project);
        labels.embedding = embedding;

        await client.upsertItem({
            ItemId: `${ITEM_PREFIX.PROJECT}${projectId}`,
            Comment: (project.title || project.name || project.description || '').substring(0, 200),
            IsHidden: project.state !== 'public',
            Timestamp: project.time ? new Date(project.time).toISOString() : new Date().toISOString(),
            Categories: buildProjectCategories(project),
            Labels: labels,
        });

        logger.debug(`[gorse] 项目已同步: ${projectId}`);
    } catch (error) {
        logger.warn(`[gorse] 同步项目 ${project?.id} 失败:`, error.message);
    }
}

/**
 * 批量插入项目到 Gorse
 * 仅同步有 embedding 且未删除的项目
 */
export async function insertProjects(projects) {
    try {
        const client = await getClient();
        if (!client) return;

        const filteredProjects = (await filterPublicRecords('project', projects)).filter(p => p.state === 'public');
        if (filteredProjects.length === 0) return;

        const projectIds = filteredProjects
            .map(project => Number(project.id))
            .filter(id => Number.isInteger(id) && id > 0);

        let embeddingMap = new Map();
        try {
            embeddingMap = await embeddingService.getEmbeddings('project', projectIds);
        } catch (e) {
            // 向量获取失败不影响主流程
        }

        const items = filteredProjects
            .filter(project => embeddingMap.has(Number(project.id)))
            .map(project => {
                const labels = buildProjectLabels(project);
                labels.embedding = embeddingMap.get(Number(project.id));
                return {
                    ItemId: `${ITEM_PREFIX.PROJECT}${project.id}`,
                    Comment: (project.title || project.name || project.description || '').substring(0, 200),
                    IsHidden: project.state !== 'public',
                    Timestamp: project.time ? new Date(project.time).toISOString() : new Date().toISOString(),
                    Categories: buildProjectCategories(project),
                    Labels: labels,
                };
            });

        if (items.length === 0) {
            logger.debug(`[gorse] insertProjects: 全部 ${filteredProjects.length} 个项目暂无 embedding，跳过同步`);
            return;
        }

        await upsertItemsInBatches(client, items);
        logger.debug(`[gorse] 批量同步 ${items.length} 个项目（跳过无 embedding: ${filteredProjects.length - items.length}）`);
    } catch (error) {
        logger.warn('[gorse] 批量同步项目失败:', error.message);
    }
}

/**
 * 将项目标记为隐藏（删除/私有时）
 */
export async function hideProject(projectId, { throwOnError = false } = {}) {
    try {
        const client = await getClient();
        if (!client) return;

        await client.updateItem(`${ITEM_PREFIX.PROJECT}${projectId}`, {
            IsHidden: true,
        });
        logger.debug(`[gorse] 项目已隐藏: ${projectId}`);
    } catch (error) {
        logger.warn(`[gorse] 隐藏项目 ${projectId} 失败:`, error.message);
        if (throwOnError) throw error;
    }
}

/**
 * 批量插入帖子到 Gorse
 * 纯转推不推送
 */
export async function insertPosts(posts) {
    try {
        const client = await getClient();
        if (!client) return;

        // 过滤掉纯转推和已删除帖子
        const filteredPosts = (await filterPublicRecords('post', posts)).filter(p => p.post_type !== 'retweet' && !p.is_deleted);
        if (filteredPosts.length === 0) return;

        // 批量获取 embedding
        const postIds = filteredPosts.map(p => p.id);
        let embeddingMap = new Map();
        try {
            embeddingMap = await embeddingService.getEmbeddings('post', postIds);
        } catch (e) {
            // 向量获取失败不影响主流程
        }

        // 只同步有 embedding 的帖子，无 embedding 的等 Worker 生成后自动同步
        const items = filteredPosts
            .filter(post => embeddingMap.has(post.id))
            .map(post => {
                const labels = buildPostLabels(post);
                labels.embedding = embeddingMap.get(post.id);
                return {
                    ItemId: `${ITEM_PREFIX.POST}${post.id}`,
                    Comment: (post.content || '').substring(0, 200),
                    IsHidden: false,
                    Timestamp: post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString(),
                    Categories: buildPostCategories(post),
                    Labels: labels,
                };
            });

        if (items.length === 0) {
            logger.debug(`[gorse] insertPosts: 全部 ${filteredPosts.length} 个帖子暂无 embedding，跳过同步`);
            return;
        }

        await upsertItemsInBatches(client, items);
        logger.debug(`[gorse] 批量同步 ${items.length} 个帖子（跳过无 embedding: ${filteredPosts.length - items.length}）`);
    } catch (error) {
        logger.warn(`[gorse] 批量同步帖子失败:`, error.message);
    }
}

/**
 * 将帖子标记为隐藏（删除时）
 */
export async function hidePost(postId, { throwOnError = false } = {}) {
    try {
        const client = await getClient();
        if (!client) return;

        await client.updateItem(`${ITEM_PREFIX.POST}${postId}`, {
            IsHidden: true,
        });
        logger.debug(`[gorse] 帖子已隐藏: ${postId}`);
    } catch (error) {
        logger.warn(`[gorse] 隐藏帖子 ${postId} 失败:`, error.message);
        if (throwOnError) throw error;
    }
}

/**
 * 构建用户作为 Gorse item 时的结构
 * Labels 使用 map 格式，包含 embedding 占位字段，避免列表达式 item.Labels.embedding 报 nil
 */
function buildUserItem(user) {
    return {
        ItemId: `user_${user.id || user.UserId}`,
        Comment: (user.username || user.display_name || '').substring(0, 200),
        IsHidden: false,
        Categories: ['user'],
        Labels: { embedding: [] },
    };
}

/**
 * 将用户同步为 Gorse item（ItemId: user_${id}）
 * 确保 Labels 不为 null，避免列表达式 item.Labels.embedding 出错
 */
export async function upsertUserItem(userId, { username, display_name } = {}) {
    try {
        if (!await canViewContent('profile', { id: Number(userId) }, null)) return;
        const client = await getClient();
        if (!client) return;
        const item = buildUserItem({ id: userId, username, display_name });
        try {
            const embedding = await embeddingService.getEmbedding('user', userId);
            logger.debug(`[gorse] upsertUserItem userId=${userId} embedding=${embedding ? `dim:${embedding.length}` : 'null'}`);
            if (embedding) item.Labels.embedding = embedding;
        } catch (e) {
            logger.warn(`[gorse] 获取用户 ${userId} embedding 失败:`, e.message);
        }
        logger.debug(`[gorse] upsertUserItem 写入 Gorse: user_${userId} embedding_len=${item.Labels.embedding?.length ?? 0}`);
        await client.upsertItem(item);
        logger.debug(`[gorse] 用户 item 已同步: user_${userId}`);
    } catch (error) {
        logger.warn(`[gorse] 同步用户 item ${userId} 失败:`, error.message);
    }
}

/**
 * 构建帖子类别标签
 */
function buildPostCategories(post) {
    const categories = ['post'];
    if (post.post_type) {
        categories.push(`type:${post.post_type}`);
    }
    if (post.embed && typeof post.embed === 'object' && post.embed.type) {
        categories.push(`embed:${post.embed.type}`);
    }
    return categories;
}

/**
 * 构建帖子标签（对象格式，支持 embedding 字段）
 */
function buildPostLabels(post) {
    const labels = { embedding: [] };
    if (post.author_id) {
        labels.author = String(post.author_id);
    }
    if (post.post_type) {
        labels.type = post.post_type;
    }
    if (post.embed && typeof post.embed === 'object') {
        if (post.embed.type) labels.embed_type = post.embed.type;
        if (post.embed.type === 'project' && post.embed.id) {
            labels.project = String(post.embed.id);
        }
    }
    return labels;
}

// ======================== 反馈操作 ========================

/**
 * 插入单条反馈（幂等，重复写入不报错）
 * Gorse Feedback 接口要求 Value 字段，正向反馈传 1
 */
export async function insertFeedback(feedbackType, userId, itemId, { timestamp, value = 1 } = {}) {
    try {
        if (!await feedbackIsPublic(userId, itemId)) return;
        const client = await getClient();
        if (!client) return;

        await client.upsertFeedbacks([{
            FeedbackType: feedbackType,
            UserId: String(userId),
            ItemId: String(itemId),
            Value: value,
            Timestamp: timestamp || new Date().toISOString(),
        }]);
        logger.debug(`[gorse] 反馈已记录: ${feedbackType} user=${userId} item=${itemId}`);
    } catch (error) {
        logger.warn(`[gorse] 记录反馈失败 (${feedbackType}):`, error.message);
    }
}

/**
 * 批量插入反馈（幂等）
 */
export async function insertFeedbacks(feedbacks) {
    try {
        feedbacks = await filterPublicFeedbacks(feedbacks, feedback => feedback.userId, feedback => feedback.itemId);
        if (!feedbacks.length) return;
        const client = await getClient();
        if (!client) return;

        const gorseFeedbacks = feedbacks.map(fb => ({
            FeedbackType: fb.feedbackType,
            UserId: String(fb.userId),
            ItemId: String(fb.itemId),
            Value: typeof fb.value === 'number' ? fb.value : 1,
            Timestamp: fb.timestamp || new Date().toISOString(),
        }));

        await client.upsertFeedbacks(gorseFeedbacks);
        logger.debug(`[gorse] 批量记录 ${gorseFeedbacks.length} 条反馈`);
    } catch (error) {
        logger.warn(`[gorse] 批量记录反馈失败:`, error.message);
    }
}

/**
 * 删除反馈（用于取消点赞/取消收藏等）
 */
export async function deleteFeedback(feedbackType, userId, itemId) {
    try {
        const client = await getClient();
        if (!client) return;

        await client.deleteFeedback({
            type: feedbackType,
            userId: String(userId),
            itemId: String(itemId),
        });
        logger.debug(`[gorse] 反馈已删除: ${feedbackType} user=${userId} item=${itemId}`);
    } catch (error) {
        logger.warn(`[gorse] 删除反馈失败 (${feedbackType}):`, error.message);
    }
}

// ======================== 推荐获取 ========================

/**
 * 获取个性化推荐帖子 ID 列表
 * @param {number} userId - 用户ID
 * @param {object} options - 推荐选项
 * @param {number} options.limit - 返回数量，默认20
 * @param {number} options.offset - 偏移量，默认0
 * @param {string} options.category - 类别过滤
 * @returns {Promise<string[]>} 推荐的物品ID列表
 */
export async function getRecommendedPostIds(userId, { limit = 20, offset = 0, category } = {}) {
    try {
        const client = await getClient();
        if (!client) return [];

        const ids = await client.getRecommend({
            userId: String(userId),
            category: category || 'post',
            // 将推荐曝光自动回写为 'read' 反馈，用于去重
            writeBackType: 'read',
            writeBackDelay: '0s',
            cursorOptions: { n: limit, offset },
        });

        // 返回去掉前缀后的帖子ID
        return (ids || []).map(id => {
            if (id.startsWith(ITEM_PREFIX.POST)) {
                return parseInt(id.slice(ITEM_PREFIX.POST.length), 10);
            }
            return null;
        }).filter(Boolean);
    } catch (error) {
        logger.warn(`[gorse] 获取推荐失败 (user=${userId}):`, error.message);
        return [];
    }
}

/**
 * 获取个性化推荐项目 ID 列表
 * @param {number} userId - 用户ID
 * @param {object} options - 推荐选项
 * @param {number} options.limit - 返回数量，默认20
 * @param {number} options.offset - 偏移量，默认0
 * @param {string} options.category - 类别过滤
 * @returns {Promise<number[]>} 推荐的项目 ID 列表
 */
export async function getRecommendedProjectIds(userId, { limit = 20, offset = 0, category } = {}) {
    try {
        const client = await getClient();
        if (!client) return [];

        const ids = await client.getRecommend({
            userId: String(userId),
            category: category || 'project',
            writeBackType: 'read',
            writeBackDelay: '0s',
            cursorOptions: { n: limit, offset },
        });

        return (ids || []).map(id => {
            if (id.startsWith(ITEM_PREFIX.PROJECT)) {
                return parseInt(id.slice(ITEM_PREFIX.PROJECT.length), 10);
            }
            return null;
        }).filter(Boolean);
    } catch (error) {
        logger.warn(`[gorse] 获取项目推荐失败 (user=${userId}):`, error.message);
        return [];
    }
}

/**
 * 获取个性化推荐用户 ID 列表
 * @param {number} userId - 用户ID
 * @param {object} options - 推荐选项
 * @param {number} options.limit - 返回数量，默认20
 * @param {number} options.offset - 偏移量，默认0
 * @returns {Promise<number[]>} 推荐的用户 ID 列表
 */
export async function getRecommendedUserIds(userId, { limit = 20, offset = 0 } = {}) {
    try {
        const client = await getClient();
        if (!client) return [];

        const ids = await client.getRecommend({
            userId: String(userId),
            category: 'user',
            writeBackType: 'read',
            writeBackDelay: '0s',
            cursorOptions: { n: limit, offset },
        });

        return (ids || []).map(id => {
            if (id.startsWith('user_')) {
                return parseInt(id.slice('user_'.length), 10);
            }
            return null;
        }).filter(Boolean);
    } catch (error) {
        logger.warn(`[gorse] 获取用户推荐失败 (user=${userId}):`, error.message);
        return [];
    }
}

/**
 * 获取最新热门帖子（未登录用户使用）
 * @param {object} options
 * @param {number} options.limit - 返回数量，默认20
 * @param {number} options.offset - 偏移量，默认0
 * @param {string} options.category - 类别过滤
 * @returns {Promise<string[]>} 物品ID列表
 */
export async function getLatestPostIds({ limit = 20, offset = 0, category } = {}) {
    try {
        const client = await getClient();
        if (!client) return [];

        const scores = await client.getLatest({
            category: category || 'post',
            cursorOptions: { n: limit, offset },
        });

        return (scores || []).map(s => {
            if (s.Id && s.Id.startsWith(ITEM_PREFIX.POST)) {
                return parseInt(s.Id.slice(ITEM_PREFIX.POST.length), 10);
            }
            return null;
        }).filter(Boolean);
    } catch (error) {
        logger.warn(`[gorse] 获取最新帖子失败:`, error.message);
        return [];
    }
}

// ======================== 帖子反馈便捷方法 ========================

/** 帖子点赞反馈 */
export function feedbackPostLike(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.LIKE, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 取消帖子点赞反馈 */
export function feedbackPostUnlike(userId, postId) {
    return deleteFeedback(FEEDBACK_TYPES.LIKE, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 帖子收藏反馈 */
export function feedbackPostBookmark(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.BOOKMARK, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 取消帖子收藏反馈 */
export function feedbackPostUnbookmark(userId, postId) {
    return deleteFeedback(FEEDBACK_TYPES.BOOKMARK, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 帖子回复反馈 */
export function feedbackPostReply(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.REPLY, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 帖子转推反馈 */
export function feedbackPostRetweet(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.RETWEET, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 帖子引用反馈 */
export function feedbackPostQuote(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.QUOTE, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 帖子阅读反馈 */
export function feedbackPostRead(userId, postId) {
    return insertFeedback(FEEDBACK_TYPES.READ, userId, `${ITEM_PREFIX.POST}${postId}`);
}

/** 项目收藏反馈 */
export async function feedbackProjectStar(userId, projectId) {
    return insertFeedback(FEEDBACK_TYPES.STAR, userId, `${ITEM_PREFIX.PROJECT}${projectId}`);
}

/** 取消项目收藏反馈 */
export async function feedbackProjectUnstar(userId, projectId) {
    return deleteFeedback(FEEDBACK_TYPES.STAR, userId, `${ITEM_PREFIX.PROJECT}${projectId}`);
}

/** 项目阅读反馈 */
export function feedbackProjectRead(userId, projectId, options = {}) {
    return insertFeedback(FEEDBACK_TYPES.READ, userId, `${ITEM_PREFIX.PROJECT}${projectId}`, options);
}

/** 用户关注反馈 */
export async function feedbackUserFollow(userId, followedUserId) {
    // 先确保被关注用户已以 item 形式存在于 Gorse，避免 Labels.embedding 为 nil
    await upsertUserItem(followedUserId).catch(e =>
        logger.debug(`[gorse] feedbackUserFollow: upsertUserItem failed for ${followedUserId}:`, e.message)
    );
    return insertFeedback(FEEDBACK_TYPES.FOLLOW, userId, `user_${followedUserId}`);
}

/** 取消用户关注反馈 */
export function feedbackUserUnfollow(userId, followedUserId) {
    return deleteFeedback(FEEDBACK_TYPES.FOLLOW, userId, `user_${followedUserId}`);
}

/** 用户推荐曝光反馈 */
export function feedbackUserRecommendationView(userId, recommendedUserId) {
    return insertFeedback(FEEDBACK_TYPES.READ, userId, `user_${recommendedUserId}`);
}

// ======================== 全量同步 ========================

/**
 * 全量同步所有用户到 Gorse
 * @returns {Promise<{total: number, synced: number}>}
 */
export async function syncAllUsers() {
    const client = await getClient();
    if (!client) throw new Error('Gorse 服务未启用');

    let cursor = 0;
    const batchSize = 500;
    let totalSynced = 0;

    while (true) {
        const users = await prisma.ow_users.findMany({
            where: await visibleWhere('profile'),
            skip: cursor,
            take: batchSize,
            select: { id: true, username: true, display_name: true, bio: true },
            orderBy: { id: 'asc' },
        });

        if (users.length === 0) break;

        // 批量获取 embedding（先于 insertUsers，使两处调用共用同一份数据）
        const userIds = users.map(u => u.id);
        logger.debug(`[gorse] syncAllUsers 批量获取用户 embedding，count=${userIds.length}`);
        let userEmbeddingMap = new Map();
        try {
            userEmbeddingMap = await embeddingService.getEmbeddings('user', userIds);
        } catch (e) {
            logger.warn('[gorse] syncAllUsers 批量读取 embedding 失败:', e.message);
        }

        // 对未找到 embedding 的用户尝试内联生成
        const usersWithoutEmbedding = users.filter(u => !userEmbeddingMap.has(u.id));
        if (usersWithoutEmbedding.length > 0) {
            logger.debug(`[gorse] syncAllUsers: ${usersWithoutEmbedding.length} 个用户缺少 embedding，尝试内联生成`);
            const newEmbeddings = await generateMissingUserEmbeddings(usersWithoutEmbedding);
            for (const [id, vec] of newEmbeddings) {
                userEmbeddingMap.set(id, vec);
            }
        }

        // insertUsers 携带 embedding 向量
        const gorseUsers = users.map(u => ({
            UserId: String(u.id),
            Comment: u.username || u.display_name || '',
            Labels: { embedding: userEmbeddingMap.get(u.id) || [] },
        }));
        await client.insertUsers(gorseUsers);

        // 同时将用户批量写入为 items（ItemId: user_X），共用同一份 embeddingMap
        const userItems = users.map(u => {
            const item = buildUserItem(u);
            const embedding = userEmbeddingMap.get(u.id);
            if (embedding) {
                item.Labels.embedding = embedding;
            }
            return item;
        });
        await upsertItemsInBatches(client, userItems);

        totalSynced += gorseUsers.length;
        cursor += batchSize;

        logger.info(`[gorse] 全量同步用户进度: ${totalSynced}`);
    }

    logger.info(`[gorse] 全量同步用户完成: ${totalSynced}`);
    return { total: totalSynced, synced: totalSynced };
}

/**
 * 全量同步所有帖子到 Gorse
 * 纯转推不推送给 Gorse；已有 embedding 的帖子会携带向量
 * @returns {Promise<{total: number, synced: number, skippedRetweets: number}>}
 */
export async function syncAllPosts() {
    const client = await getClient();
    if (!client) throw new Error('Gorse 服务未启用');

    let cursor = 0;
    const batchSize = 500;
    let totalSynced = 0;

    while (true) {
        const posts = await prisma.ow_posts.findMany({
            skip: cursor,
            take: batchSize,
            select: {
                id: true,
                author_id: true,
                post_type: true,
                content: true,
                is_deleted: true,
                embed: true,
                created_at: true,
                retweet_post_id: true,
            },
            where: { is_deleted: false, post_type: { not: 'retweet' }, AND: [await visibleWhere('post')] },
            orderBy: { id: 'asc' },
        });

        if (posts.length === 0) break;

        // 批量获取已存储的 embedding 向量
        const postIds = posts.map(p => p.id);
        let embeddingMap = new Map();
        try {
            embeddingMap = await embeddingService.getEmbeddings('post', postIds);
        } catch (e) {
            // 向量获取失败不影响主流程
        }

        // 只同步有 embedding 的帖子
        const itemsToSync = posts
            .filter(post => embeddingMap.has(post.id))
            .map(post => {
                const labels = buildPostLabels(post);
                labels.embedding = embeddingMap.get(post.id);
                return {
                    ItemId: `${ITEM_PREFIX.POST}${post.id}`,
                    Comment: (post.content || '').substring(0, 200),
                    IsHidden: false,
                    Timestamp: post.created_at ? new Date(post.created_at).toISOString() : new Date().toISOString(),
                    Categories: buildPostCategories(post),
                    Labels: labels,
                };
            });

        if (itemsToSync.length > 0) {
            await upsertItemsInBatches(client, itemsToSync);
            totalSynced += itemsToSync.length;
        }
        const skippedNoEmbed = posts.length - itemsToSync.length;

        cursor += batchSize;
        logger.info(`[gorse] 全量同步帖子进度: ${totalSynced}（本批跳过无 embedding: ${skippedNoEmbed}）`);
    }

    logger.info(`[gorse] 全量同步帖子完成: ${totalSynced}`);
    return { total: totalSynced, synced: totalSynced };
}

/**
 * 全量同步所有项目到 Gorse
 * 仅同步有 embedding 的项目（deleted 项目不写入）
 * @returns {Promise<{total: number, synced: number}>}
 */
export async function syncAllProjects() {
    const client = await getClient();
    if (!client) throw new Error('Gorse 服务未启用');

    let cursor = 0;
    const batchSize = 500;
    let totalSynced = 0;

    while (true) {
        const projects = await prisma.ow_projects.findMany({
            skip: cursor,
            take: batchSize,
            select: {
                id: true,
                authorid: true,
                type: true,
                state: true,
                title: true,
                name: true,
                description: true,
                time: true,
                project_tags: {
                    select: { name: true },
                },
            },
            where: { state: 'public', AND: [await visibleWhere('project')] },
            orderBy: { id: 'asc' },
        });

        if (projects.length === 0) break;

        const projectIds = projects.map(p => p.id);
        let embeddingMap = new Map();
        try {
            embeddingMap = await embeddingService.getEmbeddings('project', projectIds);
        } catch (e) {
            // 向量获取失败不影响主流程
        }

        const itemsToSync = projects
            .filter(project => embeddingMap.has(project.id))
            .map(project => {
                const labels = buildProjectLabels(project);
                labels.embedding = embeddingMap.get(project.id);
                return {
                    ItemId: `${ITEM_PREFIX.PROJECT}${project.id}`,
                    Comment: (project.title || project.name || project.description || '').substring(0, 200),
                    IsHidden: project.state !== 'public',
                    Timestamp: project.time ? new Date(project.time).toISOString() : new Date().toISOString(),
                    Categories: buildProjectCategories(project),
                    Labels: labels,
                };
            });

        if (itemsToSync.length > 0) {
            await upsertItemsInBatches(client, itemsToSync);
            totalSynced += itemsToSync.length;
        }

        const skippedNoEmbed = projects.length - itemsToSync.length;
        cursor += batchSize;
        logger.info(`[gorse] 全量同步项目进度: ${totalSynced}（本批跳过无 embedding: ${skippedNoEmbed}）`);
    }

    logger.info(`[gorse] 全量同步项目完成: ${totalSynced}`);
    return { total: totalSynced, synced: totalSynced };
}

/**
 * 全量同步所有反馈到 Gorse（帖子点赞、帖子收藏、项目收藏、用户关注）
 * @returns {Promise<{likes: number, bookmarks: number, projectStars: number, follows: number}>}
 */
export async function syncAllFeedbacks() {
    const client = await getClient();
    if (!client) throw new Error('Gorse 服务未启用');

     const result = { likes: 0, bookmarks: 0, projectStars: 0, follows: 0 };
    const batchSize = 500;

    // 同步帖子点赞
    let cursor = 0;
    while (true) {
        const likes = await prisma.ow_posts_like.findMany({
            skip: cursor,
            take: batchSize,
            select: { user_id: true, post_id: true, created_at: true },
            orderBy: { id: 'asc' },
        });
        if (likes.length === 0) break;

        const feedbacks = (await filterPublicFeedbacks(likes, row => row.user_id, row => `${ITEM_PREFIX.POST}${row.post_id}`)).map(l => ({
            FeedbackType: FEEDBACK_TYPES.LIKE,
            UserId: String(l.user_id),
            ItemId: `${ITEM_PREFIX.POST}${l.post_id}`,
            Value: 1,
            Timestamp: l.created_at ? new Date(l.created_at).toISOString() : new Date().toISOString(),
        }));

        if (feedbacks.length) await client.upsertFeedbacks(feedbacks);
        result.likes += feedbacks.length;
        cursor += batchSize;
    }
    logger.info(`[gorse] 全量同步点赞反馈完成: ${result.likes}`);

    // 同步帖子收藏
    cursor = 0;
    while (true) {
        const bookmarks = await prisma.ow_posts_bookmark.findMany({
            skip: cursor,
            take: batchSize,
            select: { user_id: true, post_id: true, created_at: true },
            orderBy: { id: 'asc' },
        });
        if (bookmarks.length === 0) break;

        const feedbacks = (await filterPublicFeedbacks(bookmarks, row => row.user_id, row => `${ITEM_PREFIX.POST}${row.post_id}`)).map(b => ({
            FeedbackType: FEEDBACK_TYPES.BOOKMARK,
            UserId: String(b.user_id),
            ItemId: `${ITEM_PREFIX.POST}${b.post_id}`,
            Value: 1,
            Timestamp: b.created_at ? new Date(b.created_at).toISOString() : new Date().toISOString(),
        }));

        if (feedbacks.length) await client.upsertFeedbacks(feedbacks);
        result.bookmarks += feedbacks.length;
        cursor += batchSize;
    }
    logger.info(`[gorse] 全量同步收藏反馈完成: ${result.bookmarks}`);

    // 同步项目收藏
    cursor = 0;
    while (true) {
        const stars = await prisma.ow_projects_stars.findMany({
            skip: cursor,
            take: batchSize,
            select: { userid: true, projectid: true, createTime: true },
            orderBy: { id: 'asc' },
        });
        if (stars.length === 0) break;

        const feedbacks = (await filterPublicFeedbacks(stars, row => row.userid, row => `${ITEM_PREFIX.PROJECT}${row.projectid}`)).map(s => ({
            FeedbackType: FEEDBACK_TYPES.STAR,
            UserId: String(s.userid),
            ItemId: `${ITEM_PREFIX.PROJECT}${s.projectid}`,
            Value: 1,
            Timestamp: s.createTime ? new Date(s.createTime).toISOString() : new Date().toISOString(),
        }));

        if (feedbacks.length) await client.upsertFeedbacks(feedbacks);
        result.projectStars += feedbacks.length;
        cursor += batchSize;
    }
    logger.info(`[gorse] 全量同步项目收藏反馈完成: ${result.projectStars}`);

    // 同步用户关注
    cursor = 0;
    while (true) {
        const follows = await prisma.ow_user_relationships.findMany({
            skip: cursor,
            take: batchSize,
            where: { relationship_type: 'follow' },
            select: { source_user_id: true, target_user_id: true, created_at: true },
            orderBy: { id: 'asc' },
        });
        if (follows.length === 0) break;

        const feedbacks = (await filterPublicFeedbacks(follows, row => row.source_user_id, row => `user_${row.target_user_id}`)).map(f => ({
            FeedbackType: FEEDBACK_TYPES.FOLLOW,
            UserId: String(f.source_user_id),
            ItemId: `user_${f.target_user_id}`,
            Value: 1,
            Timestamp: f.created_at ? new Date(f.created_at).toISOString() : new Date().toISOString(),
        }));

        if (feedbacks.length) await client.upsertFeedbacks(feedbacks);
        result.follows += feedbacks.length;
        cursor += batchSize;
    }
    logger.info(`[gorse] 全量同步关注反馈完成: ${result.follows}`);

    return result;
}

/**
 * 全量同步所有数据（用户 + 帖子 + 项目 + 反馈）
 */
export async function syncAll() {
    const client = await getClient();
    if (!client) throw new Error('Gorse 服务未启用');

    logger.info('[gorse] 开始全量同步...');

    const usersResult = await syncAllUsers();
    const postsResult = await syncAllPosts();
    const projectsResult = await syncAllProjects();
    const feedbacksResult = await syncAllFeedbacks();

    const summary = {
        users: usersResult,
        posts: postsResult,
        projects: projectsResult,
        feedbacks: feedbacksResult,
    };

    logger.info('[gorse] 全量同步完成:', JSON.stringify(summary));
    return summary;
}

/**
 * 获取 Gorse 服务状态
 */
export async function getGorseStatus() {
    try {
        const client = await getClient();
        if (!client) {
            return { enabled: false, message: 'Gorse 服务未配置' };
        }

        // 尝试获取用户列表来检查连接
        await client.getUsers({ n: 1 });

        return {
            enabled: true,
            endpoint: await zcconfig.get('gorse.endpoint'),
            message: 'Gorse 服务运行正常',
        };
    } catch (error) {
        return {
            enabled: gorseEnabled,
            message: `Gorse 服务异常: ${error.message}`,
        };
    }
}

export default {
    FEEDBACK_TYPES,
    upsertUser,
    upsertUserItem,
    insertUsers,
    upsertPost,
    insertPosts,
    hidePost,
    upsertProject,
    insertProjects,
    hideProject,
    insertFeedback,
    insertFeedbacks,
    deleteFeedback,
    getRecommendedPostIds,
    getRecommendedProjectIds,
    getRecommendedUserIds,
    getLatestPostIds,
    feedbackPostLike,
    feedbackPostUnlike,
    feedbackPostBookmark,
    feedbackPostUnbookmark,
    feedbackPostReply,
    feedbackPostRetweet,
    feedbackPostQuote,
    feedbackPostRead,
    feedbackProjectStar,
    feedbackProjectUnstar,
    feedbackProjectRead,
    feedbackUserFollow,
    feedbackUserUnfollow,
    feedbackUserRecommendationView,
    syncAllUsers,
    syncAllPosts,
    syncAllProjects,
    syncAllFeedbacks,
    syncAll,
    getGorseStatus,
    isEnabled,
};
