# OPC AI OS V1-A API 契约设计

> 文档编号：API-OPC-AI-OS-V1A-001  
> 版本：v1.3  
> 编写日期：2026-07-13  
> 文档状态：已评审  
> 上游基线：`01-需求分析.md`（SRS v0.5，已批准）、`02-PRD与用户故事（V1-A）.md`（v1.1，已评审）、`03-V1-A技术架构设计.md`（v1.4）、`04-V1-A数据模型与状态机设计.md`（v1.5）

---

## 1 目标、范围与决策

### 1.1 目标

本文件定义 V1-A Web PWA、运营后台、模块化业务应用和 Worker 之间的 HTTP/SSE 契约。它冻结资源 URI、鉴权、请求与响应格式、状态转换、错误码、分页、并发和 AI 流式协议；实现不得绕过 04 的工作空间归属、状态机、审计与事务边界。

### 1.2 范围与非目标

覆盖账户/认证、当前工作空间与画像、项目/三级任务、CRM-lite、AI COO、授权、导出、注销、用户 AI 使用量及运营聚合指标。

不提供：多成员/协作、支付、站内消息、文件上传、RAG/长期记忆、通用搜索、公开 API、WebSocket、内容实验接口、完整审计查询 UI/API。V1-A 运营接口只读聚合数据，不返回用户私密项目、任务、客户正文或原始 AI 内容。

### 1.3 接口风格决策

| 决策 | V1-A 结论 | 原因 |
|---|---|---|
| 协议 | HTTPS + REST JSON；AI 使用 SSE | 适合模块化单体和 PWA，AI 首响应可流式展示。 |
| 基路径 | `/api/v1` | 允许未来非破坏性版本演进。 |
| 资源边界 | 当前用户工作空间从认证上下文派生 | 客户端不得用 `workspaceId` 决定访问边界。 |
| Access Token | `Authorization: Bearer <access-token>`，仅内存保存 | 避免 LocalStorage 持久化。 |
| Refresh Token | `HttpOnly; Secure; SameSite=Lax` Cookie | 由服务端轮换、哈希存储和撤销。 |
| 写入并发 | `expectedVersion` + `Idempotency-Key` | 04 §2.1 的乐观锁和抗重放要求。 |
| 运营身份 | 角色来自独立 `platform_operator` 身份声明，必须完成 MFA | DMD-02 已决策；不在业务资源中建成员关系。 |

---

## 2 通用 HTTP 契约

### 2.1 Headers 与编码

| Header | 适用范围 | 要求 |
|---|---|---|
| `Authorization` | 除注册、登录、刷新和健康检查外 | `Bearer <access-token>`。 |
| `Content-Type` | JSON 写请求 | `application/json; charset=utf-8`。 |
| `Accept` | 通用 JSON | `application/json`。AI SSE 为 `text/event-stream`。 |
| `X-OPC-CSRF` | **全部** `POST` / `PUT` / `PATCH` / `DELETE` | 固定值 `1`；缺失返回 `CSRF_REQUIRED`。 |
| `Origin` | 全部写请求 | 必须在生产域名白名单；缺失/不匹配返回 `ORIGIN_NOT_ALLOWED`。 |
| `Idempotency-Key` | 创建、动作、导出、注销、AI 触发等非安全幂等写 | 长度 16–128 的 UUID/随机字符串；相同用户/作用域/键 24 小时内复放原结果。 |
| `X-Request-Id` | 可选请求输入 | 合法 UUID 时传播；否则服务端生成。所有响应回显。 |
| `Last-Event-ID` | AI SSE 重连 | 最后处理的 SSE `id`；服务端从持久化 `ai_run`/建议快照恢复，而非重放原始模型 token。 |

客户端不得传入 `workspaceId` 作为权限依据；允许的 URL `{projectId}`、`{taskId}` 等仅是资源定位符，服务端仍以认证主体派生当前 `workspace_id` 过滤。

### 2.2 成功响应

除 `204` 与 SSE 外，JSON 统一采用：

```json
{
  "data": {},
  "meta": {
    "requestId": "018f...",
    "traceId": "018f..."
  }
}
```

`traceId` 仅在 AI、异步作业或已有关联链路时返回。资源响应必须包含 `id`、`createdAt`、`updatedAt` 与 `version`（只追加事件/投影表除外）。时间均为 RFC 3339 UTC 字符串；枚举值按 04 使用大写 snake case。

### 2.3 错误响应与 HTTP 语义

```json
{
  "error": {
    "code": "RESOURCE_VERSION_CONFLICT",
    "message": "数据已被更新，请刷新后重试。",
    "details": [
      { "field": "expectedVersion", "reason": "stale", "currentVersion": 7 }
    ]
  },
  "meta": { "requestId": "018f...", "traceId": "018f..." }
}
```

不得返回堆栈、SQL、内部拓扑、原始 Prompt、模型供应商错误或敏感字段。`details` 仅用于字段校验、版本冲突和安全的业务提示。

| HTTP | 稳定错误码 | 语义 |
|---|---|---|
| 400 | `INVALID_REQUEST` | JSON 不合法、参数格式错误。 |
| 401 | `UNAUTHENTICATED` / `ACCESS_TOKEN_INVALID` / `ACCESS_TOKEN_EXPIRED` | 缺失、无效或过期 Access Token；客户端仅对 `ACCESS_TOKEN_EXPIRED` 尝试一次刷新，无效/缺失直接回登录。 |
| 403 | `FORBIDDEN` / `ORIGIN_NOT_ALLOWED` / `CSRF_REQUIRED` / `CONSENT_REQUIRED` / `WORKSPACE_READ_ONLY` / `ACCOUNT_DEACTIVATED` | 已认证但无权限、CSRF/Origin 不满足、未授权 AI、注销只读或账户已匿名化。 |
| 404 | `RESOURCE_NOT_FOUND` | 当前工作空间中不存在该资源；不得泄露跨空间资源存在性。 |
| 409 | `RESOURCE_VERSION_CONFLICT` / `IDEMPOTENCY_KEY_REUSED` / `INVALID_STATE_TRANSITION` | 乐观锁冲突、同幂等键不同请求、非法状态变更。 |
| 419 | `SESSION_REVOKED` / `REFRESH_TOKEN_REUSED` / `REFRESH_TOKEN_EXPIRED` | Refresh 会话撤销、重放或过期；清空内存 Access Token 并回登录。 |
| 422 | `VALIDATION_FAILED` / `TASK_DEPTH_EXCEEDED` / `REAUTH_REQUIRED` | 合法 JSON 但领域/字段规则不满足。 |
| 429 | `RATE_LIMITED` / `AI_QUOTA_USER_EXHAUSTED` / `AI_QUOTA_CAPABILITY_EXHAUSTED` / `AI_QUOTA_GLOBAL_EXHAUSTED` | 限流或 AI 配额耗尽；返回 `Retry-After`。 |
| 503 | `AI_CIRCUIT_OPEN` / `DEPENDENCY_UNAVAILABLE` | 外部依赖熔断或不可用；手动业务功能保持可用。 |

### 2.4 分页、筛选与排序

列表统一使用 cursor 分页：

```text
GET /api/v1/projects?limit=20&cursor=eyJ...&status=IN_PROGRESS&sort=-updatedAt
```

| 参数 | 规则 |
|---|---|
| `limit` | 默认 20，最小 1，最大 100。 |
| `cursor` | 不透明 Base64URL 游标，含排序键/ID/查询指纹；查询条件改变后不得复用。 |
| `sort` | 资源白名单字段；`-` 为倒序。默认均为 `-updatedAt`（历史表为 `-changedAt`）。 |
| `status` 等过滤 | 仅白名单枚举，可重复使用 `status=...&status=...`。 |

列表响应：

```json
{
  "data": [],
  "meta": {
    "nextCursor": "eyJ...",
    "hasMore": true,
    "requestId": "018f..."
  }
}
```

---

## 3 认证、会话与重认证

### 3.1 公开接口

| 方法/路径 | 请求 | 成功响应 | 规则 |
|---|---|---|---|
| `POST /auth/register` | `email?`、`phone?`、`password`、`termsVersion`、`privacyVersion` | `201 user` | 邮箱/手机至少一个；创建 `user`、`credential` 并在注册审计摘要记录已接受的服务条款/隐私政策版本。此时尚无 workspace，不创建 `CORE_SERVICE` consent。验证流程由邮件/短信适配器异步处理。 |
| `POST /auth/login` | `identifier`、`password` | `200 {accessToken, expiresAt, user}` | 设置轮换 Refresh Cookie；登录失败遵循 Redis 滑动窗口。 |
| `POST /auth/refresh` | 无 body，Refresh Cookie | `200 {accessToken, expiresAt}` | 需要 Origin/CSRF；轮换旧 Session。重放/失效返回 419。 |
| `POST /auth/logout` | 无 body | `204` | 撤销当前 Session；清除 Refresh Cookie。 |
| `POST /auth/re-authenticate` | `password` | `204` | 成功写当前 `session.last_authenticated_at`；仅当前 Session 的敏感操作有效 15 分钟。 |
| `POST /auth/password` | `currentPassword`、`newPassword` | `204` | 需重认证；更新 Credential、撤销当前会话族以外全部会话，并写审计。 |

`register`、`login` 也执行 Origin 和 `X-OPC-CSRF` 检查；防止在 PWA 同源部署中被跨站表单诱导。首次注册/登录无需已有 Cookie。

### 3.2 当前主体与账户状态

| 方法/路径 | 成功响应 | 规则 |
|---|---|---|
| `GET /me` | `user`、`workspaceSummary`、`reauthUntil`、`permissions` | 返回当前身份，禁止返回 password/session hash。 |
| `GET /me/sessions` | 当前用户会话摘要列表 | 仅返回设备摘要、签发/到期/最近使用/当前会话标记。 |
| `DELETE /me/sessions/{sessionId}` | `204` | 撤销指定会话；当前会话也允许，随后客户端退出。 |

当 `user.status=DEACTIVATION_GRACE` 或 `workspace.status=READ_ONLY` 时，允许只读、导出查询、注销撤销；新建/编辑业务资源和 AI 调用统一返回 `403 WORKSPACE_READ_ONLY`。`TOMBSTONED` 全部用户接口统一返回 `403 ACCOUNT_DEACTIVATED`；419 只用于 Refresh Token 撤销、重放或过期。

---

## 4 工作空间、画像与授权

### 4.1 工作空间与画像

| 方法/路径 | 请求关键字段 | 成功响应 | 契约 |
|---|---|---|---|
| `POST /workspace` | `name`、`description?` | `201 workspace` | 仅无空间账户可创建；同事务创建 workspace 级 `CORE_SERVICE=GRANTED` consent；重复返回 `409 WORKSPACE_ALREADY_EXISTS`。 |
| `GET /workspace` | — | `workspace` | 当前空间。 |
| `PATCH /workspace` | `name?`、`description?`、`expectedVersion` | `200 workspace` | 改名应用自然年 ≤3 次；版本条件更新。 |
| `GET /profile` | — | `profile` | 当前空间画像。 |
| `PUT /profile` | `skills`、`entrepreneurStage`、`businessGoal`、`visibilitySetting`、`expectedVersion` | `200 profile` | `skills` 最大 20；提交完整画像后设置 `completedAt`。 |

`POST /workspace`、`PATCH /workspace`、`PUT /profile` 必须提供 `Idempotency-Key`。画像未完成时，`POST /projects` 返回 `422 PROFILE_INCOMPLETE`。

### 4.2 授权

| 方法/路径 | 请求 | 成功响应 | 契约 |
|---|---|---|---|
| `GET /consents` | — | 当前 `consent[]` | 每项返回用途/政策版本/状态/授予与撤回时间。 |
| `PUT /consents/{type}` | `status='GRANTED'`、`policyVersion`、`purposeVersion`、`expectedVersion?` | `200 consent` | 仅用于授予/重新授予；`type` 为 `AI_BUSINESS_DATA`、`MODEL_IMPROVEMENT`、`PERSONALIZATION`、`MARKETING`。不存在时创建；已有时须带版本。撤回不得通过该接口绕过重认证。 |
| `POST /consents/{type}/revoke` | `expectedVersion` | `200 consent` | 需当前 Session 在 15 分钟内重认证；`CORE_SERVICE` 不提供撤回，返回 `422 CONSENT_REQUIRED`。 |

每项变更同事务写 `audit_event`。撤回 `AI_BUSINESS_DATA` 后，新的 AI run 返回 `403 CONSENT_REQUIRED`，手动业务 API 不受影响。

---

## 5 项目与个人任务

### 5.1 项目资源

`project` 响应：`id`、`name`、`objective`、`deliverable`、`status`、`plannedStartAt`、`plannedEndAt`、`source`、`taskSummary`（总数/完成数/延期数）、`version`、时间戳。

| 方法/路径 | 请求关键字段 | 成功响应 | 规则 |
|---|---|---|---|
| `GET /projects` | `status?`、分页 | 项目列表 | 默认不返回完整任务树。 |
| `POST /projects` | `name`、`objective`、`deliverable?`、计划日期 | `201 project` | 初始 `DRAFT`；需幂等键。 |
| `GET /projects/{projectId}` | `include=tasks?` | 项目详情 | `include=tasks` 最多返回三级树、每层 100 项。 |
| `PATCH /projects/{projectId}` | 可编辑字段、`expectedVersion` | `200 project` | 仅 `DRAFT/IN_PROGRESS/PAUSED` 可编辑。 |
| `POST /projects/{projectId}/actions/start` | `expectedVersion` | `200 project` | 至少一项 `CONFIRMED/IN_PROGRESS` 任务。 |
| `POST /projects/{projectId}/actions/pause` | `expectedVersion` | `200 project` | 仅 `IN_PROGRESS`。 |
| `POST /projects/{projectId}/actions/resume` | `expectedVersion` | `200 project` | 仅 `PAUSED`。 |
| `POST /projects/{projectId}/actions/complete` | `expectedVersion` | `200 project` | 所有非取消任务必须 `COMPLETED/CLOSED`；不得自动调用。 |
| `POST /projects/{projectId}/actions/cancel` | `expectedVersion`、`childTaskHandling` | `200 project` | `childTaskHandling` 为 `KEEP` 或 `CANCEL_ALL`；非终态子任务未处理返回 422。 |

所有项目写接口需要 `Idempotency-Key`，状态错误返回 `409 INVALID_STATE_TRANSITION`，版本冲突返回 `409 RESOURCE_VERSION_CONFLICT`。

### 5.2 任务资源

`task` 响应：`id`、`projectId`、`parentTaskId`、`depth`、`title`、`description`、`assigneeUserId`、`status`、`dueAt`、`estimatedMinutes`、`isDeferred`、`isOverdue`、`source`、`sourceAiSuggestionId`、`version`、时间戳。

| 方法/路径 | 请求关键字段 | 成功响应 | 规则 |
|---|---|---|---|
| `GET /projects/{projectId}/tasks` | `parentTaskId?`、`status?`、分页 | 任务列表/树 | 仅项目所属空间。 |
| `POST /projects/{projectId}/tasks` | `title?`、`description?`、`parentTaskId?`、`dueAt?`、`estimatedMinutes?` | `201 task` | 字段未完整时可创建 `DRAFT`；最多三级。 |
| `GET /tasks/{taskId}` | — | 任务详情 | 返回来源建议摘要，不返回其他 AI 原始内容。 |
| `PATCH /tasks/{taskId}` | 可编辑字段、`expectedVersion` | `200 task` | `CLOSED/CANCELLED` 不可编辑。 |
| `POST /tasks/{taskId}/actions/confirm` | `expectedVersion` | `200 task` | 仅手动 `DRAFT → CONFIRMED`。 |
| `POST /tasks/{taskId}/actions/start` | `expectedVersion` | `200 task` | `CONFIRMED → IN_PROGRESS`。 |
| `POST /tasks/{taskId}/actions/complete` | `expectedVersion` | `200 task` | `IN_PROGRESS → COMPLETED`。 |
| `POST /tasks/{taskId}/actions/close` | `expectedVersion` | `200 task` | `COMPLETED → CLOSED`。 |
| `POST /tasks/{taskId}/actions/cancel` | `expectedVersion`、`childTaskHandling?` | `200 task` | 非终态子任务必须显式 `CANCEL_ALL` 或先处理。 |
| `POST /tasks/{taskId}/actions/defer` | `expectedVersion`、`isDeferred` | `200 task` | 仅 `IN_PROGRESS`；主状态不变。 |

不得提供 AI 建议创建的未确认 `task` 资源。AI 确认生成的任务直接是 `CONFIRMED`，只能经 §6.3 建议确认接口创建。

---

## 6 CRM-lite 与 AI COO

### 6.1 客户

`customer` 响应：`id`、`name`、`source`、`intentLevel`、`stage`、`nextAction`、`notes`、`version`、时间戳。`notes` 仅当前空间用户可读，绝不进入审计完整摘要或通用运营接口。

| 方法/路径 | 请求关键字段 | 成功响应 | 规则 |
|---|---|---|---|
| `GET /customers` | `stage?`、`intentLevel?`、分页 | 客户列表 | 默认 `-updatedAt`。 |
| `POST /customers` | `name`、`source`、`intentLevel`、`nextAction`、`notes?` | `201 customer` | 初始 `LEAD`，需幂等键。 |
| `GET /customers/{customerId}` | — | 客户详情 | 当前空间。 |
| `PATCH /customers/{customerId}` | 可编辑字段、`expectedVersion` | `200 customer` | `stage` 不可经 PATCH 修改。 |
| `POST /customers/{customerId}/actions/change-stage` | `toStage`、`reason?`、`expectedVersion` | `200 customer` | 执行 04 客户转换矩阵，同时追加 history 与审计。 |
| `GET /customers/{customerId}/stage-history` | 分页 | 阶段历史 | 只读追加历史。 |

### 6.2 创建 AI Run（SSE）

`POST /ai/runs` 的请求体：

```json
{
  "capability": "TASK_BREAKDOWN",
  "projectId": "018f...",
  "input": { "instruction": "可选补充说明" }
}
```

| 字段 | 规则 |
|---|---|
| `capability` | `TASK_BREAKDOWN` 或 `DAILY_TOP3`。 |
| `projectId` | `TASK_BREAKDOWN` 必填；服务端以当前空间复合校验。`DAILY_TOP3` 不传。 |
| `input.instruction` | 可选文本，最多 2000 字符；作为用户消息分区，不得影响系统指令。 |

请求必须带 `Accept: text/event-stream`、`Idempotency-Key`。服务端先创建 `ai_run`（含授权证据、脱敏规则、traceId），再返回 SSE；若请求已用相同幂等键完成，返回该 run 的可恢复事件流/最终快照，不重新调用模型。

SSE 事件：

```text
event: run.created
id: 1
data: {"runId":"...","traceId":"...","status":"PROCESSING"}

event: run.progress
id: 2
data: {"runId":"...","phase":"MODEL_CALL"}

event: suggestion.ready
id: 3
data: {"runId":"...","suggestionIds":["..."],"status":"WAITING_CONFIRMATION"}

event: run.completed
id: 4
data: {"runId":"...","status":"GENERATED"}
```

允许事件：`run.created`、`run.progress`、`clarification.required`、`suggestion.ready`、`run.degraded`、`run.failed`、`run.completed`。事件中不得出现原始系统 Prompt、供应商错误、未脱敏客户信息或原始模型 token；建议内容由后续读取接口获取。首个 `run.created` 事件目标 P95 ≤3 秒，最终 `suggestion.ready`/终态目标 P95 ≤15 秒。客户端断开不取消已持久化 run；可通过 `GET /ai/runs/{runId}` 轮询恢复。

### 6.3 AI Run、建议与确认

| 方法/路径 | 请求关键字段 | 成功响应 | 规则 |
|---|---|---|---|
| `GET /ai/runs` | `capability?`、`status?`、分页 | run 列表 | 仅摘要，显示 traceId/模型/状态/时间。 |
| `GET /ai/runs/{runId}` | — | run 详情 | 返回脱敏 input/output 摘要、授权证据、失败码。 |
| `GET /ai/suggestions` | `status?`、`runId?`、分页 | 建议列表 | 默认待确认优先。 |
| `GET /ai/suggestions/{suggestionId}` | — | 建议详情 | 返回 `proposedPayload`、schemaVersion、来源 run 摘要。 |
| `POST /ai/suggestions/{suggestionId}/actions/confirm` | `expectedVersion`、`editedPayload?` | `200 {suggestion, createdResources[]}` | 一个事务内条件更新建议、追加决议、创建任务/更新业务对象、审计。 |
| `POST /ai/suggestions/{suggestionId}/actions/reject` | `expectedVersion`、`reason?` | `200 suggestion` | 不创建或更新业务对象。 |

确认接口的 `editedPayload` 须通过同一 JSON Schema，且服务端强制覆盖所有 `workspaceId`、`assigneeUserId`、`projectId` 等归属字段：客户端不得指定其他空间、其他用户或第 4 级任务。`EXECUTION_FAILED` 为终态，返回 `409 INVALID_STATE_TRANSITION`；用户可手动建任务或新开 AI run，不能自动重新确认。

`TASK_PLAN` 的每个建议条目必须包含服务端生成的稳定 `itemKey`（同一建议内唯一，最长 64 字符）。UI 可编辑业务字段但不得修改、增加或复用 `itemKey`；确认事务以 `(suggestionId, itemKey)` 写入 `task.source_ai_suggestion_id/source_ai_item_key`，允许一条建议创建多项任务并防止单项重复写入。

### 6.4 每日三件事

`DAILY_TOP3` run 生成后，建议 payload 最多三项，每项仅含 `taskId`、`rank`、`reason`。确认不创建任务。

| 方法/路径 | 请求 | 成功响应 | 规则 |
|---|---|---|---|
| `GET /dashboard/daily-top3` | `date?` | 当日建议或活跃任务降级列表 | 无建议时 `data.source=FALLBACK_ACTIVE_TASKS`。 |
| `POST /dashboard/daily-top3/actions/viewed` | `runId?` | `204` | 写产品事件，不改变业务对象。 |
| `POST /dashboard/daily-top3/actions/confirm` | `suggestionId`、`expectedVersion`、`items` | `200 suggestion` | `items` 为 1–3 项有序数组 `[{taskId, rank}]`，`rank` 从 1 连续递增且 taskId 必须来自原建议；省略某项表示移除。复用 AI 建议确认决议，只确认排序，不修改任务。 |

---

## 7 导出、注销与 AI 使用量

### 7.1 导出

| 方法/路径 | 请求/响应 | 契约 |
|---|---|---|
| `POST /exports` | 请求 `{"format":"CSV","scope":"CORE_BUSINESS_DATA"}`；响应 `202 exportJob` | 创建 `REQUESTED/QUEUED` job、异步作业和审计；需幂等键。 |
| `GET /exports` | 分页 | 当前空间导出任务列表。 |
| `GET /exports/{exportId}` | — | 状态、文件元数据、到期时间；不返回 object key。 |
| `POST /exports/{exportId}/download-token` | `expectedVersion` | `200 {downloadToken, expiresAt}` | 仅 `READY`；令牌哈希存库，最多一个活跃未消费令牌。 |
| `POST /exports/{exportId}/download` | `{"token":"..."}` | `303` 至短效签名对象 URL，或受控 `200 text/csv` | 消费 token 与下载状态同事务更新；重放 409 `DOWNLOAD_TOKEN_CONSUMED`。 |

一次性 token 作为 POST body 传输，必须不写入日志、埋点、Referer 或错误回显；下载请求校验当前认证用户与 token 颁发用户一致。若返回对象存储签名 URL，响应使用 `Referrer-Policy: no-referrer`，且签名 URL 有效期不超过 60 秒。宽限期内仍可发起和下载基础数据导出。

### 7.2 注销与恢复

| 方法/路径 | 请求/响应 | 契约 |
|---|---|---|
| `POST /deactivation-requests` | `reason?` | `202 deactivationRequest` | 服务端从当前 `session.last_authenticated_at` 验证 15 分钟重认证，绝不信任客户端时间或其他 Session；创建请求并置空间只读，撤销除当前 Session 外的所有 Session family；当前 Session 保留至用户离开/注销或正常过期，仅允许只读、导出和撤销注销；同时拒绝 AI 新调用、写 Worker 与审计。 |
| `GET /deactivation-request` | — | 当前/最近请求 | 返回状态、宽限结束、保留例外原因和预计期限。 |
| `POST /deactivation-request/actions/revoke` | `expectedVersion` | `200 deactivationRequest` | 服务端从当前 `session.last_authenticated_at` 验证 15 分钟重认证；仅 `GRACE`；恢复 `user/workspace=ACTIVE`，写审计。 |

创建/撤销均需 `Idempotency-Key`。`RETENTION_HOLD` 不允许用户撤销后直接恢复，返回 `409 INVALID_STATE_TRANSITION` 并展示保留原因。`TOMBSTONED` 不提供恢复接口。

### 7.3 AI 使用量

| 方法/路径 | 成功响应 | 契约 |
|---|---|---|
| `GET /ai/usage` | 当日/月度调用、能力配额、预估费用 | 从 `ai_usage_daily` 投影读取；不返回供应商密钥或内部成本策略。 |

---

## 8 运营与内部受控接口

运营接口要求独立 `platform_operator` 身份声明和 MFA，角色为 `PLATFORM_ADMIN` 或 `OPERATIONS_READER`，且默认仅返回聚合数据；不能通过业务 `workspace` 成员关系推导。运营登录不复用普通用户 `/auth/*` 接口；生产环境由独立管理员入口/受控 IdP 完成认证和 MFA，再向 API 传递服务端验证的 operator subject/role 声明。V1-A 不接受客户端自报角色，也不在普通用户 Token 中注入平台管理员角色。

| 方法/路径 | 权限 | 响应范围 |
|---|---|---|
| `GET /operations/metrics/funnel` | `OPERATIONS_READER` | 注册、画像、项目创建、任务确认、每日三件事访问聚合。 |
| `GET /operations/metrics/ai` | `OPERATIONS_READER` | 调用量、成功率、失败率、Schema 失败率、成本聚合。 |
| `GET /operations/users/search?identifier=...` | `PLATFORM_ADMIN` | 用于配额配置的受控用户搜索；输入至少 4 个字符、严格限流，返回 `userId`、掩码手机/邮箱、账户状态，不返回工作空间业务内容；每次查询写管理员审计。运营身份来自独立 `platform_operator`，必须完成 MFA。 |
| `PUT /operations/ai-quotas/users/{userId}` | `PLATFORM_ADMIN` | 设置用户能力配额；写操作审计，不返回私密业务内容。 |

V1-A 不提供面向运营人员的任意用户项目/任务/客户浏览、原始审计浏览或 AI Prompt 检索接口。

---

## 9 状态、并发与事务映射

| API 组 | 04 状态机/事务约束 | 契约落实 |
|---|---|---|
| 项目动作 | §7.1 | 独立 `/actions/*`，非法转移 409，动作请求带 `expectedVersion`。 |
| 任务动作 | §7.2 | 只允许手动 `DRAFT → CONFIRMED`；AI 任务由建议确认直接创建 `CONFIRMED`。 |
| 客户阶段 | CRM 转换矩阵 | `change-stage` 同事务写客户、阶段历史、审计。 |
| AI run/建议 | §7.3–§7.4 | SSE 只报告受控生命周期；确认在同事务创建资源/决议/审计。 |
| 授权 | §7.5 | 当前授权按 type 唯一；撤回即时影响新 AI run。 |
| 导出 | §7.6 | `202` 异步作业；一次性下载 token。 |
| 注销 | §7.7 | 15 分钟重认证、只读、宽限撤销、保留例外和 tombstone。 |
| 审计 | §7.8 | API 业务成功必须能同事务追加审计；审计不可由外部客户端编辑。 |

写请求处理顺序：**Origin/CSRF → 认证 → 账户/空间状态 → 资源归属 → 输入校验 → 幂等键占用/重放 → 乐观锁/状态校验 → 业务写入 + 审计同事务 → 响应缓存记录**。外部 AI、邮件、对象存储只由已持久化的 run/job 在事务外调用。

---

## 10 API 验收与下游交接

### 10.1 最小契约测试集

1. 所有写 API 缺 `Origin`/`X-OPC-CSRF` 均被拒绝；CORS 不允许 `*`。
2. Access Token 过期返回 401；Refresh 重放/撤销返回 419；客户端仅对 401 尝试一次刷新。
3. 跨空间 URL/资源 ID 一律返回 404，不能以响应差异泄露存在性。
4. 所有业务写操作重复调用相同 `Idempotency-Key` 返回原结果；同键不同请求返回 409。
5. 旧 `expectedVersion` 返回 409，不产生业务写或成功审计。
6. AI SSE 不泄露原始 Prompt/模型 token/未脱敏客户信息；同一建议双击确认仅创建一次资源。
7. 导出 token 单次消费；注销宽限期拒绝新写和 AI、但允许读取/导出/撤销。
8. 运营接口不能读取用户私密业务正文；配额修改必须产生审计。

### 10.2 06 UI/UX 交接

UI/UX 必须围绕：`409 RESOURCE_VERSION_CONFLICT` 刷新提示、`422 REAUTH_REQUIRED` 重认证弹层、`403 WORKSPACE_READ_ONLY` 宽限期只读页、`419 SESSION_REVOKED` 重新登录、AI SSE 的处理中/澄清/降级/失败态、导出 `202` 轮询和一次性下载、状态动作的显式确认设计。

### 10.3 07 测试与发布交接

07 必须覆盖：CSRF/Origin、Token 轮换重放、跨空间越权、状态机穷举、幂等与乐观锁、SSE 断线恢复、AI 输入脱敏、导出 token 重放、注销保留例外、审计同事务和 API 性能口径。

---

## 11 可追溯性与修订记录

| 上游约束 | 本文落实 |
|---|---|
| 架构 §13.2 CSRF、SameSite、会话族 | §2.1、§3 |
| 架构 §13.4 AI 限流/降级/熔断 | §2.3、§6.2–§6.3、§7.3 |
| 架构 §13.5 注销状态机 | §3.2、§7.2、§9 |
| 04 §2 并发/隔离、§7 状态机 | §2.4、§5–§9 |
| PRD US-A01–A05 | §3–§4 |
| PRD US-B01–B05、US-D02–D03 | §5–§6.1 |
| PRD US-C01–C05、US-D01 | §6.2–§6.4 |
| PRD US-E01–E03 | §4.2、§7 |
| PRD US-F01–F03 | §7.3、§8 |

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-07-13 | 基于 SRS、PRD、架构 v1.1 与数据模型 v1.1，定义 V1-A REST/SSE API、认证与 CSRF、错误码、并发/幂等、资源、AI、导出、注销和运营聚合契约。 |
| v1.1 | 2026-07-13 | 跨文档评审：同步上游版本；仅对过期 Access Token 刷新；重认证绑定当前 Session；授权撤回不可通过 PUT 绕过重认证；定义每日三件事 items 结构；新增受控运营用户搜索接口及防枚举约束；注册改为记录条款/隐私版本、工作空间创建时生成 `CORE_SERVICE`；注销保留当前只读 Session 并撤销其他会话。 |
| v1.2 | 2026-07-13 | 固化独立平台运营身份、MFA 和角色边界；同步 SRS v0.5/架构 v1.3/数据模型 v1.4；补运营 API 的独立身份前置条件。 |
| v1.3 | 2026-07-13 | 同步架构 v1.4/数据模型 v1.5；明确运营独立认证入口不复用普通用户认证；实名能力保持 V1-A 基线关闭。 |

**文档结束**
