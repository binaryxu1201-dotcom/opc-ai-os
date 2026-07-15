# OPC AI OS

V1-A 的独立 TypeScript Monorepo。此仓库目前仅包含工程骨架，不含账户、项目、任务、AI 或任何业务数据表。

## 技术选择

- `apps/web`：Next.js React PWA 起点。
- `apps/api`：Fastify 模块化 REST 服务，提供 `/health` 与 `/ready`。
- `apps/worker`：BullMQ Worker 进程起点；当前不注册业务队列。
- `db`：Drizzle PostgreSQL schema、迁移配置与迁移脚本。
- `packages/config`：集中式、校验后的环境变量配置。
- `packages/contracts`：前后端共享的非业务基础契约。

## 本地准备

1. 复制 `.env.example` 为 `.env`，为本机 PostgreSQL 创建专用用户和数据库后填写 `DATABASE_URL`；不得使用或提交管理员密码。
2. 确保 PostgreSQL 与 Redis 已启动。
3. 使用 `pnpm.cmd install` 安装依赖（PowerShell 策略阻止 `pnpm.ps1` 时）。

## 命令

```powershell
pnpm.cmd install
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd test
pnpm.cmd dev
```

`GET /health` 只表示 API 进程存活。`GET /ready` 会检查 PostgreSQL 与 Redis，任一不可达即返回 `503`；它不会返回或记录连接凭据。

## 边界

实现必须遵循 `.sisyphus/docs/03-V1-A技术架构设计.md` 至 `07-V1-A测试与发布计划.md`。业务数据模型仅能通过审查后的 M01–M05 迁移创建；当前骨架不创建任何业务表。
