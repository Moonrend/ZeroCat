import {Router} from "express";
import {prisma} from "../../services/prisma.js";
import logger from "../../services/logger.js";
import { setReviewStatus, getAutoApproveUsers, setAutoApproveUsers } from "../../services/extensionReview.js";

const router = Router();

/**
 * @api {get} /admin/extensions List extensions with pagination, sorting and filtering
 * @apiName GetExtensions
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiQuery {Number} page Current page number (1-based)
 * @apiQuery {Number} itemsPerPage Items per page
 * @apiQuery {String} sortBy Field to sort by
 * @apiQuery {String} sortDesc Sort direction (true for descending)
 * @apiQuery {String} search Search term for project title/description
 * @apiQuery {String} status Filter by status
 * @apiQuery {Number} projectid Filter by project ID
 * @apiQuery {Number} authorid Filter by author ID
 *
 * @apiSuccess {Object[]} items List of extensions
 * @apiSuccess {Number} total Total number of extensions matching filters
 */
router.get("/", async (req, res) => {
    try {
        const {
            page = 1,
            itemsPerPage = 10,
            sortBy = "id",
            sortDesc = false,
            search = "",
            status,
            projectid,
            authorid,
        } = req.query;

        // Build filter conditions
        const where = {
            AND: [],
        };

        if (search) {
            where.AND.push({
                project: {
                    OR: [
                        {title: {contains: search}},
                        {description: {contains: search}},
                        {name: {contains: search}},
                    ],
                },
            });
        }

        if (status) {
            where.AND.push({status});
        }

        if (projectid) {
            where.AND.push({projectid: parseInt(projectid)});
        }

        if (authorid) {
            where.AND.push({
                project: {
                    authorid: parseInt(authorid),
                },
            });
        }

        // Build sort object
        const orderBy = {
            [sortBy]: sortDesc ? "desc" : "asc",
        };

        // Execute query with pagination
        const [items, total] = await Promise.all([
            prisma.ow_scratch_extensions.findMany({
                where,
                orderBy,
                skip: (page - 1) * itemsPerPage,
                take: Number(itemsPerPage),
                include: {
                    project: {
                        include: {
                            author: {
                                select: {
                                    id: true,
                                    username: true,
                                    display_name: true,
                                    email: true,
                                },
                            },
                        },
                    },
                    sample_project: {
                        include: {
                            author: {
                                select: {
                                    id: true,
                                    username: true,
                                    display_name: true,
                                },
                            },
                        },
                    },
                },
            }),
            prisma.ow_scratch_extensions.count({where}),
        ]);

        res.json({
            items,
            total,
            pagination: {
                page: parseInt(page),
                itemsPerPage: parseInt(itemsPerPage),
                totalPages: Math.ceil(total / itemsPerPage),
            },
        });
    } catch (error) {
        logger.error("Error fetching extensions:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/extensions/auto-approve-users Get auto-approve users
 * @apiName GetAutoApproveUsers
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiSuccess {String[]} data List of usernames that are auto-approved
 */
router.get("/auto-approve-users", async (req, res) => {
    try {
        const usernames = await getAutoApproveUsers();
        res.json({
            status: "success",
            data: usernames,
        });
    } catch (error) {
        logger.error("Error fetching auto-approve users:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/extensions/auto-approve-users Update auto-approve users
 * @apiName UpdateAutoApproveUsers
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiBody {String[]} usernames List of usernames to auto-approve
 *
 * @apiSuccess {String[]} data Updated list of usernames
 */
router.put("/auto-approve-users", async (req, res) => {
    try {
        const {usernames} = req.body;
        if (!Array.isArray(usernames)) {
            return res.status(400).json({
                error: "usernames must be an array",
            });
        }
        await setAutoApproveUsers(usernames);
        res.json({
            status: "success",
            message: "Auto-approve users updated successfully",
            data: usernames,
        });
    } catch (error) {
        logger.error("Error updating auto-approve users:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/extensions/:id Get extension by ID
 * @apiName GetExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiParam {Number} id Extension ID
 *
 * @apiSuccess {Object} data Extension data
 */
router.get("/:id", async (req, res) => {
    try {
        const {id} = req.params;

        const extension = await prisma.ow_scratch_extensions.findUnique({
            where: {id: parseInt(id)},
            include: {
                project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                                email: true,
                                status: true,
                                type: true,
                            },
                        },
                    },
                },
                sample_project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
            },
        });

        if (!extension) {
            return res.status(404).json({error: "Extension not found"});
        }

        res.json({
            status: "success",
            data: extension,
        });
    } catch (error) {
        logger.error("Error fetching extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {post} /admin/extensions Create new extension
 * @apiName CreateExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiBody {Number} projectid Project ID
 * @apiBody {String} [branch] Branch name
 * @apiBody {String} [commit] Commit hash
 * @apiBody {String} [image] Extension image URL
 * @apiBody {Number} [samples] Sample project ID
 * @apiBody {String} [docs] Documentation URL
 * @apiBody {Boolean} [scratchCompatible] Scratch compatibility flag
 * @apiBody {String} [status] Extension status
 *
 * @apiSuccess {Object} data Created extension
 */
router.post("/", async (req, res) => {
    try {
        const {
            projectid,
            branch = "",
            commit = "latest",
            image = "",
            samples,
            docs,
            scratchCompatible = false,
            status = "developing",
        } = req.body;

        if (!projectid) {
            return res.status(400).json({
                error: "Project ID is required",
            });
        }

        // Check if project exists
        const project = await prisma.ow_projects.findUnique({
            where: {id: parseInt(projectid)},
        });

        if (!project) {
            return res.status(400).json({
                error: "Project not found",
            });
        }

        // Check if extension already exists for this project
        const existingExtension = await prisma.ow_scratch_extensions.findFirst({
            where: {projectid: parseInt(projectid)},
        });

        if (existingExtension) {
            return res.status(400).json({
                error: "Extension already exists for this project",
            });
        }

        // Validate samples project if provided
        if (samples) {
            const samplesProject = await prisma.ow_projects.findUnique({
                where: {id: parseInt(samples)},
            });

            if (!samplesProject) {
                return res.status(400).json({
                    error: "Sample project not found",
                });
            }
        }

        const extension = await prisma.ow_scratch_extensions.create({
            data: {
                projectid: parseInt(projectid),
                branch,
                commit,
                image,
                samples: samples ? parseInt(samples) : null,
                docs,
                scratchCompatible,
                status,
            },
            include: {
                project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
                sample_project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
            },
        });

        res.status(201).json({
            status: "success",
            message: "Extension created successfully",
            data: extension,
        });
    } catch (error) {
        logger.error("Error creating extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {put} /admin/extensions/:id Update extension
 * @apiName UpdateExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiParam {Number} id Extension ID
 * @apiBody {Number} [projectid] Project ID
 * @apiBody {String} [branch] Branch name
 * @apiBody {String} [commit] Commit hash
 * @apiBody {String} [image] Extension image URL
 * @apiBody {Number} [samples] Sample project ID
 * @apiBody {String} [docs] Documentation URL
 * @apiBody {Boolean} [scratchCompatible] Scratch compatibility flag
 * @apiBody {String} [status] Extension status
 *
 * @apiSuccess {Object} data Updated extension
 */
router.put("/:id", async (req, res) => {
    try {
        const {id} = req.params;
        const {
            projectid,
            branch,
            commit,
            image,
            samples,
            docs,
            scratchCompatible,
            status,
        } = req.body;

        // Check if extension exists
        const existingExtension = await prisma.ow_scratch_extensions.findUnique({
            where: {id: parseInt(id)},
        });

        if (!existingExtension) {
            return res.status(404).json({
                error: "Extension not found",
            });
        }

        // Validate project if projectid is being updated
        if (projectid) {
            const project = await prisma.ow_projects.findUnique({
                where: {id: parseInt(projectid)},
            });

            if (!project) {
                return res.status(400).json({
                    error: "Project not found",
                });
            }

            // Check if another extension already exists for this project
            const duplicateExtension = await prisma.ow_scratch_extensions.findFirst({
                where: {
                    projectid: parseInt(projectid),
                    id: {not: parseInt(id)},
                },
            });

            if (duplicateExtension) {
                return res.status(400).json({
                    error: "Another extension already exists for this project",
                });
            }
        }

        // Validate samples project if provided
        if (samples !== undefined) {
            if (samples) {
                const samplesProject = await prisma.ow_projects.findUnique({
                    where: {id: parseInt(samples)},
                });

                if (!samplesProject) {
                    return res.status(400).json({
                        error: "Sample project not found",
                    });
                }
            }
        }

        const updateData = {};
        if (projectid !== undefined) updateData.projectid = parseInt(projectid);
        if (branch !== undefined) updateData.branch = branch;
        if (commit !== undefined) updateData.commit = commit;
        if (image !== undefined) updateData.image = image;
        if (samples !== undefined) updateData.samples = samples ? parseInt(samples) : null;
        if (docs !== undefined) updateData.docs = docs;
        if (scratchCompatible !== undefined) updateData.scratchCompatible = scratchCompatible;
        if (status !== undefined) updateData.status = status;

        const updatedExtension = await prisma.ow_scratch_extensions.update({
            where: {id: parseInt(id)},
            data: updateData,
            include: {
                project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
                sample_project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
            },
        });

        res.json({
            status: "success",
            message: "Extension updated successfully",
            data: updatedExtension,
        });
    } catch (error) {
        logger.error("Error updating extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {delete} /admin/extensions/:id Delete extension
 * @apiName DeleteExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiParam {Number} id Extension ID
 *
 * @apiSuccess {String} message Success message
 */
router.delete("/:id", async (req, res) => {
    try {
        const {id} = req.params;

        // Check if extension exists
        const extension = await prisma.ow_scratch_extensions.findUnique({
            where: {id: parseInt(id)},
        });

        if (!extension) {
            return res.status(404).json({
                error: "Extension not found",
            });
        }

        await prisma.ow_scratch_extensions.delete({
            where: {id: parseInt(id)},
        });

        res.json({
            status: "success",
            message: "Extension deleted successfully",
        });
    } catch (error) {
        logger.error("Error deleting extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {post} /admin/extensions/:id/approve Approve extension
 * @apiName ApproveExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiParam {Number} id Extension ID
 *
 * @apiSuccess {Object} data Updated extension
 */
router.post("/:id/approve", async (req, res) => {
    try {
        const {id} = req.params;

        const extension = await prisma.ow_scratch_extensions.findUnique({
            where: {id: parseInt(id)},
        });

        if (!extension) {
            return res.status(404).json({
                error: "Extension not found",
            });
        }

        if (extension.status === "verified") {
            return res.status(400).json({
                error: "Extension is already approved",
            });
        }

        // Write review status to ow_target_configs
        if (extension.projectid) {
            await setReviewStatus(extension.projectid, "approved");
        }

        const updatedExtension = await prisma.ow_scratch_extensions.update({
            where: {id: parseInt(id)},
            data: {status: "verified"},
            include: {
                project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
            },
        });

        res.json({
            status: "success",
            message: "Extension approved successfully",
            data: updatedExtension,
        });
    } catch (error) {
        logger.error("Error approving extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {post} /admin/extensions/:id/reject Reject extension
 * @apiName RejectExtension
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiParam {Number} id Extension ID
 * @apiBody {String} [reason] Rejection reason
 *
 * @apiSuccess {Object} data Updated extension
 */
router.post("/:id/reject", async (req, res) => {
    try {
        const {id} = req.params;
        const {reason} = req.body;

        const extension = await prisma.ow_scratch_extensions.findUnique({
            where: {id: parseInt(id)},
        });

        if (!extension) {
            return res.status(404).json({
                error: "Extension not found",
            });
        }

        if (extension.status === "rejected") {
            return res.status(400).json({
                error: "Extension is already rejected",
            });
        }

        // Write review status to ow_target_configs
        if (extension.projectid) {
            await setReviewStatus(extension.projectid, "rejected", reason);
        }

        const updatedExtension = await prisma.ow_scratch_extensions.update({
            where: {id: parseInt(id)},
            data: {status: "rejected"},
            include: {
                project: {
                    include: {
                        author: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                            },
                        },
                    },
                },
            },
        });

        res.json({
            status: "success",
            message: "Extension rejected successfully",
            data: updatedExtension,
        });
    } catch (error) {
        logger.error("Error rejecting extension:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

/**
 * @api {get} /admin/extensions/stats Get extension statistics
 * @apiName GetExtensionStats
 * @apiGroup AdminExtensions
 * @apiPermission admin
 *
 * @apiSuccess {Object} data Extension statistics
 */
router.get("/stats/overview", async (req, res) => {
    try {
        const groups = await prisma.ow_scratch_extensions.groupBy({
            by: ["status", "scratchCompatible"],
            _count: true,
        });
        const data = { total: 0, developing: 0, pending: 0, verified: 0, rejected: 0, scratchCompatible: 0 };
        const statuses = new Set(["developing", "pending", "verified", "rejected"]);
        for (const group of groups) {
            data.total += group._count;
            if (statuses.has(group.status)) data[group.status] += group._count;
            if (group.scratchCompatible === true) data.scratchCompatible += group._count;
        }

        res.json({ status: "success", data });
    } catch (error) {
        logger.error("Error fetching extension stats:", error);
        res.status(500).json({error: "Internal server error"});
    }
});

export default router;
