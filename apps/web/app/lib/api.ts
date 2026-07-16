export type ApiErrorShape = { code: string; message: string; details?: readonly Record<string, unknown>[] };
export class WebApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: readonly Record<string, unknown>[]) { super(message); }
}

type Envelope<T> = { data: T; meta?: { requestId?: string } };
let accessToken: string | undefined;
const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const writes = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function errorFrom(value: unknown, status: number): WebApiError {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") return new WebApiError(status, value.error.code, value.error.message, Array.isArray(value.error.details) ? value.error.details.filter(isRecord) : undefined);
  return new WebApiError(status, "DEPENDENCY_UNAVAILABLE", "服务暂时不可用，请稍后重试。");
}
function csrfHeaders(method: string): Record<string, string> { return writes.has(method) ? { Origin: window.location.origin, "X-OPC-CSRF": "1" } : {}; }
function idempotencyHeaders(): Record<string, string> { return { "Idempotency-Key": crypto.randomUUID() }; }
export function setAccessToken(token: string | undefined): void { accessToken = token; }
export function hasAccessToken(): boolean { return accessToken !== undefined; }

async function raw<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  Object.entries(csrfHeaders(method)).forEach(([key, value]) => headers.set(key, value));
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${apiBase}${path}`, { ...init, method, headers, credentials: "include" });
  if ((response.status === 401 || response.status === 419) && !retried && !path.endsWith("/auth/refresh")) {
    try { const refreshed = await raw<{ accessToken: string }>("/api/v1/auth/refresh", { method: "POST" }, true); accessToken = refreshed.accessToken; return raw<T>(path, init, true); } catch { accessToken = undefined; }
  }
  if (!response.ok) { let body: unknown; try { body = await response.json(); } catch { body = undefined; } throw errorFrom(body, response.status); }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (!isRecord(body) || !("data" in body)) throw new WebApiError(response.status, "INVALID_RESPONSE", "服务返回了无法识别的结果。");
  return (body as Envelope<T>).data;
}
export const api = {
  register: (body: { email?: string; phone?: string; password: string; termsVersion: string; privacyVersion: string }) => raw<{ id: string }>("/api/v1/auth/register", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  login: async (body: { identifier: string; password: string }) => { const result = await raw<{ accessToken: string; expiresAt: string; user: User }>("/api/v1/auth/login", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); accessToken = result.accessToken; return result; },
  refresh: async () => { const result = await raw<{ accessToken: string; expiresAt: string }>("/api/v1/auth/refresh", { method: "POST" }); accessToken = result.accessToken; return result; },
  reauthenticate: (password: string) => raw<undefined>("/api/v1/auth/re-authenticate", { method: "POST", body: JSON.stringify({ password }), headers: { "Content-Type": "application/json" } }),
  workspace: { get: () => raw<Workspace>("/api/v1/workspace"), create: (body: { name: string; description?: string }) => raw<Workspace>("/api/v1/workspace", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) },
  profile: { get: () => raw<ProfileResult>("/api/v1/profile"), put: (body: ProfileInput) => raw<Profile>("/api/v1/profile", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) },
  consents: { list: () => raw<Consent[]>("/api/v1/consents"), grant: (type: string, body: { policyVersion: string; purposeVersion: string; expectedVersion?: number }) => raw<Consent>(`/api/v1/consents/${type}`, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), revoke: (type: string, expectedVersion: number) => raw<Consent>(`/api/v1/consents/${type}/revoke`, { method: "POST", body: JSON.stringify({ expectedVersion }), headers: { "Content-Type": "application/json" } }) },
  dashboard: { dailyTop3: () => raw<DailyTop3>("/api/v1/dashboard/daily-top3"), confirmTop3: (body: { suggestionId: string; expectedVersion: number; items: Array<{ taskId: string; rank: number }> }) => raw<Suggestion>("/api/v1/dashboard/daily-top3/actions/confirm", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) },
  projects: { list: (status?: string) => raw<ProjectList>(`/api/v1/projects?limit=50${status ? `&status=${encodeURIComponent(status)}` : ""}`), get: (id: string) => raw<Project>(`/api/v1/projects/${id}`), create: (body: ProjectInput) => raw<Project>("/api/v1/projects", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), update: (id: string, body: ProjectUpdateInput) => raw<Project>(`/api/v1/projects/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), action: (id: string, action: ProjectAction, expectedVersion: number, childTaskHandling?: "KEEP" | "CANCEL_ALL") => raw<Project>(`/api/v1/projects/${id}/actions/${action}`, { method: "POST", body: JSON.stringify({ expectedVersion, ...(childTaskHandling ? { childTaskHandling } : {}) }), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) },
  tasks: { list: (projectId: string) => raw<TaskList>(`/api/v1/projects/${projectId}/tasks?limit=100`), get: (id: string) => raw<Task>(`/api/v1/tasks/${id}`), create: (projectId: string, body: TaskInput) => raw<Task>(`/api/v1/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), update: (id: string, body: TaskUpdateInput) => raw<Task>(`/api/v1/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), action: (id: string, action: TaskAction, expectedVersion: number, options?: { childTaskHandling?: "CANCEL_ALL"; isDeferred?: boolean }) => raw<Task>(`/api/v1/tasks/${id}/actions/${action}`, { method: "POST", body: JSON.stringify({ expectedVersion, ...options }), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) },
  customers: { list: () => raw<CustomerList>("/api/v1/customers?limit=100"), get: (id: string) => raw<Customer>(`/api/v1/customers/${id}`), create: (body: CustomerInput) => raw<Customer>("/api/v1/customers", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), update: (id: string, body: CustomerUpdateInput) => raw<Customer>(`/api/v1/customers/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), changeStage: (id: string, body: { toStage: string; reason?: string; expectedVersion: number }) => raw<Customer>(`/api/v1/customers/${id}/actions/change-stage`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), history: (id: string) => raw<StageHistoryList>(`/api/v1/customers/${id}/stage-history?limit=100`) },
  ai: { run: (body: { capability: "TASK_BREAKDOWN" | "DAILY_TOP3"; projectId?: string; instruction?: string }, onEvent?: (event: AiStreamEvent) => void) => startAiRun(body, onEvent), getRun: (id: string) => raw<AiRun>(`/api/v1/ai/runs/${id}`), getSuggestion: (id: string) => raw<Suggestion>(`/api/v1/ai/suggestions/${id}`), editSuggestion: (id: string, body: { expectedVersion: number; items: SuggestionItem[] }) => raw<Suggestion>(`/api/v1/ai/suggestions/${id}/actions/edit`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), confirmSuggestion: (id: string, body: { expectedVersion: number; editedPayload?: { items: SuggestionItem[] } }) => raw<Suggestion>(`/api/v1/ai/suggestions/${id}/actions/confirm`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), rejectSuggestion: (id: string, body: { expectedVersion: number; reason?: string }) => raw<Suggestion>(`/api/v1/ai/suggestions/${id}/actions/reject`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) },
  exports: { list: () => raw<ExportJob[]>("/api/v1/exports"), request: () => raw<ExportJob>("/api/v1/exports", { method: "POST", body: JSON.stringify({ format: "CSV", scope: "CORE_BUSINESS_DATA" }), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), token: (id: string, expectedVersion: number) => raw<{ downloadToken: string; expiresAt: string }>(`/api/v1/exports/${id}/download-token`, { method: "POST", body: JSON.stringify({ expectedVersion }), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), download: (id: string, token: string) => downloadCsv(id, token) },
  deactivation: { get: () => raw<Deactivation>("/api/v1/deactivation-request"), request: (reason?: string) => raw<Deactivation>("/api/v1/deactivation-requests", { method: "POST", body: JSON.stringify(reason ? { reason } : {}), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }), revoke: (version: number) => raw<Deactivation>("/api/v1/deactivation-request/actions/revoke", { method: "POST", body: JSON.stringify({ expectedVersion: version }), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) },
  operations: { funnel: () => raw<OpsFunnel>("/api/v1/operations/metrics/funnel"), ai: () => raw<OpsAiMetrics>("/api/v1/operations/metrics/ai"), search: (identifier: string) => raw<OpsUser[]>(`/api/v1/operations/users/search?identifier=${encodeURIComponent(identifier)}`), setQuota: (userId: string, body: { capability: "TASK_BREAKDOWN" | "DAILY_TOP3"; dailyLimit: number }) => raw<OpsQuota>(`/api/v1/operations/ai-quotas/users/${userId}`, { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...idempotencyHeaders() } }) }
};
export type User = { id: string; email: string | null; phone: string | null; status: string; version: number };
export type Workspace = { id: string; name: string; description: string | null; status: string; version: number; created_at: string; updated_at: string };
export type Profile = { workspace_id: string; skills: string[]; entrepreneur_stage: string; business_goal: string; completed_at: string | null; version: number };
export type ProfileResult = { workspace: Workspace; profile: Profile | null };
export type ProfileInput = { skills: string[]; entrepreneurStage: string; businessGoal: string; expectedVersion: number };
export type Consent = { id: string; consent_type: string; status: string; policy_version: string; purpose_version: string; granted_at: string | null; revoked_at: string | null; version: number };
export type Project = { id: string; name: string; objective: string; deliverable: string | null; status: string; plannedStartAt: string | null; plannedEndAt: string | null; taskSummary: { total: number; completed: number; nonTerminal: number; overdue: number; completionRate: number | null }; version: number; updatedAt: string };
export type ProjectInput = { name: string; objective: string; deliverable?: string; plannedStartAt?: string; plannedEndAt?: string };
export type ProjectUpdateInput = { name?: string; objective?: string; deliverable?: string | null; plannedStartAt?: string | null; plannedEndAt?: string | null; expectedVersion: number };
export type ProjectAction = "start" | "pause" | "resume" | "complete" | "cancel";
export type Task = { id: string; projectId: string; parentTaskId: string | null; depth: number; title: string; description: string | null; status: string; dueAt: string | null; estimatedMinutes: number | null; isDeferred: boolean; isOverdue: boolean; source: string; version: number; createdAt: string; updatedAt: string };
export type TaskInput = { title: string; description?: string; parentTaskId?: string; dueAt?: string; estimatedMinutes?: number };
export type TaskUpdateInput = { title?: string; description?: string | null; dueAt?: string | null; estimatedMinutes?: number | null; expectedVersion: number };
export type TaskAction = "confirm" | "start" | "complete" | "close" | "cancel" | "defer";
export type Customer = { id: string; name: string; source: string; intentLevel: string; stage: string; nextAction: string | null; notes: string | null; version: number; updatedAt: string };
export type CustomerInput = { name: string; source: string; intentLevel: "LOW" | "MEDIUM" | "HIGH"; nextAction?: string; notes?: string };
export type CustomerUpdateInput = { name?: string; source?: string; intentLevel?: "LOW" | "MEDIUM" | "HIGH"; nextAction?: string | null; notes?: string | null; expectedVersion: number };
export type StageHistory = { id: string; fromStage: string | null; toStage: string; changedAt: string; reason: string | null };
export type DailyTop3 = { date: string; source: string; suggestion?: { id: string; runId: string; status: string; version: number; createdAt: string; updatedAt: string; confirmedAt: string | null }; items: Array<{ taskId: string; projectId: string; title: string; status: string; dueAt: string | null; rank: number; reason?: string }> };
export type ProjectList = { projects: Project[]; hasMore: boolean; nextCursor: string | null };
export type TaskList = { tasks: Task[]; hasMore: boolean; nextCursor: string | null };
export type CustomerList = { customers: Customer[]; hasMore: boolean; nextCursor: string | null };
export type StageHistoryList = { history: StageHistory[]; hasMore: boolean; nextCursor: string | null };
export type SuggestionItem = { itemKey?: string; taskId?: string; rank?: number; reason?: string; title?: string; description?: string | null; estimatedMinutes?: number | null; dueAt?: string | null };
export type Suggestion = { id: string; runId: string; type: string; status: string; proposedPayload: { items?: SuggestionItem[]; message?: string; question?: string }; targetProjectId: string | null; version: number; createdResources: Array<{ id: string; type: string }>; createdAt: string; updatedAt: string; confirmedAt: string | null; rejectedAt: string | null };
export type AiRun = { id: string; traceId: string; capability: string; status: string; outputSummary: { suggestionId?: string; suggestionType?: string; structured?: boolean } | null; errorCode: string | null; failureDetailSafe: string | null; createdAt: string; finishedAt: string | null };
export type AiStreamEvent = { event: string; data: Record<string, unknown> };
export type ExportJob = { id: string; status: string; format: string; scope: string; version: number; createdAt: string; updatedAt: string; expiresAt: string | null; failureCode: string | null; sizeBytes: number | null };
export type Deactivation = { id: string; status: string; requestedAt: string; graceEndsAt: string; revokedAt: string | null; retentionHold: boolean; retentionReason: string | null; retentionExpectedEndAt: string | null; tombstonedAt: string | null; version: number };
export type OpsFunnel = { window: { startDate: string; endDate: string }; metrics: Record<string, number> };
export type OpsAiMetrics = { window: { startDate: string; endDate: string }; metrics: Record<string, number> };
export type OpsUser = { userId: string; emailMasked: string | null; phoneMasked: string | null; status: string };
export type OpsQuota = { userId: string; capability: string; dailyLimit: number };

async function downloadCsv(id: string, token: string): Promise<Blob> { const headers = new Headers({ Accept: "text/csv", "Content-Type": "application/json", ...idempotencyHeaders(), Origin: window.location.origin, "X-OPC-CSRF": "1" }); if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`); const response = await fetch(`${apiBase}/api/v1/exports/${id}/download`, { method: "POST", headers, credentials: "include", body: JSON.stringify({ token }) }); if (!response.ok) { let value: unknown; try { value = await response.json(); } catch { value = undefined; } throw errorFrom(value, response.status); } return response.blob(); }

async function startAiRun(body: { capability: "TASK_BREAKDOWN" | "DAILY_TOP3"; projectId?: string; instruction?: string }, onEvent?: (event: AiStreamEvent) => void): Promise<AiRun> {
  const headers = new Headers({ Accept: "text/event-stream", "Content-Type": "application/json", ...idempotencyHeaders(), Origin: window.location.origin, "X-OPC-CSRF": "1" });
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${apiBase}/api/v1/ai/runs`, { method: "POST", headers, credentials: "include", body: JSON.stringify({ capability: body.capability, ...(body.projectId ? { projectId: body.projectId } : {}), ...(body.instruction ? { input: { instruction: body.instruction } } : {}) }) });
  if (!response.ok) { let value: unknown; try { value = await response.json(); } catch { value = undefined; } throw errorFrom(value, response.status); }
  const reader = response.body?.getReader(); if (!reader) throw new WebApiError(response.status, "INVALID_RESPONSE", "AI 运行结果不可读取。");
  const decoder = new TextDecoder(); let buffer = ""; let runId: string | undefined;
  while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? ""; for (const block of blocks) { const event = block.match(/^event:\s*(.+)$/m)?.[1]; const data = block.match(/^data:\s*(.+)$/m)?.[1]; if (!event || !data) continue; const parsed: unknown = JSON.parse(data); if (isRecord(parsed)) { if (typeof parsed.runId === "string") runId = parsed.runId; onEvent?.({ event, data: parsed }); } } }
  if (runId) return raw<AiRun>(`/api/v1/ai/runs/${runId}`);
  throw new WebApiError(response.status, "INVALID_RESPONSE", "AI 运行结果缺少必要标识。");
}
