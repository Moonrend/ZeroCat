import {prisma} from "../prisma.js";
import {updateDynamicConfigTypes, validateConfig} from "./configTypes.js";
import {EventEmitter} from "events";

class ConfigService extends EventEmitter {
    constructor() {
        super();
        this._cache = new Map();
        this._initialized = false;
        this._initializationPromise = null;
    }

    async init() {
        if (this._initialized) return;
        if (this._initializationPromise) return this._initializationPromise;
        this._initializationPromise = this._loadConfigs();
        try {
            return await this._initializationPromise;
        } finally {
            this._initializationPromise = null;
        }
    }

    async _loadConfigs() {
        try {
            // 从数据库加载所有配置
            const dbConfigs = await prisma.ow_config.findMany();

            // 更新帖子配置类型
            updateDynamicConfigTypes(dbConfigs);

            // 更新缓存
            for (const config of dbConfigs) {
                this._cache.set(config.key, validateConfig(config.key, config.value));
            }

            this._initialized = true;
        } catch (error) {
            console.error("Failed to initialize config service:", error);
            throw error;
        }
    }

    async get(key) {
        if (!this._initialized) {
            await this.init();
        }

        return this._cache.get(key);
    }

    async set(key, value) {
        if (!this._initialized) {
            await this.init();
        }

        const validatedValue = validateConfig(key, value);
        this._cache.set(key, validatedValue);

        // 触发配置更改事件
        this.emit("configChanged", {key, value: validatedValue});

        return validatedValue;
    }

    async reload() {
        this._initialized = false;
        this._cache.clear();
        await this.init();
        this.emit("configReloaded");
    }

    // 获取所有配置值
    async getAll() {
        if (!this._initialized) {
            await this.init();
        }

        const result = {};
        for (const [key, value] of this._cache.entries()) {
            result[key] = value;
        }
        return result;
    }

    // 获取公开的配置值
    async getPublicConfigs() {
        if (!this._initialized) {
            await this.init();
        }

        const result = {};
        for (const [key, config] of Object.entries(await this.getAll())) {
            if (config.public) {
                result[key] = config.value;
            }
        }
        return result;
    }
}

export const configService = new ConfigService();