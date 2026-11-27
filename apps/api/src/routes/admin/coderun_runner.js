import {Router} from 'express';
import {prisma} from '../../services/prisma.js';
import {randomBytes} from 'crypto';
import zcconfig from '../../services/config/zcconfig.js';
import logger from '../../services/logger.js';
import codeRunManager from '../../services/coderunManager.js';
import {getValue} from '../../services/cachekv.js'
import {needLogin} from '../../middleware/auth.js';
import {authorize} from '../../services/auth/authorization.js';
import {
    CODERUN_CAPABILITY_TTL_SECONDS,
    CODERUN_SUBPROTOCOL_PREFIX,
    consumeCodeRunCapability,
    issueCodeRunCapability,
} from '../../services/coderunCapability.js';

const router = Router();

function normalizeRunnerUrl(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.username = '';
        url.password = '';
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

async function getActiveRunners() {
    const allRunners = codeRunManager.getAllRunners();
    const devices = await prisma.ow_coderun_devices.findMany({
        where: {status: 'active', request_url: {not: ''}},
        orderBy: {created_at: 'asc'},
        select: {id: true, device_name: true, request_url: true},
    });

    return devices.flatMap((device) => {
        const requestUrl = normalizeRunnerUrl(device.request_url);
        const runnerStatus = allRunners[device.id];
        if (!requestUrl || !runnerStatus || runnerStatus.status !== 'active') return [];
        return [{id: device.id, device_name: device.device_name, request_url: requestUrl}];
    });
}

// Get active runners endpoint
router.get('/getrunners', needLogin, async (req, res) => {
    try {
        res.json({
            success: true,
            runners: await getActiveRunners()
        });
    } catch (error) {
        console.error('Error getting active runners:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

// Create a short-lived terminal capability using the caller's normal API session.
router.post('/session', needLogin, async (req, res) => {
    try {
        let projectId = null;
        if (req.body?.project_id !== null && req.body?.project_id !== undefined) {
            projectId = Number(req.body.project_id);
            if (!Number.isInteger(projectId) || projectId <= 0) {
                return res.status(400).json({success: false, error: 'Invalid project id'});
            }
        }

        const authorization = await authorize({
            userId: res.locals.userid,
            requiredScope: projectId ? `project:${projectId}:read` : 'project:read',
            tokenType: res.locals.tokenType,
            tokenScopes: res.locals.scopes || [],
        });
        if (!authorization.allowed) {
            return res.status(authorization.status).json({
                success: false,
                error: authorization.message,
                code: authorization.code,
            });
        }

        const [runner] = await getActiveRunners();
        if (!runner) {
            return res.status(503).json({success: false, error: 'No runner available'});
        }

        const {capability, record} = await issueCodeRunCapability({
            runnerId: runner.id,
            userId: res.locals.userid,
            projectId,
        });
        res.status(201).json({
            success: true,
            runner,
            capability,
            expires_at: record.expires_at,
            session_id: record.session_id,
        });
    } catch (error) {
        logger.error('Error creating CodeRun session:', error);
        res.status(503).json({success: false, error: 'Unable to create terminal session'});
    }
});

// Runner-only, one-time capability redemption for the terminal handshake.
router.post('/session/introspect', async (req, res) => {
    try {
        const runnerToken = req.headers.runner_token;
        if (typeof runnerToken !== 'string' || !runnerToken.trim()) {
            return res.status(401).json({success: false, error: 'Invalid runner token'});
        }
        const device = await prisma.ow_coderun_devices.findFirst({
            where: {runner_token: runnerToken, status: 'active'},
            select: {id: true},
        });
        if (!device) {
            return res.status(401).json({success: false, error: 'Invalid runner token'});
        }

        const session = await consumeCodeRunCapability(req.body?.capability, device.id);
        if (!session) {
            return res.status(401).json({success: false, error: 'Invalid or expired capability'});
        }

        res.json({success: true, active: true, session});
    } catch (error) {
        logger.error('Error introspecting CodeRun capability:', error);
        res.status(503).json({success: false, error: 'Unable to validate capability'});
    }
});

// Device registration endpoint
router.post('/register', async (req, res) => {
    try {
        const {auth_token, device_name, request_url} = req.body;

        // Verify auth token matches config
        const configAuthToken = await zcconfig.get('coderun.authtoken');
        if (!configAuthToken || auth_token !== configAuthToken) {
            return res.status(401).json({success: false, error: 'Invalid auth token'});
        }

        // Generate runner token
        const runnerToken = randomBytes(32).toString('hex');

        const device = await prisma.ow_coderun_devices.create({
            data: {
                device_name,
                request_url: request_url || '',
                runner_token: runnerToken,
                status: 'active'
            }
        });

        // Initialize device in manager
        await codeRunManager.updateRunnerStatus(device.id, 'active');

        res.json({
            success: true,
            device_id: device.id,
            runner_token: runnerToken
        });
    } catch (error) {
        console.error('Error registering device:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

// Device status report endpoint
router.post('/device', async (req, res) => {
    try {
        const {docker, system, coderun} = req.body;
        const {runner_token} = req.headers;
        if (typeof runner_token !== 'string' || !runner_token.trim()) {
            return res.status(401).json({success: false, error: 'Invalid runner token'});
        }

        // Verify runner token
        const device = await prisma.ow_coderun_devices.findFirst({
            where: {
                runner_token,
            }
        });

        if (!device) {
            return res.status(401).json({success: false, error: 'Invalid runner token or device not found'});
        }

        // Update device status using manager
        await codeRunManager.handleRunnerReport(device.id, {docker, system, coderun});

        res.json({success: true});
    } catch (error) {
        console.error('Error updating device status:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

// Device config fetch endpoint
router.get('/config', async (req, res) => {
    try {
        const {runner_token} = req.headers;
        if (typeof runner_token !== 'string' || !runner_token.trim()) {
            return res.status(401).json({success: false, error: 'Invalid runner token'});
        }

        // Verify runner token
        const device = await prisma.ow_coderun_devices.findFirst({
            where: {
                runner_token,
            }
        });

        if (!device) {
            return res.status(401).json({success: false, error: 'Invalid runner token or device not found'});
        }

        // Get default config
        const defaultConfig = {
            enabled: await zcconfig.get('coderun.enabled', true),
            poolSize: await zcconfig.get('coderun.pool_size', 5),
            reportInterval: await zcconfig.get('coderun.report_interval'),
            cloudconfig: await getValue(1, `coderun.cloudconfig`) || {}
        };

        // Merge with device-specific config
        const config = {
            ...defaultConfig,
            ...(device.device_config || {}),
            terminalAuth: {
                type: 'one-time-capability',
                transport: 'websocket-subprotocol',
                subprotocolPrefix: CODERUN_SUBPROTOCOL_PREFIX,
                introspectionPath: '/coderun/session/introspect',
                expiresIn: CODERUN_CAPABILITY_TTL_SECONDS,
                terminationMessageType: 'terminal.terminate',
            },
        };
        // Never expose API authorization signing material to runner devices,
        // including values left in legacy device-specific configuration.
        delete config.jwtSecret;

        res.json({success: true, config});
    } catch (error) {
        console.error('Error fetching device config:', error);
        res.status(500).json({success: false, error: 'Internal server error'});
    }
});

export default router;
