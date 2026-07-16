import type { Pool } from "pg";
import { ApiError } from "../platform/errors.js";

export interface DashboardDeps {
  pool: Pool;
}

type Context = {
  userId: string;
};

type ActiveTaskRow = {
  id: string;
  project_id: string;
  title: string;
  status: "DRAFT" | "CONFIRMED" | "IN_PROGRESS";
  due_at: Date | null;
  is_deferred: boolean;
};

type DailySuggestionRow = { id: string; ai_run_id: string; status: "GENERATED" | "WAITING_CONFIRMATION" | "CONFIRMED"; proposed_payload: { items?: { taskId: string; rank: number; reason: string }[] }; version: number; created_at: Date; updated_at: Date; confirmed_at: Date | null };

function dateOnly(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new ApiError(422, "VALIDATION_FAILED", "date 必须为有效日期。");
  }
  return value;
}

export async function getDailyTop3(input: { date?: string }, context: Context, deps: DashboardDeps) {
  const date = dateOnly(input.date);
  const workspace = await deps.pool.query<{ id: string }>("SELECT id FROM workspace WHERE owner_user_id=$1", [context.userId]);
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");

  const suggestion = await deps.pool.query<DailySuggestionRow>(`SELECT s.id,s.ai_run_id,s.status,s.proposed_payload,s.version,s.created_at,s.updated_at,s.confirmed_at
    FROM ai_suggestion s
    JOIN ai_run r ON r.id=s.ai_run_id AND r.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1
      AND s.suggestion_type='DAILY_TOP3'
      AND s.status IN ('GENERATED','WAITING_CONFIRMATION','CONFIRMED')
      AND (r.created_at AT TIME ZONE 'UTC')::date=$2::date
    ORDER BY s.created_at DESC,s.id DESC
    LIMIT 1`, [workspaceId, date]);
  const current = suggestion.rows[0];
  const proposedItems = current?.proposed_payload.items;
  if (current && Array.isArray(proposedItems) && proposedItems.length >= 1 && proposedItems.length <= 3 && proposedItems.every((item, index) => typeof item?.taskId === "string" && item.rank === index + 1 && typeof item.reason === "string")) {
    const tasksById = await deps.pool.query<ActiveTaskRow>(`SELECT t.id,t.project_id,t.title,t.status,t.due_at,t.is_deferred
      FROM task t JOIN project p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1 AND t.id=ANY($2::uuid[]) AND t.status IN ('DRAFT','CONFIRMED','IN_PROGRESS') AND p.status IN ('DRAFT','IN_PROGRESS','PAUSED')`, [workspaceId, proposedItems.map((item) => item.taskId)]);
    const taskById = new Map(tasksById.rows.map((task) => [task.id, task]));
    if (taskById.size === proposedItems.length) {
      return { date, source: "AI_DAILY_TOP3" as const, suggestion: { id: current.id, runId: current.ai_run_id, status: current.status, version: current.version, createdAt: current.created_at.toISOString(), updatedAt: current.updated_at.toISOString(), confirmedAt: current.confirmed_at?.toISOString() ?? null }, items: proposedItems.map((item) => {
        const task = taskById.get(item.taskId)!;
        return { taskId: task.id, projectId: task.project_id, title: task.title, status: task.status, dueAt: task.due_at?.toISOString() ?? null, isDeferred: task.is_deferred, rank: item.rank, reason: item.reason };
      }) };
    }
  }

  const tasks = await deps.pool.query<ActiveTaskRow>(`SELECT t.id, t.project_id, t.title, t.status, t.due_at, t.is_deferred
    FROM task t
    JOIN project p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id=$1
      AND t.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
      AND p.status IN ('DRAFT', 'IN_PROGRESS', 'PAUSED')
    ORDER BY
      CASE WHEN t.due_at IS NOT NULL AND t.due_at < now() THEN 0 ELSE 1 END,
      CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
      t.due_at ASC NULLS LAST,
      CASE t.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'CONFIRMED' THEN 1 ELSE 2 END,
      t.is_deferred ASC,
      t.created_at ASC,
      t.id ASC
    LIMIT 3`, [workspaceId]);

  return {
    date,
    source: "FALLBACK_ACTIVE_TASKS" as const,
    items: tasks.rows.map((task, index) => ({
      taskId: task.id,
      projectId: task.project_id,
      title: task.title,
      status: task.status,
      dueAt: task.due_at?.toISOString() ?? null,
      isDeferred: task.is_deferred,
      rank: index + 1
    }))
  };
}
