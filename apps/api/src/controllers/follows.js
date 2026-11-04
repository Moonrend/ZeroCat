import {prisma} from "../services/prisma.js";
import logger from "../services/logger.js";
import {createEvent} from "./events.js";
import gorseService from "../services/gorse.js";
import { buildAvatarURL } from "../utils/avatarUrl.js";
import { visibleWhere, canViewContent, assertCanWrite } from "../services/moderation/visibility.js";

// 延迟导入 AP 关注同步模块，避免循环依赖
let _apFollowSync = null;
async function getApFollowSync() {
    if (!_apFollowSync) {
        try {
            _apFollowSync = await import('../services/activitypub/followSync.js');
        } catch (err) {
            logger.debug('[follows] ActivityPub followSync 模块不可用:', err.message);
            _apFollowSync = {};
        }
    }
    return _apFollowSync;
}

let _queueManager = null;
async function getQueueManager() {
    if (!_queueManager) {
        try {
            const mod = await import('../services/queue/queueManager.js');
            _queueManager = mod.default;
        } catch (err) {
            logger.debug('[follows] queueManager 模块不可用:', err.message);
            _queueManager = {};
        }
    }
    return _queueManager;
}

let _apRemoteUser = null;
async function getApRemoteUser() {
    if (!_apRemoteUser) {
        try {
            _apRemoteUser = await import('../services/activitypub/remoteUser.js');
        } catch (err) {
            logger.debug('[follows] ActivityPub remoteUser 模块不可用:', err.message);
            _apRemoteUser = {};
        }
    }
    return _apRemoteUser;
}

function formatFollowerName(user) {
    const displayName = typeof user?.display_name === "string" ? user.display_name.trim() : "";
    const username = typeof user?.username === "string" ? user.username.trim() : "";
    return displayName || username || "有人";
}

/**
 * Follow a user
 *
 * @param {number} followerId - User ID following
 * @param {number} followedId - User ID being followed
 * @param {string} note - Note to add to the follow relationship
 * @returns {Promise<Object>} Follow information
 */
export async function followUser(followerId, followedId, note = "") {
    await assertCanWrite(Number(followerId), "relations", "create");
    try {
        // Don't allow following yourself
        if (followerId === followedId) {
            throw new Error("不能关注自己");
        }

        // Check if followed user exists
        const followedUser = await prisma.ow_users.findFirst({
            where: {id: followedId, AND: [await visibleWhere("profile", followerId)] },
        });

        if (!followedUser) {
            throw new Error("用户不存在");
        }

        // Check if already following
        const existingFollow = await prisma.ow_user_relationships.findUnique({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: followerId,
                    target_user_id: followedId,
                    relationship_type: "follow",
                },
            },
        });

        if (existingFollow) {
            // If already following and note provided, update the note
            if (note) {
                return await updateFollowNote(followerId, followedId, note);
            }
            return existingFollow;
        }

        const followerUser = await prisma.ow_users.findUnique({
            where: { id: followerId },
            select: { username: true, display_name: true },
        });
        const followerName = formatFollowerName(followerUser);

        // Create relationship record with note
        const relationship = await prisma.ow_user_relationships.create({
            data: {
                source_user_id: followerId,
                target_user_id: followedId,
                relationship_type: "follow",
                metadata: {
                    note: note || "",
                },
            },
        });

        // 关注用户时，自动启用该用户的增强通知。
        await prisma.ow_notification_settings.upsert({
            where: {
                user_id_target_type_target_id: {
                    user_id: followerId,
                    target_type: "USER",
                    target_id: String(followedId)
                }
            },
            update: {
                level: "ENHANCED"
            },
            create: {
                user_id: followerId,
                target_type: "USER",
                target_id: String(followedId),
                level: "ENHANCED"
            }
        });

        await createEvent(
            "user_follow",
            followerId,
            "user",
            followedId,
            {
                notification_title: `${followerName} 开始关注你`,
                notification_content: `${followerName} 开始关注你`,
            }
        );

        logger.debug(`Created follow notification for user ${followedId}`);

        // 如果被关注的用户是远程代理用户，异步同步关注到远端 ActivityPub 实例
        try {
            const qm = await getQueueManager();
            if (qm.enqueueApFollowSync) {
                await qm.enqueueApFollowSync(followerId, followedId);
            } else {
                // 队列不可用时降级为同步调用
                const apSync = await getApFollowSync();
                if (apSync.syncFollowToRemote) {
                    await apSync.syncFollowToRemote(followerId, followedId);
                }
            }
        } catch (apErr) {
            logger.warn(`[follows] AP 关注同步入队失败 (非致命):`, apErr.message);
        }

        // Gorse 反馈：关注用户
        gorseService.feedbackUserFollow(followerId, followedId).catch(e => {
            logger.debug('[gorse] follow feedback failed:', e.message);
        });

        return relationship;
    } catch (error) {
        logger.error("Error in followUser:", error);
        throw error;
    }
}

/**
 * Unfollow a user
 *
 * @param {number} followerId - User ID unfollowing
 * @param {number} followedId - User ID being unfollowed
 * @returns {Promise<Object>} Unfollow information
 */
export async function unfollowUser(followerId, followedId) {
    await assertCanWrite(Number(followerId), "relations", "delete");
    try {
        // 如果取消关注的用户是远程代理用户，异步同步取消关注到远端
        try {
            const qm = await getQueueManager();
            if (qm.enqueueApUnfollowSync) {
                await qm.enqueueApUnfollowSync(followerId, followedId);
            } else {
                // 队列不可用时降级为同步调用
                const apSync = await getApFollowSync();
                if (apSync.syncUnfollowToRemote) {
                    await apSync.syncUnfollowToRemote(followerId, followedId);
                }
            }
        } catch (apErr) {
            logger.warn(`[follows] AP 取消关注同步入队失败 (非致命):`, apErr.message);
        }

        // Delete relationship if it exists
        const result = await prisma.ow_user_relationships.deleteMany({
            where: {
                source_user_id: followerId,
                target_user_id: followedId,
                relationship_type: "follow",
            },
        });

        // 取消关注时，如果该用户通知等级是 ENHANCED，则删除配置回到默认 BASIC。
        await prisma.ow_notification_settings.deleteMany({
            where: {
                user_id: followerId,
                target_type: "USER",
                target_id: String(followedId),
                level: "ENHANCED",
            },
        });

        // Gorse 反馈：取消关注
        if (result.count > 0) {
            gorseService.feedbackUserUnfollow(followerId, followedId).catch(e => {
                logger.debug('[gorse] unfollow feedback failed:', e.message);
            });
        }

        return {count: result.count};
    } catch (error) {
        logger.error("Error in unfollowUser:", error);
        throw error;
    }
}

/**
 * Block a user
 *
 * @param {number} blockerId - User ID blocking
 * @param {number} blockedId - User ID being blocked
 * @param {string} reason - Reason for blocking
 * @returns {Promise<Object>} Block information
 */
export async function blockUser(blockerId, blockedId, reason = "") {
    await assertCanWrite(Number(blockerId), "relations", "create");
    try {
        // Don't allow blocking yourself
        if (blockerId === blockedId) {
            throw new Error("不能拉黑自己");
        }

        // Check if blocked user exists
        const blockedUser = await prisma.ow_users.findUnique({
            where: {id: blockedId},
        });

        if (!blockedUser) {
            throw new Error("用户不存在");
        }

        // Check if already blocked
        const existingBlock = await prisma.ow_user_relationships.findUnique({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: blockerId,
                    target_user_id: blockedId,
                    relationship_type: "block",
                },
            },
        });

        if (existingBlock) {
            // If already blocked and reason provided, update the reason
            if (reason) {
                return await updateBlockReason(blockerId, blockedId, reason);
            }
            return existingBlock;
        }

        // If the blocker follows the blocked user, automatically unfollow
        await prisma.ow_user_relationships.deleteMany({
            where: {
                source_user_id: blockerId,
                target_user_id: blockedId,
                relationship_type: "follow",
            },
        });

        // Create relationship record with reason
        const relationship = await prisma.ow_user_relationships.create({
            data: {
                source_user_id: blockerId,
                target_user_id: blockedId,
                relationship_type: "block",
                metadata: {
                    reason: reason || "",
                },
            },
        });

        return relationship;
    } catch (error) {
        logger.error("Error in blockUser:", error);
        throw error;
    }
}

/**
 * Unblock a user
 *
 * @param {number} blockerId - User ID unblocking
 * @param {number} blockedId - User ID being unblocked
 * @returns {Promise<Object>} Unblock information
 */
export async function unblockUser(blockerId, blockedId) {
    await assertCanWrite(Number(blockerId), "relations", "delete");
    try {
        // Delete relationship if it exists
        const result = await prisma.ow_user_relationships.deleteMany({
            where: {
                source_user_id: blockerId,
                target_user_id: blockedId,
                relationship_type: "block",
            },
        });

        return {count: result.count};
    } catch (error) {
        logger.error("Error in unblockUser:", error);
        throw error;
    }
}

/**
 * Get user followers
 *
 * @param {number} userId - User ID
 * @param {number} limit - Maximum number of followers to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Object>} Followers information
 */
export async function getUserFollowers(userId, limit = 20, offset = 0, viewerId = null) {
    try {
        const profileVisibility = await visibleWhere("profile", viewerId);
        const where = {
            target_user_id: userId,
            relationship_type: "follow",
            AND: [await visibleWhere("relation", viewerId), { source_user: profileVisibility }, { target_user: profileVisibility }],
        };
        const relationships = await prisma.ow_user_relationships.findMany({
            where,
            include: {
                // Join with ow_users to get follower details
                // Note: This doesn't work directly with Prisma, we need to adjust the query
            },
            orderBy: {created_at: "desc"},
            take: limit,
            skip: offset,
        });

        // Since we don't have direct relations in the model, we need to get users separately
        const followerIds = relationships.map((rel) => rel.source_user_id);

        // Get user details for all followers
        const followerDetails = await prisma.ow_users.findMany({
            where: {
                id: {in: followerIds},
            },
            select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
            },
        });

        // Create a map of user IDs to user details
        const userMap = followerDetails.reduce((map, user) => {
            map[user.id] = user;
            return map;
        }, {});

        // Combine relationship data with user details
        const followers = relationships.map((rel) => ({
            ...rel,
            user: userMap[rel.source_user_id],
        }));

        // Add avatarURL to each user
        await Promise.all(followers.map(async (f) => {
            if (f.user) {
                f.user = { ...f.user, avatarURL: await buildAvatarURL(f.user.avatar) };
            }
        }));

        // Get total count
        const totalCount = await prisma.ow_user_relationships.count({ where });

        // 检查是否为远程代理用户，附加远端粉丝数量
        let remoteFollowersCount = null;
        try {
            const apRemoteUser = await getApRemoteUser();
            if (apRemoteUser.isRemoteProxyUser && apRemoteUser.getRemoteFollowCounts) {
                const isRemote = await apRemoteUser.isRemoteProxyUser(userId);
                if (isRemote) {
                    const remoteCounts = await apRemoteUser.getRemoteFollowCounts(userId);
                    remoteFollowersCount = remoteCounts.followersCount;
                }
            }
        } catch { /* AP 模块不可用，忽略 */ }

        return {
            followers,
            total: totalCount,
            remote_total: remoteFollowersCount,
            limit,
            offset,
        };
    } catch (error) {
        logger.error("Error in getUserFollowers:", error);
        throw error;
    }
}

/**
 * Get users followed by a user
 *
 * @param {number} userId - User ID
 * @param {number} limit - Maximum number of followed users to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Object>} Following information
 */
export async function getUserFollowing(userId, limit = 20, offset = 0, viewerId = null) {
    try {
        const profileVisibility = await visibleWhere("profile", viewerId);
        const where = {
            source_user_id: userId,
            relationship_type: "follow",
            AND: [await visibleWhere("relation", viewerId), { source_user: profileVisibility }, { target_user: profileVisibility }],
        };
        const relationships = await prisma.ow_user_relationships.findMany({
            where,
            orderBy: {created_at: "desc"},
            take: limit,
            skip: offset,
        });

        // Get the IDs of followed users
        const followedIds = relationships.map((rel) => rel.target_user_id);

        // Get user details for all followed users
        const followedDetails = await prisma.ow_users.findMany({
            where: {
                id: {in: followedIds},
            },
            select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
            },
        });

        // Create a map of user IDs to user details
        const userMap = followedDetails.reduce((map, user) => {
            map[user.id] = user;
            return map;
        }, {});

        // Combine relationship data with user details
        const following = relationships.map((rel) => ({
            ...rel,
            user: userMap[rel.target_user_id],
        }));

        // Add avatarURL to each user
        await Promise.all(following.map(async (f) => {
            if (f.user) {
                f.user = { ...f.user, avatarURL: await buildAvatarURL(f.user.avatar) };
            }
        }));

        // Get total count
        const totalCount = await prisma.ow_user_relationships.count({ where });

        // 检查是否为远程代理用户，附加远端关注数量
        let remoteFollowingCount = null;
        try {
            const apRemoteUser = await getApRemoteUser();
            if (apRemoteUser.isRemoteProxyUser && apRemoteUser.getRemoteFollowCounts) {
                const isRemote = await apRemoteUser.isRemoteProxyUser(userId);
                if (isRemote) {
                    const remoteCounts = await apRemoteUser.getRemoteFollowCounts(userId);
                    remoteFollowingCount = remoteCounts.followingCount;
                }
            }
        } catch { /* AP 模块不可用，忽略 */ }

        return {
            following,
            total: totalCount,
            remote_total: remoteFollowingCount,
            limit,
            offset,
        };
    } catch (error) {
        logger.error("Error in getUserFollowing:", error);
        throw error;
    }
}

/**
 * Get users blocked by a user
 *
 * @param {number} userId - User ID
 * @param {number} limit - Maximum number of blocked users to return
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Object>} Blocked users information
 */
export async function getUserBlocked(userId, limit = 20, offset = 0) {
    try {
        // Find all users who the source user has blocked
        const relationships = await prisma.ow_user_relationships.findMany({
            where: {
                source_user_id: userId,
                relationship_type: "block",
            },
            orderBy: {created_at: "desc"},
            take: limit,
            skip: offset,
        });

        // Get the IDs of blocked users
        const blockedIds = relationships.map((rel) => rel.target_user_id);

        // Get user details for all blocked users
        const blockedDetails = await prisma.ow_users.findMany({
            where: {
                id: {in: blockedIds},
            },
            select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
                bio: true,
            },
        });

        // Create a map of user IDs to user details
        const userMap = blockedDetails.reduce((map, user) => {
            map[user.id] = user;
            return map;
        }, {});

        // Combine relationship data with user details
        const blocked = relationships.map((rel) => ({
            ...rel,
            user: userMap[rel.target_user_id],
        }));

        // Add avatarURL to each user
        await Promise.all(blocked.map(async (b) => {
            if (b.user) {
                b.user = { ...b.user, avatarURL: await buildAvatarURL(b.user.avatar) };
            }
        }));

        // Get total count
        const totalCount = await prisma.ow_user_relationships.count({
            where: {
                source_user_id: userId,
                relationship_type: "block",
            },
        });

        return {
            blocked,
            total: totalCount,
            limit,
            offset,
        };
    } catch (error) {
        logger.error("Error in getUserBlocked:", error);
        throw error;
    }
}

/**
 * Check if a user is following another user
 *
 * @param {number} followerId - Follower user ID
 * @param {number} followedId - Followed user ID
 * @returns {Promise<boolean>} Whether the follower is following the followed user
 */
export async function isFollowing(followerId, followedId) {
    try {
        const relationship = await prisma.ow_user_relationships.findUnique({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: followerId,
                    target_user_id: followedId,
                    relationship_type: "follow",
                },
            },
        });

        return !!relationship;
    } catch (error) {
        logger.error("Error in isFollowing:", error);
        throw error;
    }
}

/**
 * Check if a user has blocked another user
 *
 * @param {number} blockerId - Blocker user ID
 * @param {number} blockedId - Blocked user ID
 * @returns {Promise<boolean>} Whether the blocker has blocked the blocked user
 */
export async function isBlocking(blockerId, blockedId) {
    try {
        const relationship = await prisma.ow_user_relationships.findUnique({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: blockerId,
                    target_user_id: blockedId,
                    relationship_type: "block",
                },
            },
        });

        return !!relationship;
    } catch (error) {
        logger.error("Error in isBlocking:", error);
        throw error;
    }
}

/**
 * Get all relationships between two users
 *
 * @param {number} userId1 - First user ID
 * @param {number} userId2 - Second user ID
 * @returns {Promise<Object>} Relationships between the two users
 */
export async function getRelationshipsBetweenUsers(userId1, userId2) {
    try {
        const relationships = await prisma.ow_user_relationships.findMany({
            where: {
                OR: [
                    { source_user_id: userId1, target_user_id: userId2 },
                    { source_user_id: userId2, target_user_id: userId1 },
                ],
            },
        });
        const outgoingRelationships = relationships.filter((rel) => rel.source_user_id === userId1);
        const incomingRelationships = relationships.filter((rel) => rel.source_user_id === userId2);

        // Format into easy-to-use object
        const relationshipMap = {
            outgoing: outgoingRelationships.reduce((map, rel) => {
                map[rel.relationship_type] = true;
                return map;
            }, {}),
            incoming: incomingRelationships.reduce((map, rel) => {
                map[rel.relationship_type] = true;
                return map;
            }, {}),
        };

        return {
            isFollowing: !!relationshipMap.outgoing.follow,
            isFollowedBy: !!relationshipMap.incoming.follow,
            isBlocking: !!relationshipMap.outgoing.block,
            isBlockedBy: !!relationshipMap.incoming.block,
            isMuting: !!relationshipMap.outgoing.mute,
            hasFavorited: !!relationshipMap.outgoing.favorite,
            relationships: {
                outgoing: outgoingRelationships,
                incoming: incomingRelationships,
            },
        };
    } catch (error) {
        logger.error("Error in getRelationshipsBetweenUsers:", error);
        throw error;
    }
}

/**
 * Update follow note
 *
 * @param {number} followerId - User ID following
 * @param {number} followedId - User ID being followed
 * @param {string} note - Note to add to the follow relationship
 * @returns {Promise<Object>} Updated follow relationship
 */
export async function updateFollowNote(followerId, followedId, note) {
    await assertCanWrite(Number(followerId), "relations", "update");
    try {
        const updatedRelationship = await prisma.ow_user_relationships.update({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: followerId,
                    target_user_id: followedId,
                    relationship_type: "follow",
                },
            },
            data: {
                metadata: {
                    note: note || "",
                },
                updated_at: new Date(),
            },
        });

        return updatedRelationship;
    } catch (error) {
        if (error.code === "P2025") throw new Error("关注关系不存在");
        logger.error("Error in updateFollowNote:", error);
        throw error;
    }
}

/**
 * Update block reason
 *
 * @param {number} blockerId - User ID blocking
 * @param {number} blockedId - User ID being blocked
 * @param {string} reason - Reason for blocking
 * @returns {Promise<Object>} Updated block relationship
 */
export async function updateBlockReason(blockerId, blockedId, reason) {
    await assertCanWrite(Number(blockerId), "relations", "update");
    try {
        const updatedRelationship = await prisma.ow_user_relationships.update({
            where: {
                source_user_id_target_user_id_relationship_type: {
                    source_user_id: blockerId,
                    target_user_id: blockedId,
                    relationship_type: "block",
                },
            },
            data: {
                metadata: {
                    reason: reason || "",
                },
                updated_at: new Date(),
            },
        });

        return updatedRelationship;
    } catch (error) {
        if (error.code === "P2025") throw new Error("拉黑关系不存在");
        logger.error("Error in updateBlockReason:", error);
        throw error;
    }
}

/**
 * Get relationship notes
 *
 * @param {number} userId - User ID requesting the notes
 * @param {number} targetUserId - Target user ID
 * @returns {Promise<Object>} Notes information
 */
export async function getRelationshipNotes(userId, targetUserId) {
    try {
        const relationships = await prisma.ow_user_relationships.findMany({
            where: {
                source_user_id: userId,
                target_user_id: targetUserId,
                relationship_type: { in: ["follow", "block"] },
            },
            select: { relationship_type: true, metadata: true, created_at: true, updated_at: true },
        });
        const followRelationship = relationships.find((rel) => rel.relationship_type === "follow");
        const blockRelationship = relationships.find((rel) => rel.relationship_type === "block");

        return {
            follow: followRelationship
                ? {
                    note: followRelationship.metadata?.note || "",
                    created_at: followRelationship.created_at,
                    updated_at: followRelationship.updated_at,
                }
                : null,
            block: blockRelationship
                ? {
                    reason: blockRelationship.metadata?.reason || "",
                    created_at: blockRelationship.created_at,
                    updated_at: blockRelationship.updated_at,
                }
                : null,
        };
    } catch (error) {
        logger.error("Error in getRelationshipNotes:", error);
        throw error;
    }
}

export default {
    // Follow
    followUser,
    unfollowUser,
    getUserFollowers,
    getUserFollowing,
    isFollowing,

    // Block
    blockUser,
    unblockUser,
    getUserBlocked,
    isBlocking,

    // General
    getRelationshipsBetweenUsers,
    updateFollowNote,
    updateBlockReason,
    getRelationshipNotes,
};
