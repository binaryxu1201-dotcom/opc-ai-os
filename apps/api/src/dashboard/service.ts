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
