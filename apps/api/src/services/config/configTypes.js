// Configuration type definitions and validation rules

// 特殊类型转换函数
const typeTransformers = {
    array: (value) => {
        if (Array.isArray(value)) return value;
        return String(value)
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    },
    boolean: (value) => {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
            return value.toLowerCase() === "true" || value === "1";
        }
        if (typeof value === "number") {
            return value === 1;
        }
        return false;
    },
    number: (value) => {
        if (typeof value === "number") return value;
        if (typeof value === "string") {
            const num = parseFloat(value);
            return isNaN(num) ? 0 : num;
        }
        return 0;
    },
    string: (value) => {
        if (value == null) return "";
        return String(value);
    },
    enum: (value, options) => {
        const strValue = String(value);
        if (!options || !Array.isArray(options) || !options.includes(strValue)) {
            return options?.[0] || "";
        }
        return strValue;
    },
};

// 基础配置类型定义
export const CONFIG_TYPES = {
    "urls.frontend": {
        type: "string",
        required: true,
        default: "http://localhost:3141",
        description: "前端应用URL地址，用于生成各类跳转链接",
        validate: (value) =>
            value.startsWith("http://") || value.startsWith("https://"),
        public: true,
    },
    "urls.backend": {
        type: "string",
        required: true,
        default: "http://localhost:3000",
        description: "后端API服务URL地址，用于生成API回调地址",
        validate: (value) =>
            value.startsWith("http://") || value.startsWith("https://"),
        public: true,
    },


    "security.jwttoken": {
        type: "string",
        required: true,
        description: "JWT签名密钥，用于生成和验证JWT令牌，应用启动时生成",
        default:
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15),
        validate: (value) => value && value.length > 0,
    },
    "security.adminusers": {
        type: "array",
        required: false,
        default: [1],
        description: "管理员用户列表，用于权限控制，支持邮箱或用户ID",
        transform: (value) => {
            const arr = typeTransformers.array(value);
            return arr.map((v) => (typeof v === "string" ? v.toLowerCase() : v));
        },
    },
    "security.accessTokenExpiry": {
        type: "number",
        required: false,
        default: 900,
        description: "访问令牌有效期（秒），默认15分钟",
        transform: typeTransformers.number,
        validate: (value) => value > 0,
    },
    "security.refreshTokenExpiry": {
        type: "number",
        required: false,
        default: 31536000,
        description: "刷新令牌有效期（秒），默认365天（1年）",
        transform: typeTransformers.number,
        validate: (value) => value > 0,
    },
    "security.refreshTokenExtensionEnabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用刷新令牌延期功能",
        transform: typeTransformers.boolean,
    },
    "security.refreshTokenMaxExtensionDays": {
        type: "number",
        required: false,
        default: 90,
        description: "刷新令牌最大延期天数",
        transform: typeTransformers.number,
        validate: (value) => value > 0,
    },
    "s3.endpoint": {
        type: "string",
        required: true,
        description: "S3存储服务端点地址",
    },
    "s3.region": {
        type: "string",
        required: true,
        description: "S3存储服务区域",
    },
    "s3.forcePathStyle": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否强制使用Path-Style访问S3（兼容MinIO/非子域名端点）",
        transform: typeTransformers.boolean,
    },
    "s3.AWS_ACCESS_KEY_ID": {
        type: "string",
        required: true,
        description: "S3访问密钥ID",
    },
    "s3.AWS_SECRET_ACCESS_KEY": {
        type: "string",
        required: true,
        description: "S3访问密钥密文",
    },
    "s3.bucket": {
        type: "string",
        required: true,
        description: "S3存储桶名称",
    },
    "storage.projects.bucket": {
        type: "string",
        required: false,
        default: "",
        description: "项目正文专用私有S3桶，必须与公开素材s3.bucket不同；使用相同S3端点和凭据，禁止匿名读取。新文件写入前必须配置",
    },
    "s3.staticurl": {
        type: "string",
        required: true,
        description: "S3静态资源访问URL前缀",
        public: true,
    },
    "redis.host": {
        type: "string",
        required: false,
        default: "localhost",
        description: "Redis服务器地址",
    },
    "sentry.dsn": {
        type: "string",
        required: false,
        default: "",
        description: "Sentry DSN 地址",
    },
    "redis.port": {
        type: "number",
        required: false,
        default: 6379,
        description: "Redis服务器端口",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value < 65536,
    },
    "redis.password": {
        type: "string",
        required: false,
        default: "",
        description: "Redis服务器密码",
    },
    "mail.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用邮件功能",
        transform: typeTransformers.boolean,
    },
    "mail.host": {
        type: "string",
        required: false,
        description: "SMTP服务器地址，例如: smtp.gmail.com",
        validate: (value) => value && value.length > 0,
    },
    "mail.port": {
        type: "number",
        required: false,
        default: 587,
        description: "SMTP服务器端口，常用端口: 25, 465(SSL), 587(TLS)",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value < 65536,
    },
    "mail.secure": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否使用SSL/TLS加密连接",
        transform: typeTransformers.boolean,
    },
    "mail.auth.user": {
        type: "string",
        required: false,
        description: "SMTP服务器登录用户名/邮箱地址",
        validate: (value) => value && value.length > 0,
    },
    "mail.auth.pass": {
        type: "string",
        required: false,
        description: "SMTP服务器登录密码或应用专用密码",
        validate: (value) => value && value.length > 0,
    },
    "mail.from_name": {
        type: "string",
        required: false,
        description: "发件人名称",
        validate: (value) => value && value.length > 0,
    },
    "mail.from_address": {
        type: "string",
        required: false,
        description: "发件人地址",
        validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    },
    "mail.provider": {
        type: "string",
        required: false,
        default: "smtp",
        description: "邮件发送方式: smtp 或 amail",
        validate: (value) => ["smtp", "amail"].includes(value),
    },
    "amail.api_key": {
        type: "string",
        required: false,
        description: "Amail API Key (以 am_ 开头)",
        validate: (value) => value && value.startsWith("am_"),
    },
    "amail.base_url": {
        type: "string",
        required: false,
        default: "http://localhost:4000",
        description: "Amail 服务器地址",
    },
    "amail.provider_id": {
        type: "string",
        required: false,
        default: "auto",
        description: "Amail SMTP Provider ID，默认 auto 自动选择",
    },
    "site.name": {
        type: "string",
        required: true,
        description: "站点名称，用于显示和邮件模板",
        public: true,
    },
    "site.domain": {
        type: "string",
        required: true,
        description: "站点域名，用于生成链接和验证",
        public: true,
    },
    "site.email": {
        type: "string",
        required: true,
        description: "站点联系邮箱",
        validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        public: true,
    },
    "site.slogan": {
        type: "string",
        required: false,
        description: "站点标语",
        public: true,
    },
    "site.privacy": {
        type: "string",
        required: false,
        description: "隐私政策URL",
        public: true,
    },
    "site.tos": {
        type: "string",
        required: false,
        description: "服务条款URL",
        public: true,
    },
    // CodeRun Configuration
    "coderun.authtoken": {
        type: "string",
        required: false,
        description: "CodeRun设备注册认证令牌",
        default: Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15) + '请删掉这个后缀后保存',
        validate: (value) => value && value.length > 0,
    },
    "coderun.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用CodeRun服务",
        transform: typeTransformers.boolean,
    },
    "coderun.pool_size": {
        type: "number",
        required: false,
        default: 5,
        description: "CodeRun容器池大小",
        transform: typeTransformers.number,
        validate: (value) => value >= 0 && value <= 100,
    },
    "coderun.report_interval": {
        type: "number",
        required: false,
        default: 60000,
        description: "CodeRun设备状态上报间隔（毫秒）",
        transform: typeTransformers.number,
        validate: (value) => value >= 5000 && value <= 3600000,
    },
    "captcha.GEE_API_SERVER": {
        type: "string",
        required: false,
        description: "极验验证API服务器地址",
    },
    "captcha.GEE_CAPTCHA_ID": {
        type: "string",
        required: false,
        description: "极验验证ID",
        public: true,
    },
    "captcha.GEE_CAPTCHA_KEY": {
        type: "string",
        required: false,
        description: "极验验证密钥",
    },
    "feedback.txcid": {
        type: "string",
        required: false,
        description: "腾讯兔小巢ID",
    },
    "feedback.txckey": {
        type: "string",
        required: false,
        description: "腾讯兔小巢密钥",
    },
    "oauth.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用OAuth登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.google.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Google登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.google.client_id": {
        type: "string",
        required: false,
        description: "Google OAuth客户端ID",
    },
    "oauth.google.client_secret": {
        type: "string",
        required: false,
        description: "Google OAuth客户端密钥",
    },
    "oauth.microsoft.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Microsoft登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.microsoft.client_id": {
        type: "string",
        required: false,
        description: "Microsoft OAuth客户端ID",
    },
    "oauth.microsoft.client_secret": {
        type: "string",
        required: false,
        description: "Microsoft OAuth客户端密钥",
    },
    "oauth.github.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用GitHub登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.github.client_id": {
        type: "string",
        required: false,
        description: "GitHub OAuth客户端ID",
    },
    "oauth.github.client_secret": {
        type: "string",
        required: false,
        description: "GitHub OAuth客户端密钥",
    },
    "oauth.houlang.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用厚浪登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.houlang.client_id": {
        type: "string",
        required: false,
        description: "厚浪 Logto OIDC 应用ID",
    },
    "oauth.houlang.client_secret": {
        type: "string",
        required: false,
        description: "厚浪 Logto OIDC 应用密钥",
    },
    "oauth.dynamic.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Dynamic登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.dynamic.client_id": {
        type: "string",
        required: false,
        description: "Dynamic Logto OIDC 应用ID",
    },
    "oauth.dynamic.client_secret": {
        type: "string",
        required: false,
        description: "Dynamic Logto OIDC 应用密钥",
    },
    "git.sync.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Git仓库同步",
        transform: typeTransformers.boolean,
    },
    "git.sync.github.api_base": {
        type: "string",
        required: false,
        default: "https://api.github.com",
        description: "GitHub API基础地址",
        validate: (value) => value.startsWith("http://") || value.startsWith("https://"),
    },
    "git.sync.github.app.id": {
        type: "string",
        required: false,
        description: "GitHub App ID",
    },
    "git.sync.github.app.slug": {
        type: "string",
        required: false,
        description: "GitHub App Slug",
    },
    "git.sync.github.app.client_id": {
        type: "string",
        required: false,
        description: "GitHub App OAuth Client ID",
        public: false,
    },
    "git.sync.github.app.client_secret": {
        type: "string",
        required: false,
        description: "GitHub App OAuth Client Secret",
        public: false,
    },
    "git.sync.github.app.user_scope": {
        type: "string",
        required: false,
        default: "repo read:user user:email",
        description: "GitHub App User Token OAuth scope",
    },
    "git.sync.github.app.private_key": {
        type: "string",
        required: false,
        description: "GitHub App 私钥",
        public: false,
    },
    "git.sync.queue.concurrency": {
        type: "number",
        required: false,
        default: 1,
        description: "Git同步队列并发数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 10,
    },
    "git.sync.queue.limiter.max": {
        type: "number",
        required: false,
        default: 6,
        description: "Git同步队列限流最大任务数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 60,
    },
    "git.sync.queue.limiter.duration_ms": {
        type: "number",
        required: false,
        default: 60000,
        description: "Git同步队列限流窗口(ms)",
        transform: typeTransformers.number,
        validate: (value) => value >= 1000,
    },
    "git.sync.scratch.max_assets": {
        type: "number",
        required: false,
        default: 200,
        description: "Scratch项目单次同步最大素材数量",
        transform: typeTransformers.number,
        validate: (value) => value >= 0 && value <= 5000,
    },
    "git.sync.scratch.max_asset_bytes": {
        type: "number",
        required: false,
        default: 20 * 1024 * 1024,
        description: "Scratch素材单文件最大字节数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1024,
    },
    "oauth.40code.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用40code登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.40code.client_id": {
        type: "string",
        required: false,
        description: "40code OAuth客户端ID",
    },
    "oauth.40code.client_secret": {
        type: "string",
        required: false,
        description: "40code OAuth客户端密钥",
    },
    "oauth.linuxdo.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Linux.do登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.linuxdo.client_id": {
        type: "string",
        required: false,
        description: "Linux.do OAuth客户端ID",
    },
    "oauth.linuxdo.client_secret": {
        type: "string",
        required: false,
        description: "Linux.do OAuth客户端密钥",
    },
    "oauth.twitter.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Twitter登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.twitter.client_id": {
        type: "string",
        required: false,
        description: "Twitter OAuth客户端ID",
    },
    "oauth.twitter.client_secret": {
        type: "string",
        required: false,
        description: "Twitter OAuth客户端密钥",
    },
    "oauth.bluesky.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用Bluesky登录",
        transform: typeTransformers.boolean,
        public: true,
    },
    "oauth.bluesky.client_id": {
        type: "string",
        required: false,
        description: "Bluesky OAuth客户端ID（兼容字段，建议改用oauth.bluesky.client_metadata_url）",
    },
    "oauth.bluesky.client_name": {
        type: "string",
        required: false,
        description: "Bluesky OAuth client metadata中的client_name",
    },
    "oauth.bluesky.client_secret": {
        type: "string",
        required: false,
        description: "Bluesky OAuth客户端密钥",
    },
    "oauth.bluesky.default_pds": {
        type: "string",
        required: false,
        default: "https://bsky.social",
        description: "Bluesky默认PDS地址",
        validate: (value) => value.startsWith("http://") || value.startsWith("https://"),
        public: true,
    },
    "maxmind.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用MaxMind地理位置服务",
        transform: typeTransformers.boolean,
    },
    "maxmind.license_key": {
        type: "string",
        required: false,
        description: "MaxMind服务授权密钥",
    },
    "maxmind.account_id": {
        type: "string",
        required: false,
        description: "MaxMind账户ID",
        transform: (value) => value?.toString(),
    },
    "sitemap.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用站点地图功能",
        transform: typeTransformers.boolean,
    },
    "sitemap.auto_update": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用自动更新站点地图",
        transform: typeTransformers.boolean,
    },
    "sitemap.update_cron": {
        type: "string",
        required: false,
        default: "0 0 * * *", // 每天凌晨执行
        description: "站点地图自动更新的cron表达式",
        validate: (value) => /^(\S+ ){4}\S+$/.test(value), // 简单验证cron格式
    },
    "sitemap.current_file_hash": {
        type: "string",
        required: false,
        description: "当前站点地图文件的SHA256哈希值",
    },
    "sitemap.last_full_update": {
        type: "string",
        required: false,
        description: "最后一次全量更新时间",
    },
    "sitemap.last_incremental_update": {
        type: "string",
        required: false,
        description: "最后一次增量更新时间",
    },
    "search.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用搜索功能",
        transform: typeTransformers.boolean,
        public: true,
    },
    "search.meilisearch.url": {
        type: "string",
        required: false,
        description: "Meilisearch服务器地址",
        public: true,
    },
    "search.meilisearch.api_key": {
        type: "string",
        required: false,
        description: "Meilisearch API密钥",
        public: true,
    },
    "search.meilisearch.index_name": {
        type: "string",
        required: false,
        description: "Meilisearch索引名称",
        public: true,
    },
    "scratchproxy.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用ScratchProxy",
        transform: typeTransformers.boolean,
        public: true,
    },
    "scratchproxy.url": {
        type: "string",
        required: false,
        description: "ScratchProxy服务器地址",
        public: true,
        validate: (value) => value.startsWith("http://") || value.startsWith("https://"),
    },
    "scratchproxy.gui": {
        type: "string",
        required: false,
        description: "ScratchProxy GUI地址",
        public: true,
        validate: (value) => value.startsWith("http://") || value.startsWith("https://"),
    },
    cors: {
        type: "array",
        required: true,
        default: ["*"],
        description: "CORS跨域配置，支持*或具体域名列表（逗号分隔）",
        transform: (value) => {
            if (Array.isArray(value)) return value;
            if (typeof value === "string") {
                if (value === "*") return ["*"];
                return value
                    .split(",")
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0);
            }
            return ["*"];
        },
        public: true,
    },
    "webpush.vapid_public_key": {
        type: "string",
        required: false,
        description: "Web Push VAPID公钥",
        public: true,
    },
    "webpush.vapid_private_key": {
        type: "string",
        required: false,
        description: "Web Push VAPID私钥",
        public: false,
    },
    "webpush.vapid_subject": {
        type: "string",
        required: false,
        description: "Web Push VAPID主题",
        public: true,
    },
    "webauthn.rpId": {
        type: "string",
        required: false,
        description: "WebAuthn RP ID",
        public: true,
    },
    "webauthn.rpName": {
        type: "string",
        required: false,
        description: "WebAuthn RP Name",
        public: true,
    },
    "webauthn.origins": {
        type: "array",
        required: false,
        description: "WebAuthn RP Origins",
        public: true,
    },
    // BullMQ Configuration
    "bullmq.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用BullMQ任务队列",
        transform: typeTransformers.boolean,
    },
    "bullmq.redis.db": {
        type: "number",
        required: false,
        default: 0,
        description: "BullMQ使用的Redis数据库编号",
        transform: typeTransformers.number,
        validate: (value) => value >= 0 && value <= 15,
    },
    "bullmq.email.concurrency": {
        type: "number",
        required: false,
        default: 3,
        description: "邮件Worker并发数",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value <= 20,
    },
    "bullmq.email.maxRetries": {
        type: "number",
        required: false,
        default: 3,
        description: "邮件失败最大重试次数",
        transform: typeTransformers.number,
        validate: (value) => value >= 0 && value <= 10,
    },
    "bullmq.email.retryDelay": {
        type: "number",
        required: false,
        default: 60000,
        description: "邮件重试基础延迟(ms)",
        transform: typeTransformers.number,
        validate: (value) => value >= 1000,
    },
    "bullmq.dashboard.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用BullMQ仪表板",
        transform: typeTransformers.boolean,
    },
    "mirror40code.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用40code镜像同步器",
        transform: typeTransformers.boolean,
    },
    "mirror40code.base_url": {
        type: "string",
        required: false,
        default: "https://api.abc.520gxx.com",
        description: "40code镜像源API基础地址",
        validate: (value) => value.startsWith("http://") || value.startsWith("https://"),
    },
    "mirror40code.token": {
        type: "string",
        required: false,
        default: "",
        description: "40code镜像源访问token",
    },
    "mirror40code.timeout_ms": {
        type: "number",
        required: false,
        default: 15000,
        description: "40code接口请求超时毫秒数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1000,
    },
    "mirror40code.work_user_l": {
        type: "number",
        required: false,
        default: 20,
        description: "调用/work/user时的l参数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 200,
    },
    "mirror40code.max_pages": {
        type: "number",
        required: false,
        default: 500,
        description: "按作者搜索项目时最大翻页数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 500,
    },
    "mirror40code.search.page_size": {
        type: "number",
        required: false,
        default: 100,
        description: "40code /search 接口每页请求条数",
        transform: typeTransformers.number,
        validate: (value) => value >= 20 && value <= 200,
    },
    "mirror40code.daily.user_scan.max_pages": {
        type: "number",
        required: false,
        default: 500,
        description: "每日用户搜索扫描的最大页数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 5000,
    },
    "mirror40code.daily.project_scan.max_pages": {
        type: "number",
        required: false,
        default: 500,
        description: "每日项目搜索扫描的最大页数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 5000,
    },
    "mirror40code.queue.concurrency": {
        type: "number",
        required: false,
        default: 2,
        description: "40code镜像队列并发数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 20,
    },
    "mirror40code.periodic.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用40code定期同步",
        transform: typeTransformers.boolean,
    },
    "mirror40code.periodic.daily_sync.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用40code每日同步任务",
        transform: typeTransformers.boolean,
    },
    "mirror40code.periodic.daily_sync.interval_ms": {
        type: "number",
        required: false,
        default: 604800000,
        description: "40code用户同步任务间隔(毫秒)，默认7天",
        transform: typeTransformers.number,
        validate: (value) => value >= 60000,
    },
    // Comment Service Configuration
    "commentservice.akismet.keys": {
        type: "array",
        required: false,
        default: [],
        description: "Akismet API 密钥池",
        transform: typeTransformers.array,
    },
    "commentservice.sensitive_words": {
        type: "json",
        required: false,
        default: [],
        description: "全局敏感词列表（字符串数组）",
    },
    "commentservice.sensitive_ban_duration": {
        type: "number",
        required: false,
        default: 3600,
        description: "敏感词触发后IP封禁时长（秒）",
        transform: typeTransformers.number,
        validate: (value) => value > 0,
    },
    // 海外代理配置
    "proxy.url": {
        type: "string",
        required: false,
        description: "HTTP/HTTPS代理URL (例如: http://proxy.example.com:8080 或 http://user:pass@proxy.example.com:8080)",
        validate: (value) => !value || value.startsWith('http://') || value.startsWith('https://'),
    },
    "oauth.proxy.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否为OAuth请求启用代理",
        transform: typeTransformers.boolean,
    },
    // ActivityPub 联邦协议配置
    "ap.federation.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用ActivityPub联邦协议，启用后本站内容可被其他Fediverse实例发现和订阅",
        transform: typeTransformers.boolean,
        public: true,
    },
    "ap.auto_accept_follows": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否自动接受来自远程实例的关注请求",
        transform: typeTransformers.boolean,
    },
    "ap.instance.domain": {
        type: "string",
        required: false,
        description: "ActivityPub实例域名，留空则从urls.backend自动推断。一旦启用联邦后不应更改",
        validate: (value) => !value || /^[a-zA-Z0-9.-]+(:\d+)?$/.test(value),
        public: true,
    },
    "ap.instance.name": {
        type: "string",
        required: false,
        default: "ZeroCat",
        description: "ActivityPub实例显示名称，在NodeInfo和Actor中展示",
        public: true,
    },
    "ap.instance.description": {
        type: "string",
        required: false,
        default: "",
        description: "ActivityPub实例描述信息",
        public: true,
    },
    "ap.instance.public_key": {
        type: "string",
        required: false,
        description: "ActivityPub实例RSA公钥(PEM格式)，用于HTTP Signature验证，自动生成",
    },
    "ap.instance.private_key": {
        type: "string",
        required: false,
        description: "ActivityPub实例RSA私钥(PEM格式)，用于HTTP Signature签名，自动生成",
    },
    // 联邦实例策略配置
    "ap.federation.instance_policy": {
        type: "string",
        required: false,
        default: "open",
        description: "联邦实例策略: open(不限制), allowlist(仅白名单), blocklist(排除黑名单)",
        validate: (value) => ["open", "allowlist", "blocklist"].includes(value),
        public: true,
    },
    "ap.federation.instance_allowlist": {
        type: "string",
        required: false,
        default: "",
        description: "允许的联邦实例域名列表，逗号分隔。仅在instance_policy=allowlist时生效",
    },
    "ap.federation.instance_blocklist": {
        type: "string",
        required: false,
        default: "",
        description: "阻止的联邦实例域名列表，逗号分隔。仅在instance_policy=blocklist时生效",
    },
    "ap.federation.auto_fetch_posts": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否在关注远程用户时自动拉取其帖子",
        transform: typeTransformers.boolean,
    },
    "ap.federation.max_fetch_posts": {
        type: "number",
        required: false,
        default: 50,
        description: "每次拉取远程用户帖子的最大数量",
        transform: typeTransformers.number,
    },
    "ap.federation.fetch_interval_minutes": {
        type: "number",
        required: false,
        default: 30,
        description: "远程帖子定期拉取间隔（分钟）",
        transform: typeTransformers.number,
    },
    "ap.federation.allow_remote_search": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否允许搜索远程联邦用户（@user@domain格式）",
        transform: typeTransformers.boolean,
        public: true,
    },
    "gorse.secret"  : {
        type: "string",
        required: false,
        description: "Gorse推荐系统访问密钥，用于保护推荐接口安全，启用后需要在推荐请求中提供此密钥",
        default: ""
    },
    "gorse.endpoint": {
        type: "string",
        required: false,
        description: "Gorse推荐系统服务地址，启用推荐功能时必填，格式应为http://host:port",
        validate: (value) =>
            !value || (value.startsWith("http://") || value.startsWith("https://")),
        public: false,
    },
    // Embedding 向量生成配置
    "embedding.enabled": {
        type: "boolean",
        required: false,
        default: false,
        description: "是否启用 Embedding 向量生成功能",
        transform: typeTransformers.boolean,
    },
    "embedding.provider": {
        type: "string",
        required: false,
        default: "openai",
        description: "Embedding 提供商类型: openai | aliyun（DashScope）",
        validate: (value) => {
            const normalized = String(value || '').toLowerCase();
            return normalized === 'openai' || normalized === 'aliyun' || normalized === 'dashscope';
        },
    },
    "embedding.api_base": {
        type: "string",
        required: false,
        default: "https://api.openai.com/v1",
        description: "Embedding API 基础地址（OpenAI 兼容格式），例如 Ollama: http://localhost:11434/v1",
        validate: (value) =>
            !value || (value.startsWith("http://") || value.startsWith("https://")),
    },
    "embedding.api_key": {
        type: "string",
        required: false,
        default: "",
        description: "Embedding API 密钥，Ollama 等本地服务可留空",
    },
    "embedding.model": {
        type: "string",
        required: false,
        default: "text-embedding-3-small",
        description: "Embedding 模型名称，如 text-embedding-3-small / bge-m3 / nomic-embed-text 等",
    },
    "embedding.dimensions": {
        type: "number",
        required: false,
        default: 1536,
        description: "Embedding 向量维度，需与模型输出一致。OpenAI small=1536, ada-002=1536, Ollama 模型各异",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value <= 8192,
    },
    "embedding.batch_size": {
        type: "number",
        required: false,
        default: 20,
        description: "批量生成 Embedding 时每批数量",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value <= 200,
    },
    "embedding.max_tokens": {
        type: "number",
        required: false,
        default: 8000,
        description: "单次 Embedding 请求最大 token 数",
        transform: typeTransformers.number,
        validate: (value) => value > 0,
    },
    "embedding.request_timeout": {
        type: "number",
        required: false,
        default: 30000,
        description: "Embedding API 请求超时时间(ms)",
        transform: typeTransformers.number,
        validate: (value) => value >= 1000,
    },
    "embedding.concurrency": {
        type: "number",
        required: false,
        default: 2,
        description: "Embedding Worker 并发数",
        transform: typeTransformers.number,
        validate: (value) => value > 0 && value <= 10,
    },
    "embedding.user_refresh_interval_hours": {
        type: "number",
        required: false,
        default: 24,
        description: "用户向量自动刷新间隔(小时)",
        transform: typeTransformers.number,
        validate: (value) => value >= 1,
    },
    "embedding.periodic.project_check.enabled": {
        type: "boolean",
        required: false,
        default: true,
        description: "是否启用每日项目 Embedding 补齐检查任务",
        transform: typeTransformers.boolean,
    },
    "embedding.periodic.project_check.interval_ms": {
        type: "number",
        required: false,
        default: 86400000,
        description: "每日项目 Embedding 补齐检查任务间隔(毫秒)",
        transform: typeTransformers.number,
        validate: (value) => value >= 60000,
    },
    "embedding.periodic.project_check.min_view_count": {
        type: "number",
        required: false,
        default: 100,
        description: "每日项目 Embedding 补齐检查的最低浏览量阈值(>该值)",
        transform: typeTransformers.number,
        validate: (value) => value >= 0,
    },
    "embedding.periodic.project_check.min_star_count": {
        type: "number",
        required: false,
        default: 10,
        description: "每日项目 Embedding 补齐检查的最低收藏量阈值(>该值)",
        transform: typeTransformers.number,
        validate: (value) => value >= 0,
    },
    "embedding.periodic.project_check.scan_limit": {
        type: "number",
        required: false,
        default: 2000,
        description: "每日项目 Embedding 补齐检查单次最多扫描并尝试入队的项目数",
        transform: typeTransformers.number,
        validate: (value) => value >= 1 && value <= 50000,
    }
};

// 从数据库加载的动态配置
export let DYNAMIC_CONFIG_TYPES = {};

// 合并静态和动态配置
export function getMergedConfigTypes() {
    return {...CONFIG_TYPES, ...DYNAMIC_CONFIG_TYPES};
}

// 更新帖子配置类型
export function updateDynamicConfigTypes(dbConfigs) {
    DYNAMIC_CONFIG_TYPES = {};
    for (const config of dbConfigs) {
        const metadata = config.metadata || {};
        DYNAMIC_CONFIG_TYPES[config.key] = {
            type: config.type.toLowerCase(),
            required: metadata.required || false,
            default: metadata.default,
            description: metadata.description || "",
            public: metadata.public || false,
            fromDatabase: true,
            options: metadata.options, // 用于enum类型
            validate: metadata.validate ? new Function("value", metadata.validate) : null,
        };
    }
}

// Validation functions
export function validateConfig(key, value) {
    const allTypes = getMergedConfigTypes();
    const configType = allTypes[key];
    if (!configType) {
        throw new Error(`Unknown configuration key: ${key}`);
    }

    // Transform value if transform function exists
    let transformedValue = value;
    if (configType.transform) {
        transformedValue = configType.transform(value);
    } else if (typeTransformers[configType.type]) {
        transformedValue = configType.type === "enum"
            ? typeTransformers[configType.type](value, configType.options)
            : typeTransformers[configType.type](value);
    }

    // Handle null/undefined for non-required fields
    if (transformedValue == null && !configType.required) {
        return configType.default ?? null;
    }

    // Run custom validation if exists
    if (configType.validate && !configType.validate(transformedValue)) {
        throw new Error(`Validation failed for ${key}`);
    }

    return transformedValue;
}

// Get default value for a config key
export function getDefaultValue(key) {
    const allTypes = getMergedConfigTypes();
    const configType = allTypes[key];
    if (!configType) return undefined;

    const defaultValue = configType.default;
    if (defaultValue === undefined) return undefined;

    // Transform default value if needed
    if (configType.transform) {
        return configType.transform(defaultValue);
    } else if (typeTransformers[configType.type]) {
        return configType.type === "enum"
            ? typeTransformers[configType.type](defaultValue, configType.options)
            : typeTransformers[configType.type](defaultValue);
    }
    return defaultValue;
}

// Check if a config key is required
export function isRequired(key) {
    const allTypes = getMergedConfigTypes();
    return allTypes[key]?.required ?? false;
}

// Get all configs that need special handling
export function getSpecialConfigs() {
    const allTypes = getMergedConfigTypes();
    return Object.entries(allTypes)
        .filter(([_, config]) => config.special)
        .map(([key, config]) => ({
            key,
            description: config.description,
            required: config.required,
        }));
}

// 获取所有配置类型定义
export function getAllConfigTypes() {
    const allTypes = getMergedConfigTypes();
    return Object.entries(allTypes).map(([key, config]) => ({
        key,
        type: config.type,
        required: config.required,
        default: config.default,
        description: config.description,
        public: config.public,
        fromDatabase: config.fromDatabase || false,
        options: config.options,
    }));
}

// 验证配置类型定义是否有效
export function validateConfigType(type, metadata) {
    if (!typeTransformers[type]) {
        throw new Error(`Unsupported config type: ${type}`);
    }

    if (type === "enum" && (!metadata.options || !Array.isArray(metadata.options) || metadata.options.length === 0)) {
        throw new Error("Enum type requires non-empty options array in metadata");
    }

    if (metadata.validate && typeof metadata.validate !== "string") {
        throw new Error("Validate function must be a string");
    }

    return true;
}
