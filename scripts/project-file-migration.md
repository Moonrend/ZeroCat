# 项目正文迁移到 S3

`migrate-project-files-to-s3.js` 把 `ow_projects_file.source` 中的历史正文交给统一存储服务迁移。数据库保留文件标识、创建信息、对象位置、内容校验值和搜索元数据；正文在上传并回读验证成功后才清空。脚本不改变原 `sha256` 主键或提交引用，也不自行生成对象键。

普通历史记录按 UTF-8 正文字节校验原 SHA。旧 sitemap 记录的原 SHA 来自 gzip 二进制，而数据库正文是规范 base64 文本；统一服务兼容这种格式，保留原主键，并用 `content_sha256` 记录实际存入 S3 的 UTF-8 字节哈希。其他哈希不匹配会报错并保留旧正文。

## 存储结构与调用约定

- `apps/api/src/services/objectStorage.js` 统一 S3 客户端、上传、HEAD、下载和流中断重试。素材服务仍显式使用原公开桶及公开 ACL；项目正文使用独立私有桶，不生成公开 URL。
- `apps/api/src/services/projectFileStorage.js` 负责正文的内容哈希、元数据、旧记录兼容、对象完整性校验及批量读取。业务代码通过它读写正文，不直接查询或更新 `source`。
- 项目、扩展和博客等调用者仍先执行现有授权、审核可见性和提交可达性检查，再读取内容。存储服务本身不替代授权。

| 接口 | 返回及用途 |
| --- | --- |
| `saveProjectFile(source, { userId, sha256? })` | 等待 S3 上传和数据库指针发布，返回元数据；可校验调用者预期哈希。 |
| `readProjectFile(hash)` | 返回兼容的 `{ sha256, source, create_time, create_userid }` 或 `null`，不暴露桶和对象键。 |
| `readProjectFiles(hashes)` | 批量元数据查询，返回以哈希为键的 `Map`；每批最多 500 条，最多 4 个并发对象读取。 |
| `hydrateProjectFile(row)` / `hydrateProjectFiles(rows)` | 使用已经加载的完整元数据读取正文，避免再次查询数据库；结果包含内部元数据，API 返回前须映射公开字段。 |
| `migrateLegacyProjectFile(row, options)` | 上传并回读校验后，对原正文和存储位置做条件更新，防止覆盖并发变更。 |

新文件使用 UTF-8 内容 SHA-256 作为 ID 和对象路径依据；历史记录的 ID 不重写，`content_sha256` 单独保存对象字节校验值。新写入的 `source` 为 `NULL`，数据库只保留定位信息、创建信息、字节数、最多 240 字符的搜索预览和前 200000 字符生成的全文索引。旧记录在迁移前仍直接读取数据库，搜索同时兼容两种存储方式。

相同正文再次保存会先检查已有对象的长度和哈希元数据；对象丢失时重新上传，权限拒绝或网络故障会报错。读取会验证完整字节数和 SHA-256，不把丢失、损坏或读权限错误当成空文件。上传失败不会发布新指针，数据库失败后也不会删除可能已被其他请求引用的对象。S3 网络操作应在业务数据库事务开始前完成；上传后尚未被引用的对象允许保留。

不要在删除单个用户或项目时直接删除正文对象：多个项目、fork 和提交可能共享同一文件。对象回收需要单独证明已经没有全局引用，本次改造不自动执行回收。

## 上线顺序

1. 按数据库发布流程应用 `apps/api/prisma/migrations/20261104090000_project_file_object_storage/migration.sql`，并重新生成 Prisma 客户端。该 SQL 只增加结构，不清空旧正文。
2. 配置 `storage.projects.bucket` 为禁止匿名访问的私有桶，必须与公开素材桶 `s3.bucket` 不同。正文桶复用 `s3.endpoint`、`s3.region`、`s3.forcePathStyle` 和 S3 凭据；需要具备对象写入与读取权限，不配置公共 CDN 地址。
3. 部署支持数据库历史正文和 S3 正文的读取代码，以及统一存储服务的新写入代码。确认旧版本写入进程已停止，再执行历史迁移。

以下命令从仓库根目录运行，使用 `apps/api` 的 Node/tsx 依赖和根目录 `.env`。运行环境遵循仓库 Node 版本要求。`storage.projects.bucket` 通过现有系统配置（`zcconfig`）设置，不会自动读取同名环境变量。桶内对象位置随记录保存；以后更换默认桶不会改动旧指针，旧桶仍需可读。更换 S3 服务端点则需要另外迁移已有对象。

## 预演与执行

先检查少量历史记录。默认就是 dry-run，不上传对象、不更新数据库，也不验证 S3 连通性。

```sh
pnpm run migrate:project-files --dry-run --limit 100
```

确认配置和预演结果后，显式传入 `--apply` 才执行迁移。

```sh
pnpm run migrate:project-files --apply --batch-size 50 --concurrency 4
```

参数说明：

| 参数 | 含义 |
| --- | --- |
| `--dry-run` | 预演，默认模式。与 `--apply` 互斥。 |
| `--apply` | 调用存储服务上传、校验并更新数据库。 |
| `--batch-size N` | 每次查询的记录数，默认 50，范围 1–1000。正文很大时应减小。 |
| `--concurrency N` | 同时处理的记录数，默认 4，范围 1–32。 |
| `--limit N` | 本次最多检查 N 条，包括失败和跳过的记录。 |
| `--after SHA256` | 只检查 SHA 大于该值的记录，用于续跑。 |
| `--help` | 查看帮助，不加载数据库或 S3 服务。 |

Docker 镜像内也包含迁移脚本。使用实际部署的 Compose 服务名，在同一容器环境中运行（示例服务名为 `zerocat`）：

```sh
docker compose exec -T zerocat sh -c 'cd /app && pnpm run migrate:project-files --dry-run'
docker compose exec -T zerocat sh -c 'cd /app && pnpm run migrate:project-files --apply --batch-size 50 --concurrency 4'
```

## 历史 ID 与正文哈希不一致

默认拒绝无法用普通正文或旧 Base64 规则验证的记录。若预演发现已有历史 ID 与正文不一致，应先备份数据库，核对当前正文及其项目引用，然后保存一份 JSON 清单：键为旧文件的 64 位小写 ID，值为已核对正文 UTF-8 字节的 64 位小写 SHA-256。清单不包含正文，不写入镜像或仓库，随备份保留。

通过 `--legacy-hash-manifest /path/to/audited-hashes.json` 同时传给预演和正式迁移。仅列出的 ID 可以使用指定的实际内容哈希；实际正文与清单不符时，在上传前失败。仍保留旧 ID，上传并回读完整字节，再按原正文和存储指针做条件更新。未列出的记录继续执行默认校验，新文件写入规则不变。容器运行时需只读挂载清单，或显式复制到迁移容器。

## 重跑与失败处理

查询只选择 `source IS NOT NULL` 的记录，空字符串正文也会处理。已完成迁移的记录会自动排除，因此可以直接重跑同一条 `--apply` 命令；不需要手动维护已完成清单。

每批日志包含 `scanned`、`migrated`、`planned`、`skipped`、`failed`、`lastScanned` 和 `resumeAfter`。`lastScanned` 仅表示扫描进度；需要断点续跑时，把**上次 apply 日志**中非空的 `resumeAfter` 值传给 `--after`。如果它为 null，直接重跑，不带 `--after`。不要使用 dry-run 的检查点开始首次 apply，否则会跳过已预演但尚未迁移的数据。

`resumeAfter` 不会越过失败或跳过的记录。存储服务的条件更新遇到并发变化会返回 `skipped`，该记录可能仍需要下次处理。成功迁移的后续记录已从查询范围排除，重跑不会再次清空或改写它们。

单条失败会记录 SHA 和错误原因，继续处理剩余记录，并以退出码 1 结束；参数错误、连接错误和分页读取错误也返回 1。正常完成返回 0。存储服务负责正文兼容性校验、上传后的回读验证及条件更新；失败时保留旧正文。修复原因后重跑即可。

迁移清空旧正文后，回滚应用也必须保留 S3 兼容读取能力。如果必须退回仅查询 `source` 的旧版本，需要先把已迁移记录的正文还原到数据库并验证完整性，覆盖迁移后新写入的文件，再切换旧程序；不能直接回退旧 binary。保留数据库备份与私有对象。

## 本地验证

`pnpm run test:storage` 运行存储服务、S3 适配、业务接入和迁移控制流程的离线测试，不连接真实数据库或 S3。上线前还应在测试环境应用迁移，并使用目标 S3 服务验证上传、读取和权限配置。

## 其他脚本

- `export-extension-migration.js` 已使用共享 Prisma 客户端和存储服务的元数据选择器，分页后读取历史或 S3 正文；S3 读取失败会报错退出，不会把失败当成空正文跳过。提交和项目关联仍按批次查询。
- `migrate-user-motto-to-article-projects.js` 通过 `saveProjectFile()` 保存新正文，保存成功后才创建提交和更新分支。它原有的 `--dry-run`、提交去重和 motto 清理选项继续有效。
