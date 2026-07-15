import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";
import { recordIdempotent, replayIdempotent, requireUpdatedRow, validateExpectedVersion } from "../platform/concurrency.js";

export interface ProjectDeps { pool: Pool; }
type Context = { userId: string; requestId: string; traceId: string };
type ProjectStatus = "DRAFT" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "CANCELLED";

export interface ProjectInput {
  name: string;
  objective: string;
  deliverable?: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
}

export interface ProjectUpdateInput {
  name?: string;
  objective?: string;
  deliverable?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  expectedVersion: number;
}

type ProjectRow = {
  id: string; workspace_id: string; name: string; objective: string; deliverable: string | null; status: ProjectStatus;
  planned_start_at: string | Date | null; planned_end_at: string | Date | null; completed_at: Date | null; cancelled_at: Date | null;
  source: string; created_at: Date; updated_at: Date; version: number; task_total: number; task_completed: number; task_cancelled: number; task_draft: number; task_confirmed: number; task_in_progress: number; task_overdue: number;
};

const statuses = new Set<ProjectStatus>(["DRAFT", "IN_PROGRESS", "PAUSED", "COMPLETED", "CANCELLED"]);

function normalizeText(value: string, maximum: number, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new ApiError(422, "VALIDATION_FAILED", `${field}长度不符合要求。`);
  return normalized;
}

function validateDate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new ApiError(422, "VALIDATION_FAILED", `${field}必须为有效日期。`);
  }
  return value;
}

function validateDates(start: string | null, end: string | null): void {
  if (start && end && start > end) throw new ApiError(422, "VALIDATION_FAILED", "计划结束日期不得早于开始日期。");
}


function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function projectResponse(row: ProjectRow) {
  const total = Number(row.task_total); const completed = Number(row.task_completed); const cancelled = Number(row.task_cancelled); const actionableTotal = total - cancelled;
  return {
    id: row.id, name: row.name, objective: row.objective, deliverable: row.deliverable, status: row.status,
    plannedStartAt: dateOnly(row.planned_start_at), plannedEndAt: dateOnly(row.planned_end_at), source: row.source,
    taskSummary: {
      total,
      completed,
      cancelled,
      draft: Number(row.task_draft),
      confirmed: Number(row.task_confirmed),
      inProgress: Number(row.task_in_progress),
      nonTerminal: actionableTotal - completed,
      overdue: Number(row.task_overdue),
      completionRate: actionableTotal === 0 ? null : Math.round((completed / actionableTotal) * 10_000) / 100
    },
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, cancelledAt: row.cancelled_at?.toISOString() ?? null
  };
}

const projectSelect = `SELECT p.*, COALESCE(count(t.id), 0)::int AS task_total,
  COALESCE(count(t.id) FILTER (WHERE t.status IN ('COMPLETED', 'CLOSED')), 0)::int AS task_completed,
  COALESCE(count(t.id) FILTER (WHERE t.status = 'CANCELLED'), 0)::int AS task_cancelled,
  COALESCE(count(t.id) FILTER (WHERE t.status = 'DRAFT'), 0)::int AS task_draft,
  COALESCE(count(t.id) FILTER (WHERE t.status = 'CONFIRMED'), 0)::int AS task_confirmed,
  COALESCE(count(t.id) FILTER (WHERE t.status = 'IN_PROGRESS'), 0)::int AS task_in_progress,
  COALESCE(count(t.id) FILTER (WHERE t.due_at < now() AND t.status NOT IN ('COMPLETED', 'CLOSED', 'CANCELLED')), 0)::int AS task_overdue
  FROM project p LEFT JOIN task t ON t.project_id = p.id AND t.workspace_id = p.workspace_id`;

async function workspaceForRead(pool: Pool | PoolClient, userId: string): Promise<{ id: string; status: string; completedAt: Date | null }> {
  const result = await pool.query<{ id: string; status: string; completed_at: Date | null }>(`SELECT w.id, w.status, p.completed_at
    FROM workspace w LEFT JOIN profile p ON p.workspace_id = w.id WHERE w.owner_user_id = $1`, [userId]);
  const current = result.rows[0];
  if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");
  return { id: current.id, status: current.status, completedAt: current.completed_at };
}

async function workspaceForWrite(pool: Pool | PoolClient, userId: string, requireProfile = false): Promise<string> {
  const workspace = await workspaceForRead(pool, userId);
  if (workspace.status !== "ACTIVE") throw new ApiError(403, "WORKSPACE_READ_ONLY", "当前工作空间为只读状态。");
  if (requireProfile && !workspace.completedAt) throw new ApiError(422, "PROFILE_INCOMPLETE", "请先完成工作空间画像。");
  return workspace.id;
}

async function projectById(connection: Pool | PoolClient, workspaceId: string, projectId: string): Promise<ProjectRow | undefined> {
  const result = await connection.query<ProjectRow>(`${projectSelect} WHERE p.id = $1 AND p.workspace_id = $2 GROUP BY p.id`, [projectId, workspaceId]);
  return result.rows[0];
}


export async function listProjects(input: { status?: string[] | undefined; limit?: number | undefined; cursor?: string | undefined }, context: Context, deps: ProjectDeps) {
  const workspaceId = (await workspaceForRead(deps.pool, context.userId)).id;
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(422, "VALIDATION_FAILED", "limit 必须为 1 到 100 的整数。");
  const requestedStatuses = input.status ?? [];
  if (requestedStatuses.some((status) => !statuses.has(status as ProjectStatus))) throw new ApiError(422, "VALIDATION_FAILED", "status 包含不支持的值。");
  let cursor: { updatedAt: string; id: string } | undefined;
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { updatedAt: string; id: string }; } catch { throw new ApiError(422, "VALIDATION_FAILED", "cursor 无效。"); }
    if (!cursor.updatedAt || !cursor.id) throw new ApiError(422, "VALIDATION_FAILED", "cursor 无效。");
  }
  const values: unknown[] = [workspaceId];
  const filters = ["p.workspace_id = $1"];
  if (requestedStatuses.length) { values.push(requestedStatuses); filters.push(`p.status = ANY($${values.length}::text[])`); }
  if (cursor) { values.push(cursor.updatedAt, cursor.id); filters.push(`(p.updated_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
  values.push(limit + 1);
  const rows = await deps.pool.query<ProjectRow>(`${projectSelect} WHERE ${filters.join(" AND ")} GROUP BY p.id ORDER BY p.updated_at DESC, p.id DESC LIMIT $${values.length}`, values);
  const page = rows.rows.slice(0, limit); const tail = page.at(-1);
  return { projects: page.map(projectResponse), nextCursor: rows.rows.length > limit && tail ? Buffer.from(JSON.stringify({ updatedAt: tail.updated_at.toISOString(), id: tail.id })).toString("base64url") : null, hasMore: rows.rows.length > limit };
}

export async function getProject(projectId: string, context: Context, deps: ProjectDeps) {
  const workspaceId = (await workspaceForRead(deps.pool, context.userId)).id; const current = await projectById(deps.pool, workspaceId, projectId);
  if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该项目。");
  return projectResponse(current);
}

export async function createProject(input: ProjectInput, idempotencyKey: string, context: Context, deps: ProjectDeps) {
  const name = normalizeText(input.name, 160, "项目名称"); const objective = normalizeText(input.objective, 4000, "项目目标");
  const deliverable = input.deliverable === undefined || input.deliverable === "" ? null : normalizeText(input.deliverable, 2000, "交付物");
  const plannedStartAt = validateDate(input.plannedStartAt, "计划开始日期"); const plannedEndAt = validateDate(input.plannedEndAt, "计划结束日期"); validateDates(plannedStartAt, plannedEndAt);
  const normalized = { name, objective, deliverable, plannedStartAt, plannedEndAt };
  const client = await deps.pool.connect();
    try { await client.query("BEGIN"); const replay = await replayIdempotent(client, context, "project.create", idempotencyKey, normalized); if (replay) { await client.query("COMMIT"); return replay; }
    const workspaceId = await workspaceForWrite(client, context.userId, true); const id = randomUUID();
    await client.query(`INSERT INTO project (id, workspace_id, name, objective, deliverable, planned_start_at, planned_end_at, created_by_user_id, updated_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, workspaceId, name, objective, deliverable, plannedStartAt, plannedEndAt, context.userId]);
    const row = await projectById(client, workspaceId, id); if (!row) throw new Error("Project creation was not persisted"); const response = projectResponse(row);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId, action: "PROJECT_CREATED", resourceType: "project", resourceId: id, afterSummary: { status: "DRAFT" }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" });
    await recordIdempotent(client, context, "project.create", idempotencyKey, normalized, id, response); await client.query("COMMIT"); return response;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function updateProject(projectId: string, input: ProjectUpdateInput, idempotencyKey: string, context: Context, deps: ProjectDeps) {
  validateExpectedVersion(input.expectedVersion);
  const idempotencyInput = { projectId, ...input };
  const client = await deps.pool.connect();
    try { await client.query("BEGIN"); const replay = await replayIdempotent(client, context, "project.update", idempotencyKey, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspaceId = await workspaceForWrite(client, context.userId); const current = await projectById(client, workspaceId, projectId);
    if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该项目。");
    if (!(["DRAFT", "IN_PROGRESS", "PAUSED"] as ProjectStatus[]).includes(current.status)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "终态项目不可编辑。");
    const name = input.name === undefined ? current.name : normalizeText(input.name, 160, "项目名称"); const objective = input.objective === undefined ? current.objective : normalizeText(input.objective, 4000, "项目目标");
    const deliverable = input.deliverable === undefined ? current.deliverable : (input.deliverable === null || input.deliverable === "" ? null : normalizeText(input.deliverable, 2000, "交付物"));
    const plannedStartAt = input.plannedStartAt === undefined ? dateOnly(current.planned_start_at) : validateDate(input.plannedStartAt, "计划开始日期"); const plannedEndAt = input.plannedEndAt === undefined ? dateOnly(current.planned_end_at) : validateDate(input.plannedEndAt, "计划结束日期"); validateDates(plannedStartAt, plannedEndAt);
    const update = await client.query(`UPDATE project SET name=$1, objective=$2, deliverable=$3, planned_start_at=$4, planned_end_at=$5, updated_by_user_id=$6, version=version+1
      WHERE id=$7 AND workspace_id=$8 AND version=$9 RETURNING id`, [name, objective, deliverable, plannedStartAt, plannedEndAt, context.userId, projectId, workspaceId, input.expectedVersion]);
    requireUpdatedRow(update.rows[0]);
    const row = await projectById(client, workspaceId, projectId); if (!row) throw new Error("Updated project was not found"); const response = projectResponse(row);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId, action: "PROJECT_UPDATED", resourceType: "project", resourceId: projectId, beforeSummary: { status: current.status }, afterSummary: { status: row.status }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" });
    await recordIdempotent(client, context, "project.update", idempotencyKey, idempotencyInput, projectId, response); await client.query("COMMIT"); return response;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function transitionProject(projectId: string, action: "start" | "pause" | "resume" | "complete" | "cancel", input: { expectedVersion: number; childTaskHandling?: "KEEP" | "CANCEL_ALL" }, idempotencyKey: string, context: Context, deps: ProjectDeps) {
  validateExpectedVersion(input.expectedVersion);
  if (!["start", "pause", "resume", "complete", "cancel"].includes(action)) throw new ApiError(422, "VALIDATION_FAILED", "项目动作无效。");
  if (action === "cancel" && input.childTaskHandling && !["KEEP", "CANCEL_ALL"].includes(input.childTaskHandling)) throw new ApiError(422, "VALIDATION_FAILED", "childTaskHandling 无效。");
  const idempotencyInput = { projectId, action, ...input };
  const client = await deps.pool.connect();
    try { await client.query("BEGIN"); const scope = `project.${action}`; const replay = await replayIdempotent(client, context, scope, idempotencyKey, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspaceId = await workspaceForWrite(client, context.userId); const current = await projectById(client, workspaceId, projectId);
    if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该项目。");
    const taskState = await client.query<{ active_tasks: number; startable_tasks: number; incompletable_tasks: number }>(`SELECT
      count(*) FILTER (WHERE status NOT IN ('COMPLETED','CLOSED','CANCELLED'))::int AS active_tasks,
      count(*) FILTER (WHERE status IN ('CONFIRMED','IN_PROGRESS'))::int AS startable_tasks,
      count(*) FILTER (WHERE status NOT IN ('COMPLETED','CLOSED','CANCELLED'))::int AS incompletable_tasks
      FROM task WHERE project_id=$1 AND workspace_id=$2`, [projectId, workspaceId]);
    const counts = taskState.rows[0] ?? { active_tasks: 0, startable_tasks: 0, incompletable_tasks: 0 };
    let next: ProjectStatus; let completed = false; let cancelled = false;
    if (action === "start") { if (current.status !== "DRAFT" || counts.startable_tasks < 1) throw new ApiError(409, "INVALID_STATE_TRANSITION", "项目启动需要至少一个已确认或进行中的任务。"); next = "IN_PROGRESS"; }
    else if (action === "pause") { if (current.status !== "IN_PROGRESS") throw new ApiError(409, "INVALID_STATE_TRANSITION", "仅进行中的项目可以暂停。"); next = "PAUSED"; }
    else if (action === "resume") { if (current.status !== "PAUSED") throw new ApiError(409, "INVALID_STATE_TRANSITION", "仅已暂停的项目可以恢复。"); next = "IN_PROGRESS"; }
    else if (action === "complete") { if (!(["IN_PROGRESS", "PAUSED"] as ProjectStatus[]).includes(current.status) || counts.incompletable_tasks > 0) throw new ApiError(409, "INVALID_STATE_TRANSITION", "项目存在未完成任务或当前状态不允许完成。"); next = "COMPLETED"; completed = true; }
    else { if (!(["DRAFT", "IN_PROGRESS", "PAUSED"] as ProjectStatus[]).includes(current.status)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "当前项目状态不可取消。"); if (counts.active_tasks > 0 && !input.childTaskHandling) throw new ApiError(422, "VALIDATION_FAILED", "存在未终态任务，请明确处理方式。"); if (input.childTaskHandling === "CANCEL_ALL" && counts.active_tasks > 0) await client.query("UPDATE task SET status='CANCELLED', cancelled_at=now(), updated_by_user_id=$1, version=version+1 WHERE project_id=$2 AND workspace_id=$3 AND status NOT IN ('COMPLETED','CLOSED','CANCELLED')", [context.userId, projectId, workspaceId]); next = "CANCELLED"; cancelled = true; }
    const update = await client.query(`UPDATE project SET status=$1, completed_at=CASE WHEN $2 THEN now() ELSE completed_at END, cancelled_at=CASE WHEN $3 THEN now() ELSE cancelled_at END, updated_by_user_id=$4, version=version+1 WHERE id=$5 AND workspace_id=$6 AND version=$7 RETURNING id`, [next, completed, cancelled, context.userId, projectId, workspaceId, input.expectedVersion]);
    requireUpdatedRow(update.rows[0]);
    const row = await projectById(client, workspaceId, projectId); if (!row) throw new Error("Transitioned project was not found"); const response = projectResponse(row);
    const auditAction = { start: "PROJECT_STARTED", pause: "PROJECT_PAUSED", resume: "PROJECT_RESUMED", complete: "PROJECT_COMPLETED", cancel: "PROJECT_CANCELLED" }[action];
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId, action: auditAction, resourceType: "project", resourceId: projectId, beforeSummary: { status: current.status }, afterSummary: { status: next }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" });
    await recordIdempotent(client, context, scope, idempotencyKey, idempotencyInput, projectId, response); await client.query("COMMIT"); return response;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
