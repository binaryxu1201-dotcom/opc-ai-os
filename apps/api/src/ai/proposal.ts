import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type TaskPlanItem = { itemKey: string; title: string; description: string | null; estimatedMinutes: number | null; dueAt: string | null };
export type Proposal =
  | { kind: "TASK_PLAN"; payload: { items: TaskPlanItem[] } }
  | { kind: "CLARIFYING_QUESTION"; payload: { question: string } }
  | { kind: "NATURAL_LANGUAGE_FALLBACK"; payload: { message: string } };

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined;
}

function parseTaskPlan(value: unknown): Proposal | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { tasks?: unknown }).tasks)) return undefined;
  const tasks = (value as { tasks: unknown[] }).tasks;
  if (tasks.length < 1 || tasks.length > 50) return undefined;
  const items: TaskPlanItem[] = [];
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== "object") return undefined;
    const record = task as { title?: unknown; description?: unknown; estimatedMinutes?: unknown; dueAt?: unknown };
    const title = text(record.title, 200);
    const description = record.description === undefined ? null : text(record.description, 4_000);
    const estimatedMinutes = record.estimatedMinutes === undefined ? null : record.estimatedMinutes;
    const dueAt = record.dueAt === undefined ? null : record.dueAt;
    if (!title || (record.description !== undefined && !description) || (estimatedMinutes !== null && (typeof estimatedMinutes !== "number" || !Number.isInteger(estimatedMinutes) || estimatedMinutes < 1)) || (dueAt !== null && (typeof dueAt !== "string" || Number.isNaN(new Date(dueAt).getTime())))) return undefined;
    items.push({ itemKey: `item-${index + 1}`, title, description: description ?? null, estimatedMinutes: estimatedMinutes as number | null, dueAt: dueAt as string | null });
  }
  return { kind: "TASK_PLAN", payload: { items } };
}

export function parseProposal(content: string): Proposal | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    const clarification = parsed && typeof parsed === "object" ? text((parsed as { clarificationQuestion?: unknown }).clarificationQuestion, 1_000) : undefined;
    if (clarification) return { kind: "CLARIFYING_QUESTION", payload: { question: clarification } };
    return parseTaskPlan(parsed);
  } catch { return undefined; }
}

export async function persistProposal(pool: Pool, input: { runId: string; workspaceId: string; projectId: string | undefined; proposal: Proposal }): Promise<string> {
  const id = randomUUID();
  const status = input.proposal.kind === "NATURAL_LANGUAGE_FALLBACK" ? "GENERATED" : "GENERATED";
  await pool.query("INSERT INTO ai_suggestion (id,ai_run_id,workspace_id,suggestion_type,status,proposed_payload,schema_version,target_project_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'v1',$7)", [id, input.runId, input.workspaceId, input.proposal.kind, status, JSON.stringify(input.proposal.payload), input.proposal.kind === "TASK_PLAN" ? input.projectId ?? null : null]);
  return id;
}
