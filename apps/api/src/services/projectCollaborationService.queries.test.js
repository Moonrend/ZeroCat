import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
const url = path => new URL(path, import.meta.url).href;
const state = {};
const db = {
    ow_projects: { async findUnique() { state.projectReads++; return state.project; } },
    ow_user_roles: { async deleteMany({ where }) {
        state.deletes.push(where);
        const matches = row => row.user_id === where.user_id && row.target_type === where.target_type
            && row.target_id === where.target_id && where.role.key.in.includes(row.role_key);
        state.grants = state.grants.filter(row => !matches(row));
    } },
    ow_project_collaboration_invitations: { async findMany(query) { state.invitationQueries.push(query); return state.invitations; } },
    async $transaction(work) {
        const before = structuredClone(state.grants);
        try { return await work(db); } catch (error) { state.grants = before; throw error; }
    },
};
mock.module(url('./prisma.js'), { namedExports: { prisma: db } });
mock.module(url('./logger.js'), { defaultExport: { warn() {} } });
mock.module(url('../controllers/notifications.js'), { namedExports: { async createNotification() {} } });
mock.module(url('./moderation/visibility.js'), { namedExports: {
    async canViewContent() { return true; },
    async sanitizeProfiles(users) { state.profileBatches++; return users.map(user => user?.id === state.hiddenProfile ? null : user); },
    async visibleWhere(kind, viewerId, options) { state.visibility.push({ kind, viewerId, options }); return { deleted_at: null }; },
} });
mock.module(url('./moderation/restrictions.js'), { namedExports: { async assertCanWrite() {} } });
mock.module(url('./auth/authorization.js'), { namedExports: { async authorize() { return { allowed: state.allowed }; } } });
mock.module(url('./auth/policyEngine.js'), { namedExports: {
    async assignScopedRole(userId, roleKey, options) {
        assert.equal(options.db, db);
        if (state.assignmentFails) throw new Error('assignment failed');
        state.grants.push({ user_id: userId, role_key: roleKey, target_type: options.targetType, target_id: options.targetId });
    },
    async getUserResourceRoleScopes() { return ['project:read']; },
    async listResourceGrants() { return []; },
    async listUserScopedGrants() { return []; },
} });
const service = await import('./projectCollaborationService.js');
const grant = (user_id, target_id, role_key, target_type = 'project') => ({ user_id, target_type, target_id, role_key });
beforeEach(() => Object.assign(state, {
    project: { id: 7, authorid: 1, type: 'scratch' }, projectReads: 0, deletes: [], allowed: true, assignmentFails: false,
    invitationQueries: [], invitations: [], visibility: [], hiddenProfile: null, profileBatches: 0,
    grants: [grant(2, '7', 'project_viewer'), grant(2, '7', 'project_editor'), grant(2, '7', 'project_manager'),
        grant(2, '8', 'project_editor'), grant(3, '7', 'project_editor'), grant(2, '7', 'custom_role'),
        grant(2, 'global', 'project_editor', 'global')],
}));

test('leaving removes collaboration roles with one delete and retains all other grant boundaries', async () => {
    await service.leaveProject({ projectId: 7, userId: 2 });
    assert.equal(state.deletes.length, 1);
    assert.equal(state.grants.length, 4);
    assert.deepEqual(state.grants, [grant(2, '8', 'project_editor'), grant(3, '7', 'project_editor'),
        grant(2, '7', 'custom_role'), grant(2, 'global', 'project_editor', 'global')]);
});

test('role change batches removals while keeping the selected role and rolls back if assignment fails', async () => {
    const before = structuredClone(state.grants);
    state.assignmentFails = true;
    await assert.rejects(service.updateMemberRole({ projectId: 7, actorId: 1, memberUserId: 2, roleKey: 'project_editor' }), /assignment failed/);
    assert.deepEqual(state.grants, before);
    assert.deepEqual(state.deletes[0].role.key.in.sort(), ['project_manager', 'project_viewer']);
});

test('member listing reuses the loaded project but still checks membership', async () => {
    await service.listProjectMembers(7, 1);
    assert.equal(state.projectReads, 1);
});

test('received invitations retain private invitations through actor-based project filters and batch profiles', async () => {
    state.invitations = [{ id: 11, role_key: 'project_viewer', project: {
        id: 7, state: 'private', author: { id: 9, username: 'hidden' },
    }, inviter: { id: 8, username: 'visible' } }];
    state.hiddenProfile = 9;
    const result = await service.listReceivedInvitations(2);
    assert.deepEqual(state.visibility, [{ kind: 'project', viewerId: 2, options: { ignorePrivacy: true } }]);
    assert.deepEqual(state.invitationQueries[0].where.project, { is: { deleted_at: null } });
    assert.equal(result[0].project.state, 'private');
    assert.equal(result[0].project.author, undefined);
    assert.equal(result[0].inviter.username, 'visible');
    assert.equal(state.profileBatches, 1);
});

test('owner removal and failed actor authorization do not delete grants', async () => {
    await assert.rejects(service.leaveProject({ projectId: 7, userId: 1 }), { status: 400 });
    state.allowed = false;
    await assert.rejects(service.removeMember({ projectId: 7, actorId: 4, memberUserId: 2 }), { status: 403 });
    assert.equal(state.deletes.length, 0);
});
