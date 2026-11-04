import { prisma } from '../prisma.js';
import { activeRestrictionWhere } from '../moderation/restrictions.js';

// Request-local result, bound to both the viewer and the checked user IDs.
// Profiles without a user row still use the comment's display data unless restricted.
export async function getCommentProfileVisibility(userIds, viewerId = null) {
    const ids = new Set(userIds.map(Number).filter(Boolean));
    const viewer = Number(viewerId) || null;
    const candidates = [...ids].filter(id => id !== viewer);
    const hiddenUserIds = new Set();
    const restrictionWhere = activeRestrictionWhere('shadowban', 'profile');
    for (let offset = 0; offset < candidates.length; offset += 1000) {
        const restrictions = await prisma.ow_user_restrictions.findMany({
            where: { ...restrictionWhere, user_id: { in: candidates.slice(offset, offset + 1000) } },
            select: { user_id: true },
        });
        for (const restriction of restrictions) hiddenUserIds.add(restriction.user_id);
    }
    return { viewerId: viewer, userIds: ids, hiddenUserIds };
}
