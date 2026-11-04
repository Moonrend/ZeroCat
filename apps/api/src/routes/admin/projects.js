import {prisma} from '../../services/prisma.js';
import express from 'express';
import {summarizeGroups} from './groupedStats.js';
import { softDeleteContent, restoreContent } from '../../services/moderation/lifecycle.js';
import { assertCanWrite } from '../../services/moderation/restrictions.js';
import { requireScope } from '../../middleware/scope.js';

const router = express.Router();

// Get projects with filtering, sorting and pagination
router.get('/', requireScope('admin:hidden_content:read'), async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            sortBy = 'id',
            sortOrder = 'asc',
            search,
            state,
            type,
            authorid,
        } = req.query;

        // Build where clause based on filters
        const where = {};
        if (search) {
            where.OR = [
                {name: {contains: search}},
                {title: {contains: search}},
                {description: {contains: search}}
            ];
        }
        if (state) where.state = state;
        if (type) where.type = type;
        if (authorid) where.authorid = parseInt(authorid);
        if (req.query.deleted === 'true') where.deleted_at = { not: null };
        else if (req.query.deleted !== 'all') where.deleted_at = null;

        // Get total count for pagination
        const total = await prisma.ow_projects.count({where});

        // Get projects with sorting and pagination
        const projects = await prisma.ow_projects.findMany({
            where,
            include: {
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true
                    }
                }
            },
            orderBy: {
                [sortBy]: sortOrder.toLowerCase()
            },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        res.json({
            data: projects,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Get single project by ID
router.get('/:id', requireScope('admin:hidden_content:read'), async (req, res) => {
    try {
        const project = await prisma.ow_projects.findUnique({
            where: {id: parseInt(req.params.id)},
            include: {
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true
                    }
                },
                stars: true,
                lists: true,
                commits: true,
                branches: true,
                project_tags: true
            }
        });

        if (!project) {
            return res.status(404).json({error: 'Project not found'});
        }

        res.json(project);
    } catch (error) {
        console.error('Error fetching project:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Update project
router.put('/:id', requireScope('admin:content:manage'), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id);
        await assertCanWrite(res.locals.userid, 'project', 'update');
        const updateData = req.body;

        // Remove id as it's the primary key and shouldn't be updated
        delete updateData.id;

        // Validate the update data against the schema
        const allowedFields = [
            'name', 'default_branch', 'type', 'license', 'thumbnail',
            'authorid',  'state', 'view_count',
            'like_count', 'favo_count', 'time', 'title',
            'description', 'history',
            'fork', 'star_count'
        ];

        // Convert specific fields to their correct types
        if (updateData.authorid) updateData.authorid = parseInt(updateData.authorid);
        if (updateData.view_count) updateData.view_count = parseInt(updateData.view_count);
        if (updateData.like_count) updateData.like_count = parseInt(updateData.like_count);
        if (updateData.favo_count) updateData.favo_count = parseInt(updateData.favo_count);
        if (updateData.star_count) updateData.star_count = parseInt(updateData.star_count);
        if (updateData.fork) updateData.fork = parseInt(updateData.fork);
        if (updateData.time) updateData.time = new Date(updateData.time);
        if (updateData.history !== undefined) updateData.history = Boolean(updateData.history);

        // Filter out any fields that aren't in the allowed list
        const validUpdateData = Object.keys(updateData)
            .filter(key => allowedFields.includes(key))
            .reduce((obj, key) => {
                obj[key] = updateData[key];
                return obj;
            }, {});

        const updatedProject = await prisma.ow_projects.update({
            where: {id: projectId},
            data: validUpdateData,
            include: {
                author: {
                    select: {
                        id: true,
                        username: true,
                        display_name: true
                    }
                },
                stars: true,
                branches: true,
                project_tags: true
            }
        });

        res.json(updatedProject);
    } catch (error) {
        console.error('Error updating project:', error);
        if (error.status) return res.status(error.status).json({error: error.message, code: error.code});
        if (error.code === 'P2025') {
            res.status(404).json({error: 'Project not found'});
        } else if (error.code === 'P2003') {
            res.status(400).json({error: 'Invalid reference. Make sure the authorid exists.'});
        } else {
            res.status(500).json({error: 'Internal server error'});
        }
    }
});

// Delete project
router.delete('/:id', requireScope('admin:content:manage'), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id);

        await softDeleteContent('project', projectId, res.locals.userid, {
            administrative: true,
            authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] },
            reason: String(req.body?.reason || ''),
        });

        res.json({message: 'Project deleted successfully'});
    } catch (error) {
        console.error('Error deleting project:', error);
        if (error.status) return res.status(error.status).json({error: error.message, code: error.code});
        if (error.code === 'P2025') {
            res.status(404).json({error: 'Project not found'});
        } else {
            res.status(500).json({error: 'Internal server error'});
        }
    }
});

router.post('/:id/restore', requireScope('admin:content:manage'), async (req, res) => {
    try {
        const project = await restoreContent('project', Number(req.params.id), res.locals.userid, {
            administrative: true, reason: String(req.body?.reason || ''),
            authorizationContext: { tokenType: res.locals.tokenType, tokenScopes: res.locals.scopes || [] },
        });
        res.json({ status: 'success', data: project });
    } catch (error) {
        res.status(error.status || 400).json({ error: error.message, code: error.code });
    }
});

// Get project statistics
router.get('/stats/overview', requireScope('admin:hidden_content:read'), async (req, res) => {
    try {
        const stats = await prisma.$transaction([
            prisma.ow_projects.groupBy({
                by: ['state', 'type'],
                _count: true
            }),
            // Most viewed projects
            prisma.ow_projects.findMany({
                orderBy: {view_count: 'desc'},
                take: 5,
                select: {
                    id: true,
                    name: true,
                    title: true,
                    view_count: true
                }
            }),
            // Most starred projects
            prisma.ow_projects.findMany({
                orderBy: {star_count: 'desc'},
                take: 5,
                select: {
                    id: true,
                    name: true,
                    title: true,
                    star_count: true
                }
            })
        ]);

        const summary = summarizeGroups(stats[0], ['state', 'type']);
        res.json({
            totalProjects: summary.total,
            projectsByState: summary.groups[0],
            projectsByType: summary.groups[1],
            mostViewed: stats[1],
            mostStarred: stats[2]
        });
    } catch (error) {
        console.error('Error fetching project stats:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

export default router;
