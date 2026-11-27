import {createHash, randomBytes} from 'crypto';
import redisClient from './redis.js';

export const CODERUN_CAPABILITY_TTL_SECONDS = 30;
export const CODERUN_CAPABILITY_PERMISSION = 'terminal:connect';
export const CODERUN_SUBPROTOCOL_PREFIX = 'zerocat-terminal-v1.';

const CAPABILITY_PREFIX = 'zcr_';
const CAPABILITY_PATTERN = /^zcr_[a-f0-9]{64}$/;
const CACHE_PREFIX = 'coderun:capability:';

function normalizeRunnerId(value) {
    const runnerId = typeof value === 'string' ? value.trim() : '';
    if (!runnerId) throw new TypeError('A runner id is required');
    return runnerId;
}

function normalizePositiveInteger(value, name, {nullable = false} = {}) {
    if (nullable && (value === null || value === undefined)) return null;
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
    }
    return normalized;
}

function capabilityKey(capability, runnerId) {
    const digest = createHash('sha256').update(capability).digest('hex');
    return `${CACHE_PREFIX}${runnerId}:${digest}`;
}

export function isCodeRunCapability(value) {
    return typeof value === 'string' && CAPABILITY_PATTERN.test(value);
}

export async function issueCodeRunCapability({runnerId, userId, projectId = null}) {
    const normalizedRunnerId = normalizeRunnerId(runnerId);
    const normalizedUserId = normalizePositiveInteger(userId, 'userId');
    const normalizedProjectId = normalizePositiveInteger(projectId, 'projectId', {nullable: true});

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const capability = CAPABILITY_PREFIX + randomBytes(32).toString('hex');
        const issuedAt = Date.now();
        const record = {
            audience: `coderun-runner:${normalizedRunnerId}`,
            permission: CODERUN_CAPABILITY_PERMISSION,
            runner_id: normalizedRunnerId,
            user_id: normalizedUserId,
            project_id: normalizedProjectId,
            session_id: randomBytes(16).toString('hex'),
            issued_at: issuedAt,
            expires_at: issuedAt + CODERUN_CAPABILITY_TTL_SECONDS * 1000,
        };
        const stored = await redisClient.setIfNotExists(
            capabilityKey(capability, normalizedRunnerId),
            record,
            CODERUN_CAPABILITY_TTL_SECONDS
        );
        if (stored) return {capability, record};
    }

    throw new Error('Unable to store CodeRun capability');
}

export async function consumeCodeRunCapability(capability, runnerId) {
    if (!isCodeRunCapability(capability)) return null;

    const normalizedRunnerId = normalizeRunnerId(runnerId);
    const record = await redisClient.getAndDelete(capabilityKey(capability, normalizedRunnerId));
    if (!record || record.runner_id !== normalizedRunnerId) return null;
    if (record.audience !== `coderun-runner:${normalizedRunnerId}`) return null;
    if (record.permission !== CODERUN_CAPABILITY_PERMISSION) return null;
    if (!Number.isFinite(record.expires_at) || record.expires_at <= Date.now()) return null;
    return record;
}
