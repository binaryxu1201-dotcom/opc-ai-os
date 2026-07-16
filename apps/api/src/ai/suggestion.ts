import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendAuditEvent } from "../platform/audit.js";
import { recordIdempotent, replayIdempotent, requireUpdatedRow, validateExpectedVersion } from "../platform/concurrency.js";
import { ApiError } from "../platform/errors.js";
import type { DailyTop3Item, TaskPlanItem } from "./proposal.js";

type Context = { userId: string; requestId: string; traceId: string };
type SuggestionStatus = "GENERATED" | "WAITING_CONFIRMATION" | "CONFIRMED" | "REJECTED" | "EXPIRED" | "EXECUTION_FAILED";
type SuggestionRow = { id: string; ai_run_id: string; workspace_id: string; suggestion_type: string; status: SuggestionStatus; proposed_payload: { items?: TaskPlanItem[] | DailyTop3Item[] }; target_project_id: string | null; version: number; created_at: Date; updated_at: Date; confirmed_at: Date | null; rejected_at: Date | null };

type EditedItem = { itemKey: string; title?: string; description?: string | null; estimatedMinutes?: number | null; dueAt?: string | null };

function response(row: SuggestionRow, createdResources: readonly { id: string; type: "task" }[] = []) {
  return { id: row.id, runId: row.ai_run_id, type: row.suggestion_type, status: row.status, proposedPayload: row.proposed_payload, targetProjectId: row.target_project_id, version: row.version, createdResources, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), confirmedAt: row.confirmed_at?.toISOString() ?? null, rejectedAt: row.rejected_at?.toISOString() ?? null };
}

async function workspaceForWrite(connection: Pool | PoolClient, userId: string): Promise<string> {
  const workspace = await connection.query<{ id: string; status: string }>("SELECT id,status FROM workspace WHERE owner_user_id=$1", [userId]);
  const row = workspace.rows[0];
  if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");
  if (row.status !== "ACTIVE") throw new ApiError(403, "WORKSPACE_READ_ONLY", "当前工作空间为只读状态。");
  return row.id;
}

async function suggestionById(connection: Pool | PoolClient, workspaceId: string, suggestionId: string): Promise<SuggestionRow | undefined> {
  return (await connection.query<SuggestionRow>("SELECT * FROM ai_suggestion WHERE id=$1 AND workspace_id=$2", [suggestionId, workspaceId])).rows[0];
}

function taskPlan(suggestion: SuggestionRow): TaskPlanItem[] {
  const items = suggestion.proposed_payload.items;
  if (suggestion.suggestion_type !== "TASK_PLAN" || !suggestion.target_project_id || !Array.isArray(items) || !items.every(isTaskPlanItem)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "该建议不支持任务确认。");
  return items;
}

function isTaskPlanItem(item: TaskPlanItem | DailyTop3Item): item is TaskPlanItem {
  return "itemKey" in item && "title" in item && typeof item.itemKey === "string" && typeof item.title === "string";
}

function isDailyTop3Item(item: TaskPlanItem | DailyTop3Item): item is DailyTop3Item {
  return "taskId" in item && "rank" in item && "reason" in item && typeof item.taskId === "string" && Number.isInteger(item.rank) && typeof item.reason === "string";
}

function dailyTop3(suggestion: SuggestionRow): DailyTop3Item[] {
  const items = suggestion.proposed_payload.items;
  if (suggestion.suggestion_type !== "DAILY_TOP3" || !Array.isArray(items)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "该建议不支持每日三件事确认。");
  if (items.length < 1 || items.length > 3 || !items.every(isDailyTop3Item)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "每日三件事建议内容无效。");
  return items;
}

function normalizeItems(original: TaskPlanItem[], edited: EditedItem[] | undefined): TaskPlanItem[] {
  if (edited === undefined) return original;
  const originals = new Map(original.map((item) => [item.itemKey, item]));
  const selected: TaskPlanItem[] = [];
  const seen = new Set<string>();
  for (const item of edited) {
    const source = originals.get(item.itemKey);
    if (!source || seen.has(item.itemKey)) throw new ApiError(422, "VALIDATION_FAILED", "编辑项必须使用原建议中的唯一 itemKey。");
    seen.add(item.itemKey);
    const title = item.title === undefined ? source.title : item.title.trim();
    if (!title || title.length > 200) throw new ApiError(422, "VALIDATION_FAILED", "任务标题长度不符合要求。");
    const description = item.description === undefined ? source.description : item.description === null || item.description === "" ? null : item.description.trim();
    if (description !== null && description.length > 4_000) throw new ApiError(422, "VALIDATION_FAILED", "任务描述长度不符合要求。");
    const estimatedMinutes = item.estimatedMinutes === undefined ? source.estimatedMinutes : item.estimatedMinutes;
    if (estimatedMinutes !== null && (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 1)) throw new ApiError(422, "VALIDATION_FAILED", "预计分钟数必须为正整数。");
    const dueAt = item.dueAt === undefined ? source.dueAt : item.dueAt;
    if (dueAt !== null && (typeof dueAt !== "string" || Number.isNaN(new Date(dueAt).getTime()))) throw new ApiError(422, "VALIDATION_FAILED", "截止时间必须为有效 RFC 3339 时间。");
    selected.push({ itemKey: source.itemKey, title, description, estimatedMinutes, dueAt });
  }
  if (selected.length < 1) throw new ApiError(422, "VALIDATION_FAILED", "至少保留一个任务项。");
  return selected;
}

function transitionable(status: SuggestionStatus): void {
  if (status !== "GENERATED" && status !== "WAITING_CONFIRMATION") throw new ApiError(409, "INVALID_STATE_TRANSITION", "当前建议不可处理。");
}

export async function editSuggestion(suggestionId: string, input: { expectedVersion: number; items: EditedItem[] }, key: string, context: Context, pool: Pool) {
  validateExpectedVersion(input.expectedVersion); const client = await pool.connect(); const idempotencyInput = { suggestionId, ...input };
  try {
    await client.query("BEGIN"); const replay = await replayIdempotent<ReturnType<typeof response>>(client, context, "ai.suggestion.edit", key, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspace = await workspaceForWrite(client, context.userId); const current = await suggestionById(client, workspace, suggestionId); if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 建议。"); transitionable(current.status);
    const items = normalizeItems(taskPlan(current), input.items);
    const update = await client.query<SuggestionRow>("UPDATE ai_suggestion SET status='WAITING_CONFIRMATION',version=version+1 WHERE id=$1 AND workspace_id=$2 AND version=$3 RETURNING *", [suggestionId, workspace, input.expectedVersion]); const updated = requireUpdatedRow(update.rows[0]);
    await client.query("INSERT INTO ai_suggestion_decision (id,suggestion_id,decision,actor_user_id,edited_payload) VALUES ($1,$2,'EDITED',$3,$4::jsonb)", [randomUUID(), suggestionId, context.userId, JSON.stringify({ items })]);
    const value = response(updated); await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "AI_SUGGESTION_EDITED", resourceType: "ai_suggestion", resourceId: suggestionId, afterSummary: { status: updated.status, itemCount: items.length }, requestId: context.requestId, traceId: context.traceId, aiRunId: current.ai_run_id, result: "SUCCESS" }); await recordIdempotent(client, context, "ai.suggestion.edit", key, idempotencyInput, suggestionId, value); await client.query("COMMIT"); return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function confirmSuggestion(suggestionId: string, input: { expectedVersion: number; editedPayload?: { items: EditedItem[] } }, key: string, context: Context, pool: Pool) {
  validateExpectedVersion(input.expectedVersion); const client = await pool.connect(); const idempotencyInput = { suggestionId, ...input };
  try {
    await client.query("BEGIN"); const replay = await replayIdempotent<ReturnType<typeof response>>(client, context, "ai.suggestion.confirm", key, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspace = await workspaceForWrite(client, context.userId); const current = await suggestionById(client, workspace, suggestionId); if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 建议。"); transitionable(current.status); const projectId = current.target_project_id; const items = normalizeItems(taskPlan(current), input.editedPayload?.items);
    const project = await client.query<{ status: string }>("SELECT status FROM project WHERE id=$1 AND workspace_id=$2", [projectId, workspace]); if (!project.rows[0]) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该项目。"); if (["COMPLETED", "CANCELLED"].includes(project.rows[0].status)) throw new ApiError(409, "INVALID_STATE_TRANSITION", "终态项目不可创建任务。");
    const createdResources: { id: string; type: "task" }[] = [];
    for (const item of items) {
      const id = randomUUID(); await client.query("INSERT INTO task (id,workspace_id,project_id,depth,title,description,assignee_user_id,status,due_at,estimated_minutes,source,source_ai_suggestion_id,source_ai_item_key,created_by_user_id,updated_by_user_id) VALUES ($1,$2,$3,1,$4,$5,$6,'CONFIRMED',$7,$8,'AI_CONFIRMED',$9,$10,$6,$6)", [id, workspace, projectId, item.title, item.description, context.userId, item.dueAt, item.estimatedMinutes, suggestionId, item.itemKey]); createdResources.push({ id, type: "task" });
    }
    const update = await client.query<SuggestionRow>("UPDATE ai_suggestion SET status='CONFIRMED',confirmed_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2 AND version=$3 RETURNING *", [suggestionId, workspace, input.expectedVersion]); const updated = requireUpdatedRow(update.rows[0]);
    if (input.editedPayload) await client.query("INSERT INTO ai_suggestion_decision (id,suggestion_id,decision,actor_user_id,edited_payload) VALUES ($1,$2,'EDITED',$3,$4::jsonb)", [randomUUID(), suggestionId, context.userId, JSON.stringify({ items })]);
    await client.query("INSERT INTO ai_suggestion_decision (id,suggestion_id,decision,actor_user_id,edited_payload) VALUES ($1,$2,'CONFIRMED',$3,$4::jsonb)", [randomUUID(), suggestionId, context.userId, JSON.stringify({ items })]);
    const value = response(updated, createdResources); await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "AI_SUGGESTION_CONFIRMED", resourceType: "ai_suggestion", resourceId: suggestionId, afterSummary: { status: updated.status, taskCount: createdResources.length }, requestId: context.requestId, traceId: context.traceId, aiRunId: current.ai_run_id, result: "SUCCESS" }); await recordIdempotent(client, context, "ai.suggestion.confirm", key, idempotencyInput, suggestionId, value); await client.query("COMMIT"); return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function confirmDailyTop3Suggestion(suggestionId: string, input: { expectedVersion: number; items: { taskId: string; rank: number }[] }, key: string, context: Context, pool: Pool) {
  validateExpectedVersion(input.expectedVersion);
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 3) throw new ApiError(422, "VALIDATION_FAILED", "每日三件事确认必须保留 1 至 3 项。");
  const client = await pool.connect(); const idempotencyInput = { suggestionId, ...input };
  try {
    await client.query("BEGIN"); const replay = await replayIdempotent<ReturnType<typeof response>>(client, context, "dashboard.daily-top3.confirm", key, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspace = await workspaceForWrite(client, context.userId); const current = await suggestionById(client, workspace, suggestionId); if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 建议。"); transitionable(current.status);
    const original = dailyTop3(current); const originalByTaskId = new Map(original.map((item) => [item.taskId, item])); const seen = new Set<string>();
    const items: DailyTop3Item[] = input.items.map((item, index) => {
      const source = originalByTaskId.get(item.taskId);
      if (!source || seen.has(item.taskId) || item.rank !== index + 1) throw new ApiError(422, "VALIDATION_FAILED", "确认项必须是原建议的唯一连续排序子集。");
      seen.add(item.taskId); return { taskId: source.taskId, rank: index + 1, reason: source.reason };
    });
    const validTasks = await client.query<{ id: string }>("SELECT t.id FROM task t JOIN project p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.workspace_id=$1 AND t.id=ANY($2::uuid[]) AND t.status IN ('DRAFT','CONFIRMED','IN_PROGRESS') AND p.status IN ('DRAFT','IN_PROGRESS','PAUSED')", [workspace, items.map((item) => item.taskId)]);
    if (validTasks.rows.length !== items.length) throw new ApiError(409, "INVALID_STATE_TRANSITION", "建议中的任务已不适用于每日三件事确认。");
    const update = await client.query<SuggestionRow>("UPDATE ai_suggestion SET status='CONFIRMED',confirmed_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2 AND version=$3 RETURNING *", [suggestionId, workspace, input.expectedVersion]); const updated = requireUpdatedRow(update.rows[0]);
    await client.query("INSERT INTO ai_suggestion_decision (id,suggestion_id,decision,actor_user_id,edited_payload) VALUES ($1,$2,'CONFIRMED',$3,$4::jsonb)", [randomUUID(), suggestionId, context.userId, JSON.stringify({ items })]);
    const value = response(updated); await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "DAILY_TOP3_CONFIRMED", resourceType: "ai_suggestion", resourceId: suggestionId, afterSummary: { status: updated.status, itemCount: items.length }, requestId: context.requestId, traceId: context.traceId, aiRunId: current.ai_run_id, result: "SUCCESS" }); await recordIdempotent(client, context, "dashboard.daily-top3.confirm", key, idempotencyInput, suggestionId, value); await client.query("COMMIT"); return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function rejectSuggestion(suggestionId: string, input: { expectedVersion: number; reason?: string }, key: string, context: Context, pool: Pool) {
  validateExpectedVersion(input.expectedVersion); const reason = input.reason === undefined ? null : input.reason.trim(); if (reason !== null && reason.length > 500) throw new ApiError(422, "VALIDATION_FAILED", "拒绝原因不得超过 500 个字符。"); const client = await pool.connect(); const idempotencyInput = { suggestionId, expectedVersion: input.expectedVersion, reason };
  try {
    await client.query("BEGIN"); const replay = await replayIdempotent<ReturnType<typeof response>>(client, context, "ai.suggestion.reject", key, idempotencyInput); if (replay) { await client.query("COMMIT"); return replay; }
    const workspace = await workspaceForWrite(client, context.userId); const current = await suggestionById(client, workspace, suggestionId); if (!current) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 建议。"); transitionable(current.status);
    const update = await client.query<SuggestionRow>("UPDATE ai_suggestion SET status='REJECTED',rejected_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2 AND version=$3 RETURNING *", [suggestionId, workspace, input.expectedVersion]); const updated = requireUpdatedRow(update.rows[0]);
    await client.query("INSERT INTO ai_suggestion_decision (id,suggestion_id,decision,actor_user_id,reason) VALUES ($1,$2,'REJECTED',$3,$4)", [randomUUID(), suggestionId, context.userId, reason]); const value = response(updated); await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "AI_SUGGESTION_REJECTED", resourceType: "ai_suggestion", resourceId: suggestionId, afterSummary: { status: updated.status }, requestId: context.requestId, traceId: context.traceId, aiRunId: current.ai_run_id, result: "SUCCESS" }); await recordIdempotent(client, context, "ai.suggestion.reject", key, idempotencyInput, suggestionId, value); await client.query("COMMIT"); return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function getSuggestion(suggestionId: string, context: Context, pool: Pool) {
  const workspace = (await pool.query<{ id: string }>("SELECT id FROM workspace WHERE owner_user_id=$1", [context.userId])).rows[0]?.id;
  if (!workspace) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");
  const row = (await pool.query<SuggestionRow>("SELECT * FROM ai_suggestion WHERE id=$1 AND workspace_id=$2", [suggestionId, workspace])).rows[0];
  if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 建议。");
  return response(row);
}
