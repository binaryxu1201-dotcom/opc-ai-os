# 工作检查点 — 2026-07-16

## 总体状态：M1–M5 里程碑完成，M6 发布候选与 E06 Web PWA 进行中

```
里程碑完成度：
▓▓▓▓▓▓▓▓▓▓ M1 数据与平台基础  ✅ (E01-T01~T09 全部完成)
▓▓▓▓▓▓▓▓▓▓ M2 账户与工作空间  ✅ (E02-T01~T07 全部完成)
▓▓▓▓▓▓▓▓▓▓ M3 手动经营闭环     ✅ (E03-T01~T06 全部完成)
▓▓▓▓▓▓▓▓▓▓ M4 AI COO           ✅ (E04-T01~T07 全部完成)
 ▓▓▓▓▓▓▓▓▓▓ M5 数据权利与Worker  ✅ (E05-T01~T04 全部完成)
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

### API（项目、任务、进度与 CRM-lite、仪表盘、AI COO、数据导出、注销、Worker 状态已接入，48 个测试全部通过）

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
| `POST /api/v1/dashboard/daily-top3/actions/confirm` | 确认每日 AI 建议排序 | 仅确认原建议的 1–3 项连续排序子集；写决议/审计但不创建或修改任务（E04-T06） |
| `POST /api/v1/exports` | 申请基础数据 CSV 导出 | 同事务创建 `export_job`、`async_job`、审计与幂等记录；仅当前空间（E05-T01） |
| `GET /api/v1/exports` / `GET /api/v1/exports/:id` | 查询导出任务 | 仅当前空间；不返回私有 `object_key`（E05-T01） |
| `POST /api/v1/exports/:id/download-token` | 签发一次性下载令牌 | 仅 `READY`，仅持久化 SHA-256 hash，签发新令牌即撤销旧未消费令牌（E05-T01） |
| `POST /api/v1/exports/:id/download` | 下载导出 CSV | token 仅 JSON body，认证用户匹配签发用户；同事务消费 token + `DOWNLOADED`，重放 `409`（E05-T01） |
| `POST /api/v1/deactivation-requests` | 申请注销 | 当前 Session 15 分钟重认证；置用户 `DEACTIVATION_GRACE`/空间 `READ_ONLY`，撤销其他会话并安排最终任务（E05-T03） |
| `GET /api/v1/deactivation-request` | 查询注销状态 | 返回当前/最近请求、宽限期、保留例外与 tombstone 时间（E05-T03） |
| `POST /api/v1/deactivation-request/actions/revoke` | 撤销注销 | 仅 `GRACE`、当前 Session 15 分钟重认证；恢复账户/空间并取消未执行最终任务（E05-T03） |
| `GET /api/v1/async-jobs` | 当前空间异步任务 | 状态过滤/限额列表；仅返回当前 workspace，失败只含稳定码与安全摘要（E05-T04） |
| `GET /api/v1/async-jobs/summary` | 当前空间队列摘要 | queued/running/retry/dead-letter 计数与最早积压时间，不泄露其他空间任务（E05-T04） |
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

### AI COO 受控链路（E04-T01~T07）

- **T01 供应商适配器** `apps/api/src/ai/provider.ts`：`AiProviderAdapter` 默认 15s 超时、最多 2 次调用、5 分钟窗口失败率熔断、默认 60s 熔断打开；稳定错误码 `AI_TIMEOUT` / `AI_PROVIDER_UNAVAILABLE` / `AI_CIRCUIT_OPEN`；`MockAiProvider` 用于确定性测试。
- **T02 受控上下文** `apps/api/src/ai/context.ts`：服务端从认证 `userId` 派生 workspace；要求 `AI_BUSINESS_DATA=GRANTED`；仅查当前空间；`TASK_BREAKDOWN` 跨空间返回 404；Prompt 分为 system instruction / system structured context / user instruction；脱敏（客户别名 `客户-A`、删除 `customer.notes` 与 `task.description`、文本截断、邮箱/电话替换为 `[REDACTED]`）；生成 `dataCategories` / `consentEvidence` / `inputRedactionMethod`。
- **T03 AI Run / SSE** `apps/api/src/ai/run.ts`：持久化 `ai_run`（先写 `PROCESSING` + 脱敏快照），事务外调用 T01 适配器，落 `GENERATED` / `FAILED` / `TIMED_OUT`；`replayIdempotent` 处理 `ai.run.create` 幂等；SSE 仅发安全事件且支持 `Last-Event-ID`。
- **T04 提案/状态机** `apps/api/src/ai/proposal.ts`：`parseProposal()` 解析 `TASK_PLAN`（1–50 项、服务端稳定 `itemKey`）、`CLARIFYING_QUESTION`、连续两次无效 JSON/Schema 后 `NATURAL_LANGUAGE_FALLBACK`；run 据类型流转 `GENERATED` / `WAITING_FOR_INPUT` / `DEGRADED` 并持久化 `ai_suggestion`；确认前不创建 task 行。
- **T05 建议事务** `apps/api/src/ai/suggestion.ts`：编辑/确认/驳回三动作；原提案不可变；`editedPayload` 必须过同一 Schema；客户端不可改/增/复用 `itemKey`；确认事务原子创建 `AI_CONFIRMED` 任务 + 终态决议 + 审计，失败回滚；`(source_ai_suggestion_id, source_ai_item_key)` 防止重复写入；`EXECUTION_FAILED` 终态不可重确认。
- **T06 每日三件事 AI 建议与配额**：`DAILY_TOP3` 仅接受最多 3 项 `{taskId,rank,reason}`；`ai_usage_daily` 以 UTC 日期、空间与能力原子计数，每日 3 次配额，超额返回 `429 AI_QUOTA_CAPABILITY_EXHAUSTED` 与 `Retry-After`；仪表盘仅展示请求日期内有效的 AI 建议，否则回退 E03-T05 手动 top-3；确认只记录用户选择的原项子集/连续排序、决议、审计和幂等响应，绝不创建或改变任务。
- **T07 AI 质量、安全与成本测试集**：版本化 `ai-evaluation-v1` 合成样本与说明文档；任务拆解 100、每日三件事 50、低质量输入 20、Prompt 注入 30、脱敏 30，均有稳定样本 ID 与确定性可重跑断言；注入验证用户输入隔离于 system/context 分区，脱敏验证客户别名、备注/任务描述/邮箱/电话不进入模型上下文；E04-T06 集成用例验证 `ai_usage_daily` 的配额、成功/失败计数与 token 累计。

### 数据权利与 Worker（E05-T01）

- **私有 S3/MinIO 存储**：`S3ExportStorage` 使用受控 endpoint、path-style 与显式凭据；对象始终私有、不生成公开或签名 URL。`EXPORT_S3_*` 均经集中环境校验，密钥不进入仓库/日志。
- **导出与下载**：仅导出认证用户当前空间的 project/task/customer 基础经营数据；CSV 保留 BOM、字段转义并中和以 `= + - @` 开头的公式注入值；Worker 写私有对象、校验和、大小、7 天到期时间。下载令牌为 32-byte 随机值，仅存 SHA-256 hash，只从签发接口响应一次，不进入 URL、对象键、审计摘要或幂等响应。
- **Worker 可靠性**：`EXPORT_GENERATE` 以 `FOR UPDATE SKIP LOCKED` 领取作业，`RUNNING→SUCCEEDED` 成功收敛；失败安全记录为 `RETRY_SCHEDULED`，第三次失败进入 `DEAD_LETTER` 与 export `FAILED`，仅记录稳定失败码。
- **T02 到期导出清理**：Worker 每轮扫描已到期的 `READY`/`DOWNLOADED` 导出，幂等创建 `EXPORT_CLEANUP`；清理任务以 `SKIP LOCKED` 领取，先删除私有对象，再同事务撤销未消费令牌、清空 object key、置 `EXPIRED`、完成作业并追加 Worker 审计。对象删除失败不会提前改变导出状态，作业按最多 3 次重试后进入 `DEAD_LETTER`。
- **T03 注销与宽限期**：注销申请/撤销均要求当前 Session 15 分钟内重认证，且都具备事务幂等和审计；申请同时置用户 `DEACTIVATION_GRACE`、空间 `READ_ONLY`、撤销其他会话并安排 `DEACTIVATION_FINALIZE`。全局 API 守卫拒绝只读空间的非认证/导出/注销写入；最终 Worker 在宽限期届满且无 retention hold 时锁定任务，禁用凭据、撤销会话、匿名化账号/画像/项目/任务/客户字段，置空间/用户/请求为 `TOMBSTONED`，失败最多重试 3 次后死信。
- **T04 Worker 可观测性与审计分区维护**：用户仅可读取当前 workspace 的 `async_job` 状态、积压计数与 `failure_code`/`failure_detail_safe`；系统维护任务使用 `workspace_id=NULL + resource_type=system`，迁移约束阻止将其伪造为业务空间任务。Worker 按 UTC 月幂等排程并消费 `AUDIT_PARTITION_MAINTAIN`，失败安全重试/死信。审计分区 DDL 通过 `db/privileged/0007_audit_partition_maintenance.sql` 的 `audit_owner` 专用 `SECURITY DEFINER` 函数执行；普通应用迁移账号被刻意拒绝该权限，需由受控部署流程执行脚本后 Worker 才能成功维护分区。已以 `audit_owner` 角色完成部署：`maintain_audit_partitions()` 创建并预建 2026-07 至 2027-07 共 13 个 `audit_event` 分区，`AUDIT_PARTITION_MAINTAIN` Worker 任务可收敛为 `SUCCEEDED`。

### 测试验证

| 命令 | 结果 |
|------|------|
| `pnpm.cmd typecheck` | ✅ 6 个工作空间 |
| `pnpm.cmd lint` | ✅ |
| `pnpm.cmd test` | ✅ 18 文件 / 48 用例 |
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
| E04 AI COO | E04-T01 适配器 / T02 受控上下文 / T03 Run·SSE / T04 提案状态机 / T05 建议事务 / T06 每日三件事 AI 建议与配额 / T07 质量安全成本测试集 | ✅ T01~T07 全部完成 |

### 当前阶段：E06 Web PWA 与运营界面（主线优先）

| ID | 内容 | 依赖 | 状态 |
|----|------|------|------|
| E04-T06 | 每日三件事 AI 建议与配额 | E04-T04、E03-T05 | ✅ 已完成：`DAILY_TOP3` 最多 3 项；`ai_usage_daily` 原子 UTC 日配额与 `429`；当日 AI 建议或 E03-T05 手动降级；确认仅记录排序、不修改任务 |
| E04-T07 | AI 质量、安全、成本测试集 | E04-T04~T06 | ✅ 已完成：版本化 `ai-evaluation-v1`，任务拆解 100、每日三件事 50、低质量输入 20、注入 30、脱敏 30；确定性可重跑，配额/token 成本投影由真实数据库集成测试覆盖 |
| E05-T01 | 数据导出、CSV 与一次性下载 | M04 表结构、审计 | ✅ 已完成：S3/MinIO 私有对象存储、`EXPORT_GENERATE` Worker、7 天过期、一次性 hash token、`POST` body 受控下载、重放 `409`、CSV 公式注入防护与集成测试 |
| E05-T02 | 到期导出对象清理 | E05-T01 | ✅ 已完成：`EXPORT_CLEANUP` 幂等扫描/领取、私有对象删除、未消费 token 撤销、`EXPIRED` 状态与 Worker 审计；失败最多重试 3 次后死信；集成测试覆盖对象删除与重复执行 |
| E05-T03 | 注销宽限期与匿名化 | E05-T01、会话重认证 | ✅ 已完成：当前 Session 重认证、`GRACE`/`READ_ONLY` 冻结、其他会话撤销、幂等撤销恢复、API 写入守卫与 `DEACTIVATION_FINALIZE` 匿名化 Worker；真实数据库测试覆盖会话隔离与冻结恢复 |
| E05-T04 | Worker 可观测性与审计分区维护 | E05-T01~T03、M05 审计表 | ✅ 已完成：当前空间任务列表/积压摘要/安全死信信息、系统 job scope 与 Worker 月度调度；`audit_owner` 已部署 `db/privileged/0007_audit_partition_maintenance.sql`，`maintain_audit_partitions()` 预建 2026-07~2027-07 共 13 个分区，`AUDIT_PARTITION_MAINTAIN` Worker 收敛为 `SUCCEEDED` |
| E06-T01 | 认证、引导、设置与前端基础设施 | E02-T01~T06 | ✅ 已完成首版：Next.js App Router 页面壳、内存 Access Token API 客户端、Refresh Cookie 恢复、注册/登录、工作空间、画像、可选授权、设置与重认证基础交互；Web typecheck/lint/build 通过 |
| E06-T02 | 工作台、项目、三级任务和客户页面 | E03-T01~T05 | ✅ 已完成首版：工作台手动降级今日重点、项目列表/详情/创建编辑/状态动作、三级任务树/创建编辑/状态动作、客户列表/详情/创建编辑/阶段矩阵与历史；写入复用幂等键，Web typecheck/lint/build 通过 |
| E06-T03 | AI 建议和 SSE 交互 | E04-T03~T06 | ✅ 已完成首版：项目任务拆解与每日三件事生成入口、SSE 事件状态/断线流式读取、建议详情、任务建议编辑/确认/驳回、每日三件事确认、授权/失败/降级/澄清/终态按钮边界；新增 workspace-scoped 建议查询 API；API/Web typecheck、lint、build 通过 |
| E06-T04 | 导出、注销和只读体验 | E05-T01~T04 | ✅ 已完成首版：导出申请/状态查询/一次性 POST body 下载、注销后果说明/重认证/GRACE/撤销/留存提示/TOMBSTONED 状态、设置入口与全局 READ_ONLY 横幅；API/Web typecheck、lint、build 通过 |
| E06-T05 | 运营聚合和 AI 配额页面 | E01-T06、E04-T06 | 🚧 前端与安全边界已完成首版：独立 `/operations`、聚合指标、掩码用户搜索和配额配置页面；后端 `/operations/*` 当前默认拒绝普通用户会话，待独立 `platform_operator + MFA` 认证与真实聚合服务接入后激活；API/Web typecheck、lint、build 通过 |
| E06-T06 | PWA、响应式和无障碍 | E06-T01~T05 | ✅ 已完成首版：manifest、SVG 图标、生产 service worker shell、360/768/1440 响应式断点、44px 触控目标、跳过导航、focus-visible、错误状态基础语义、减少动效和 service worker 静态语法检查；Web typecheck/lint/build 通过 |

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

**M5 已完成**（E05-T01~T04 全部交付并通过验证，含 `audit_owner` 特权部署审计分区函数）。E06-T01~T06 首版已完成，下一步进入 **M6 发布候选门禁**；E06-T05 的真实运营接口仍需独立 `platform_operator + MFA` 认证链路和聚合服务实现：
- E06-T02：工作台、项目、三级任务和客户页面已接入真实 API，完成手动经营主线；覆盖加载、空、错误和服务端状态动作。
- E06-T03：AI 任务拆解与每日三件事接入真实 SSE/API；E06-T04 已补齐导出/注销体验；E06-T05 已完成安全拒绝边界和前端页面，待运营身份基础设施后激活；E06-T06 已完成 PWA/响应式/无障碍首版，现进入 M6 全量门禁。
- M6：E2E、安全扫描、性能验证、发布证据（参考 `docs/07-V1-A测试与发布计划.md` 与跨阶段遗留项：10 万条审计事件预发性能验证、Docker/Testcontainers CI、Playwright/axe-core、OpenTelemetry 监控）。
- E06：React 全部前端页面（依赖 E02~E05 已完成的后端契约）。
- 跨阶段遗留项中的「审计分区维护 Worker + 13 个月热数据归档策略」已随 E05-T04 落地；其余遗留项归入 M6/M7 收尾。
