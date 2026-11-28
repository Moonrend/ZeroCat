import Redis from 'ioredis';
import logger from './logger.js';
import zcconfig from './config/zcconfig.js';

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

const CONSUME_VERIFICATION_CODE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
    return {'missing'}
end

local decoded, challenge = pcall(cjson.decode, raw)
if not decoded or type(challenge) ~= 'table' then
    redis.call('DEL', KEYS[1])
    return {'invalid'}
end

local function reject_challenge()
    local attempts = tonumber(challenge.attemptsRemaining) or tonumber(ARGV[4])
    local ttl = redis.call('PTTL', KEYS[1])
    attempts = attempts - 1

    if attempts <= 0 or ttl <= 0 then
        redis.call('DEL', KEYS[1])
        return {'locked', '0'}
    end

    challenge.attemptsRemaining = attempts
    redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', ttl)
    return {'invalid', tostring(attempts)}
end

if tostring(challenge.purpose or '') ~= ARGV[2] then
    return reject_challenge()
end
if ARGV[3] ~= '' and tostring(challenge.userId or '') ~= ARGV[3] then
    return reject_challenge()
end
if tostring(challenge.code or '') ~= ARGV[1] then
    return reject_challenge()
end

redis.call('DEL', KEYS[1])
return {'valid', cjson.encode(challenge)}
`;

class RedisService {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.initConnection();
    }

    async initConnection() {
        try {
            const host = await zcconfig.get('redis.host') || 'localhost';
            const port = await zcconfig.get('redis.port') || 6379;
            const password = await zcconfig.get('redis.password') || '';
            const db = 0;

            const options = {
                host,
                port,
                db: parseInt(db),
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            };

            if (password) {
                options.password = password;
            }

            this.client = new Redis(options);

            this.client.on('connect', () => {
                this.isConnected = true;
                logger.info('[redis] Redis连接成功');
            });

            this.client.on('error', (err) => {
                this.isConnected = false;
                logger.error('[redis] Redis连接错误:', err);
            });

            this.client.on('reconnecting', () => {
                logger.info('[redis] 正在重新连接Redis...');
            });
        } catch (error) {
            logger.error('[redis] 初始化Redis连接失败:', error);
        }
    }

    // 设置键值，支持过期时间（秒）
    async set(key, value, ttlSeconds = null) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            if (typeof value !== 'string') {
                value = JSON.stringify(value);
            }

            if (ttlSeconds) {
                await this.client.setex(key, ttlSeconds, value);
            } else {
                await this.client.set(key, value);
            }
            return true;
        } catch (error) {
            logger.error(`[redis] Redis set错误 [${key}]:`, error);
            return false;
        }
    }

    // 仅当键不存在时设置键值，支持过期时间（秒）
    async setIfNotExists(key, value, ttlSeconds = null) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            if (typeof value !== 'string') {
                value = JSON.stringify(value);
            }

            const args = ttlSeconds
                ? [key, value, 'EX', ttlSeconds, 'NX']
                : [key, value, 'NX'];
            const result = await this.client.set(...args);
            return result === 'OK';
        } catch (error) {
            logger.error(`[redis] Redis setIfNotExists错误 [${key}]:`, error);
            return false;
        }
    }

    // 获取键值
    async get(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            const value = await this.client.get(key);
            if (!value) return null;

            try {
                return JSON.parse(value);
            } catch (e) {
                return value; // 如果不是JSON则返回原始值
            }
        } catch (error) {
            logger.error(`[redis] Redis get错误 [${key}]:`, error);
            return null;
        }
    }

    // Atomically read and remove a value. Security capabilities use this to
    // guarantee that concurrent consumers cannot redeem the same value twice.
    async getAndDelete(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            const value = await this.client.eval(
                'local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); end; return value',
                1,
                key
            );
            if (!value) return null;

            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } catch (error) {
            logger.error(`[redis] Redis getAndDelete错误 [${key}]:`, error);
            throw error;
        }
    }

    // 删除键
    async delete(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            await this.client.del(key);
            return true;
        } catch (error) {
            logger.error(`[redis] Redis delete错误 [${key}]:`, error);
            return false;
        }
    }

    // 批量删除键
    async deleteMany(keys) {
        try {
            if (!Array.isArray(keys) || keys.length === 0) {
                return true;
            }
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            await this.client.del(...keys);
            return true;
        } catch (error) {
            logger.error('[redis] Redis deleteMany错误:', error);
            return false;
        }
    }

    // 检查键是否存在
    async exists(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            const exists = await this.client.exists(key);
            return exists === 1;
        } catch (error) {
            logger.error(`[redis] Redis exists错误 [${key}]:`, error);
            return false;
        }
    }

    // 设置键的过期时间
    async expire(key, ttlSeconds) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            await this.client.expire(key, ttlSeconds);
            return true;
        } catch (error) {
            logger.error(`[redis] Redis expire错误 [${key}]:`, error);
            return false;
        }
    }

    // 获取键的过期时间
    async ttl(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            return await this.client.ttl(key);
        } catch (error) {
            logger.error(`[redis] Redis ttl错误 [${key}]:`, error);
            return -2; // -2表示键不存在
        }
    }

    // 递增
    async incr(key) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            return await this.client.incr(key);
        } catch (error) {
            logger.error(`[redis] Redis incr错误 [${key}]:`, error);
            return null;
        }
    }

    // 递增指定值
    async incrby(key, increment) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            return await this.client.incrby(key, increment);
        } catch (error) {
            logger.error(`[redis] Redis incrby错误 [${key}]:`, error);
            return null;
        }
    }

    // 原子递增计数器，并仅在首次递增时设置过期时间
    async incrementWithExpiry(key, ttlSeconds) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            return await this.client.eval(INCREMENT_WITH_EXPIRY_SCRIPT, 1, key, ttlSeconds);
        } catch (error) {
            logger.error(`[redis] Redis incrementWithExpiry错误 [${key}]:`, error);
            return null;
        }
    }

    // 原子验证、计次并消费一次性邮件验证码
    async consumeVerificationCode(key, { code, purpose, userId = null, maxAttempts }) {
        try {
            if (!this.client || !this.isConnected) {
                throw new Error('[redis] Redis未连接');
            }

            const result = await this.client.eval(
                CONSUME_VERIFICATION_CODE_SCRIPT,
                1,
                key,
                String(code),
                String(purpose),
                userId === null || userId === undefined ? '' : String(userId),
                String(maxAttempts)
            );

            if (!Array.isArray(result) || !result[0]) {
                return { status: 'error' };
            }

            const [status, payload] = result;
            if (status === 'valid') {
                return { status, data: JSON.parse(payload) };
            }

            return {
                status,
                attemptsRemaining: payload === undefined ? undefined : Number(payload)
            };
        } catch (error) {
            logger.error(`[redis] Redis consumeVerificationCode错误 [${key}]:`, error);
            return { status: 'error' };
        }
    }
}

// 创建单例实例
const redisClient = new RedisService();

export default redisClient;
