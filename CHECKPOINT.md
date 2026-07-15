# 工作检查点 — 2026-07-15（校正）

## 总体状态：M1–M3 里程碑完成，E04 AI COO 受控链路过半

```
里程碑完成度：
▓▓▓▓▓▓▓▓▓▓ M1 数据与平台基础  ✅ (E01-T01~T09 全部完成)
▓▓▓▓▓▓▓▓▓▓ M2 账户与工作空间  ✅ (E02-T01~T07 全部完成)
▓▓▓▓▓▓▓▓▓▓ M3 手动经营闭环     ✅ (E03-T01~T06 全部完成)
▓▓▓▓▓░░░░░░ M4 AI COO           🚧 (E04-T01~T05 完成；E04-T06/T07 待实施)
░░░░░░░░░░ M5 数据权利与Worker  📋 (未开始)
░░░░░░░░░░ M6 发布候选         📋 (未开始)
```

---

## 已交付内容

### 数据库（7 次迁移，23 张表）

| 迁移 | 表 | 关键设计 |
|------|-----|---------|
| M01 `0000` | `app_user`, `credential`, `session`, `workspace`, `profile`, `platform_operator`, `platform_operator_role` | citext, 至少一种联系标识, 一账户一空间, 会话族, 运营与业务隔离 |
| M02 `0001` | `project`, `task`, `customer`, `customer_stage_history` | 三级任务深度约束, 复合外键跨空间阻断, stage_history append-only 触发器 |
| M03 `0002` | `consent`, `ai_run`, `ai_suggestion`, `ai_suggestion_decision`, `ai_usage_daily` | 空间唯一授权, 建议/决议/run 同空间约束, 终态决议唯一 |
| M04 `0003` | `export_job`, `export_download_token`, `deactivation_request`, `async_job`, `idempotency_record` | 活动注销唯一, 幂等键 PK, 下载令牌哈希, 最大重试 3 |
| M05 `0004` | `audit_event` (月分区, 13 个), `metric_daily_aggregate` | `audit_owner` 角色, `SECURITY DEFINER append_audit_event()`, 应用角色权限收紧 |
| M06 `0005` | —（仅改约束） | `ai_suggestion_decision.suggestion_id` 外键改为 `ON DELETE cascade` |
| M07 `0006` | —（仅改触发器） | `ai_suggestion_decision_append_only` 触发器加 `WHEN (pg_trigger_depth() = 1)`：直写删除仍拦截，父建议级联删除放行 |

> 注：`0005`/`0006` 刻意不使用 `CREATE OR REPLACE FUNCTION`，因此普通本地迁移账号（无 `public` schema `CREATE` 权限）也能直接 `pnpm db migrate` 成功应用。

### API（项目、任务、进度与 CRM-lite、仪表盘、AI COO 已接入，37 个测试全部通过）

| 路由 | 功能 | 关键点 |
|------|------|--------|
| `GET /health` | 存活检查 | 无依赖, 始终 200 |
| `GET /ready` | 就绪检查 | PG+Redis 双检, 故障 503 |
| `POST /api/v1/auth/register` | 邮箱/手机注册 | bcrypt 12, 条款/隐私版本审计, IP 限流 5/15min |
| `POST /api/v1/auth/login` | 登录 | HS256 JWT 15min + HttpOnly Refresh Cookie, 双维度失败限流 |
| `POST /api/v1/auth/refresh` | 会话轮换 | 事务锁定→ROTATED→新建, 重放撤销整族 419 |
| `POST /api/v1/auth/re-authenticate` | 重认证 | 仅更新当前 session `last_authenticated_at` |
| `POST /api/v1/auth/password` | 密码修改 | 需重认证窗口, 更新哈希并撤销其他 family |
| `POST /api/v1/workspace` | 创建工作空间 | 同事务写 `CORE_SERVICE=GRANTED`, 重复 409 |
| `GET /api/v1/workspace` | 查询工作空间 | 从 JWT 派生, 客户端不传 workspaceId |
| `GET /api/v1/profile` | 查询画像 | 含 `completed_at` 引导恢复状态 |
| `PUT /api/v1/profile` | 更新画像 | expectedVersion 乐观锁, 最多 20 技能 |
| `GET /api/v1/consents` | 列出授权 | 仅当前空间 |
| `PUT /api/v1/consents/:type` | 授予/重新授予 | 版本递增, 同事务审计 |
| `POST /api/v1/consents/:type/revoke` | 撤回授权 | 需重认证窗口, CORE_SERVICE 不可 API 撤回 |
| `GET /api/v1/projects` | 项目列表 | 当前空间过滤、状态筛选、游标分页、查询态任务进度 |
| `POST /api/v1/projects` | 创建项目 | 画像完成门禁、初始 `DRAFT`、幂等与审计 |
| `GET /api/v1/projects/:projectId` | 项目详情 | 跨空间资源统一返回 404，返回任务进度聚合 |
| `PATCH /api/v1/projects/:projectId` | 更新项目 | 乐观锁，仅 `DRAFT`/`IN_PROGRESS`/`PAUSED` 可编辑 |
| `POST /api/v1/projects/:projectId/actions/:action` | 项目状态动作 | start/pause/resume/complete/cancel，状态机、幂等与审计 |
| `GET /api/v1/projects/:projectId/tasks` | 项目任务列表 | 当前空间/项目过滤、父任务筛选、状态筛选、游标分页 |
| `POST /api/v1/projects/:projectId/tasks` | 创建任务 | 手动 `DRAFT`、服务端计算深度、最大三级、幂等与审计 |
| `GET /api/v1/tasks/:taskId` | 任务详情 | 跨空间资源统一返回 404 |
| `PATCH /api/v1/tasks/:taskId` | 更新任务 | 乐观锁；`CLOSED`/`CANCELLED` 不可编辑 |
| `POST /api/v1/tasks/:taskId/actions/:action` | 任务状态动作 | confirm/start/complete/close/cancel/defer，递归子任务处理与审计 |
| `GET /api/v1/customers` | 客户列表 | 当前空间隔离、阶段/意向度筛选、游标分页 |
| `POST /api/v1/customers` | 创建客户 | 初始 `LEAD`、幂等与审计 |
| `GET /api/v1/customers/:customerId` | 客户详情 | 当前空间，跨空间资源统一返回 404 |
| `PATCH /api/v1/customers/:customerId` | 更新客户 | 乐观锁；阶段不可经 PATCH 修改 |
| `POST /api/v1/customers/:customerId/actions/change-stage` | 变更客户阶段 | 严格转换矩阵、回退/重新激活原因、历史与审计同事务 |
| `GET /api/v1/customers/:customerId/stage-history` | 阶段历史 | 只读 append-only 历史、游标分页 |
| `GET /api/v1/dashboard/daily-top3` | 每日三件事（手动降级） | 当前空间活跃/暂停项目下的活跃任务只读 top-3；排除终态项目/任务；不改任务状态（E03-T05） |
| `POST /api/v1/ai/runs` | 创建 AI Run | 受控上下文 + 供应商适配器调用，事务外调用，持久化脱敏快照（E04-T03） |
| `GET /api/v1/ai/runs/:runId` | AI Run 详情 | 仅当前空间，跨空间 404 |
| `GET /api/v1/ai/runs/:runId/events` | AI Run SSE 事件流 | 仅安全事件；支持 `Last-Event-ID` 断线恢复（E04-T03） |
| `POST /api/v1/ai/suggestions/:id/actions/edit` | 建议编辑 | `GENERATED→WAITING_CONFIRMATION`，追加 `EDITED` 决议，原提案不可变（E04-T05） |
| `POST /api/v1/ai/suggestions/:id/actions/confirm` | 建议确认 | 单事务：建议→`CONFIRMED` + 建 `AI_CONFIRMED` 任务 + 决议 + 审计；重复 itemKey 不重复写入（E04-T05） |
| `POST /api/v1/ai/suggestions/:id/actions/reject` | 建议驳回 | 追加 `REJECTED` 决议与审计，不创建/更新业务对象（E04-T05） |

### 平台基础设施

- **请求上下文**: 合法 UUID 透传 `X-Request-Id`, 服务端生成后备, `traceId` 全链路
- **统一错误**: 稳定错误体, 不泄露堆栈/SQL/内部信息
- **写入守卫**: 精确 Origin + `X-OPC-CSRF: 1` 校验
- **限流器**: Redis 滑动窗口, 可注入 IP/用户双维度
- **审计客户端**: 仅调用 `append_audit_event()`, 不走直接 DML
- **幂等/乐观锁**: `apps/api/src/platform/concurrency.ts` 统一 `replayIdempotent` / `recordIdempotent` / `validateExpectedVersion` / `requireUpdatedRow`，project/task/customer 服务已复用（E03-T06）

### AI COO 受控链路（E04-T01~T05）

- **T01 供应商适配器** `apps/api/src/ai/provider.ts`：`AiProviderAdapter` 默认 15s 超时、最多 2 次调用、5 分钟窗口失败率熔断、默认 60s 熔断打开；稳定错误码 `AI_TIMEOUT` / `AI_PROVIDER_UNAVAILABLE` / `AI_CIRCUIT_OPEN`；`MockAiProvider` 用于确定性测试。
- **T02 受控上下文** `apps/api/src/ai/context.ts`：服务端从认证 `userId` 派生 workspace；要求 `AI_BUSINESS_DATA=GRANTED`；仅查当前空间；`TASK_BREAKDOWN` 跨空间返回 404；Prompt 分为 system instruction / system structured context / user instruction；脱敏（客户别名 `客户-A`、删除 `customer.notes` 与 `task.description`、文本截断、邮箱/电话替换为 `[REDACTED]`）；生成 `dataCategories` / `consentEvidence` / `inputRedactionMethod`。
- **T03 AI Run / SSE** `apps/api/src/ai/run.ts`：持久化 `ai_run`（先写 `PROCESSING` + 脱敏快照），事务外调用 T01 适配器，落 `GENERATED` / `FAILED` / `TIMED_OUT`；`replayIdempotent` 处理 `ai.run.create` 幂等；SSE 仅发安全事件且支持 `Last-Event-ID`。
- **T04 提案/状态机** `apps/api/src/ai/proposal.ts`：`parseProposal()` 解析 `TASK_PLAN`（1–50 项、服务端稳定 `itemKey`）、`CLARIFYING_QUESTION`、连续两次无效 JSON/Schema 后 `NATURAL_LANGUAGE_FALLBACK`；run 据类型流转 `GENERATED` / `WAITING_FOR_INPUT` / `DEGRADED` 并持久化 `ai_suggestion`；确认前不创建 task 行。
- **T05 建议事务** `apps/api/src/ai/suggestion.ts`：编辑/确认/驳回三动作；原提案不可变；`editedPayload` 必须过同一 Schema；客户端不可改/增/复用 `itemKey`；确认事务原子创建 `AI_CONFIRMED` 任务 + 终态决议 + 审计，失败回滚；`(source_ai_suggestion_id, source_ai_item_key)` 防止重复写入；`EXECUTION_FAILED` 终态不可重确认。

### 测试验证

| 命令 | 结果 |
|------|------|
| `pnpm.cmd typecheck` | ✅ 6 个工作空间 |
| `pnpm.cmd lint` | ✅ |
| `pnpm.cmd test` | ✅ 14 文件 / 37 用例 |
| `pnpm.cmd build` | ✅ web + api + contracts + config + worker |
| `GET /health` → 200 | ✅ |
| `GET /ready` → 200 (db+redis ok) | ✅ |
| 真实 PostgreSQL 迁移 | ✅ M01–M07 全部可重复执行（含 `0005`/`0006` 权限无关改写） |
| 真实 Redis 连接 | ✅ PONG |

---

## 未交付工作（按优先级排列）

### 已完成

| Epic | 说明 | 状态 |
|------|------|------|
| M1 数据与平台基础 | E01-T01~T09 | ✅ 全部完成 |
| M2 账户与工作空间 | E02-T01~T07 | ✅ 全部完成 |
| M3 手动经营闭环 | E03-T01~T06（含每日三件事手动降级、幂等/乐观锁通用用例） | ✅ 全部完成 |
| E04 AI COO（部分） | E04-T01 适配器 / T02 受控上下文 / T03 Run·SSE / T04 提案状态机 / T05 建议事务 | ✅ T01~T05 完成 |

### 下一阶段：M4 AI COO（收尾）

| ID | 内容 | 依赖 | 状态 |
|----|------|------|------|
| E04-T06 | 每日三件事 AI 建议与配额 | E04-T04、E03-T05 | ⬜ 待实施：复用 T05 确认事务；新增 `DAILY_TOP3` 建议类型；最多 3 项；配额 `429`；无建议降级到 E03-T05 手动 top-3 |
| E04-T07 | AI 质量、安全、成本测试集 | E04-T04~T06 | ⬜ 待实施：任务拆解 ≥100、每日三件事 ≥50、注入 ≥30、脱敏 ≥30；版本化可重跑 |

### 后续 Epic

| Epic | 说明 | 前置 |
|------|------|------|
| **E05 数据权利 + Worker** | 导出, Worker 重试/DLQ, 注销宽限, 匿名化 | E02/E03 |
| **E06 Web PWA** | React 全部前端页面 | E02~E05 |
| **E07 测试与发布** | E2E, 安全, 性能, 发布证据 | 全部 |

### 跨阶段遗留项

- 审计分区维护 Worker + 13 个月热数据归档策略
- 10 万条审计事件预发性能验证 + 回滚演练
- Docker/Testcontainers CI 容器环境
- Playwright / axe-core / 安全扫描
- OpenTelemetry / 监控
- **Git 首次提交已推送**：`6c5c219`（root-commit，92 文件 / 26,830 行；`Initial commit: OPC AI OS V1-A monorepo (M1-M3, E04-T01..T05)`）；CI 工作流 `.github/workflows/ci.yml` 经补充提交（含 `workflow` 作用域的 token）已纳入并推送至 `github.com/binaryxu1201-dotcom/opc-ai-os`。
  - 注意：本次推送用的 `ghp_` classic token 曾在会话中明文提供，建议用完后到 GitHub 撤销/轮换该 token。
- `CHECKPOINT.md` 已校正至 2026-07-15 状态，并随首次提交入库。

---

## 工程文档（`docs/`）

| # | 文件 | 说明 |
|---|------|------|
| 01 | `01-需求分析.md` | SRS v0.5 已批准 |
| 02 | `02-PRD与用户故事（V1-A）.md` | PRD v1.1 已评审 |
| 03 | `03-V1-A技术架构设计.md` | 架构 v1.4 已评审 |
| 04 | `04-V1-A数据模型与状态机设计.md` | 数据模型 v1.5 已评审 |
| 05 | `05-V1-AAPI契约设计.md` | API 契约 v1.3 已评审 |
| 06 | `06-V1-AUIUX交互规格.md` | UI/UX v1.4 已评审 |
| 07 | `07-V1-A测试与发布计划.md` | 测试 v1.3 已评审 |
| 08 | `08-V1-A工程实施计划与任务拆解.md` | 实施计划 v1.0 |

---

## 下次开工入口

从 **E04-T06** 开始：基于已完成的 E04-T04（提案/运行）、E04-T05（建议确认/驳回事务）与 E03-T05（手动 top-3），实现**每日三件事 AI 建议与配额**。新增 `DAILY_TOP3` 类型建议，复用 `ai_suggestion` / `confirm` / `reject` 事务；配额计数复用 `ai_usage_daily`（已在 `0002` 建表）；超配额返回 `429`；无 AI 建议时降级到 E03-T05 手动 top-3，确认不修改任务状态。入口建议放在 `apps/api/src/ai/` 下扩展 proposal/suggestion 服务，并在 `app.ts` 注册对应路由。
