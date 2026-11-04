# 使用轻量且有社区支持的 Node 官方镜像
FROM node:24.22.1-alpine

# 设置作者信息
LABEL author="wuyuan"

# 设置工作目录
WORKDIR /app

# 启用 pnpm（通过 corepack）
RUN corepack enable

# 先复制依赖清单，提升构建缓存命中率
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json

# 安装 workspace 依赖（后端运行时依赖根包 + apps/api）
RUN pnpm install --frozen-lockfile

# 仅复制后端应用代码，避免引入无关目录影响构建速度
COPY apps/api ./apps/api
COPY scripts/migrate-project-files-to-s3.js ./scripts/migrate-project-files-to-s3.js

# 切换到后端目录并生成 Prisma Client
WORKDIR /app/apps/api
RUN pnpm prisma

# 设置环境变量
ENV NODE_ENV=production

# 容器对外暴露的端口
EXPOSE 3000

# 启动后端
CMD ["pnpm", "start"]
