import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AiProviderAdapter } from "./provider.js";
import { buildAiContext, type AiContextInput } from "./context.js";
import { recordIdempotent, replayIdempotent } from "../platform/concurrency.js";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";
import { parseProposal, persistProposal, type Proposal } from "./proposal.js";

type Context = { userId: string; requestId: string; traceId: string };
type RunStatus = "PROCESSING" | "WAITING_FOR_INPUT" | "GENERATED" | "DEGRADED" | "TIMED_OUT" | "FAILED";
type RunRow = { id: string; workspace_id: string; trace_id: string; capability: "TASK_BREAKDOWN" | "DAILY_TOP3"; status: RunStatus; provider_key: string; model_version: string; prompt_version: string; input_summary: unknown; output_summary: unknown; data_categories: unknown; consent_evidence: unknown; input_redaction_method: unknown; input_token_count: number; output_token_count: number; estimated_cost_micros: number; error_code: string | null; failure_detail_safe: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null };

export interface AiRunDeps { pool: Pool; provider: Pick<AiProviderAdapter, "generate">; model: string; providerKey: string; promptVersion: string; }

export const DAILY_TOP3_DAILY_QUOTA = 3;

function summary(row: RunRow) {
  return { id: row.id, traceId: row.trace_id, capability: row.capability, status: row.status, providerKey: row.provider_key, modelVersion: row.model_version, promptVersion: row.prompt_version, inputSummary: row.input_summary, outputSummary: row.output_summary, dataCategories: row.data_categories, consentEvidence: row.consent_evidence, inputRedactionMethod: row.input_redaction_method, inputTokens: row.input_token_count, outputTokens: row.output_token_count, estimatedCostMicros: row.estimated_cost_micros, errorCode: row.error_code, createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null };
}

async function workspaceId(pool: Pool | PoolClient, userId: string): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM workspace WHERE owner_user_id=$1", [userId]);
  const id = result.rows[0]?.id;
  if (!id) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");
  return id;
}

async function runById(pool: Pool | PoolClient, workspaceId: string, runId: string): Promise<RunRow | undefined> {
  return (await pool.query<RunRow>("SELECT * FROM ai_run WHERE id=$1 AND workspace_id=$2", [runId, workspaceId])).rows[0];
}

function secondsUntilNextUtcDay(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1_000));
}

async function consumeDailyTop3Quota(client: PoolClient, workspaceId: string): Promise<void> {
  const usage = await client.query("INSERT INTO ai_usage_daily (workspace_id,usage_date,capability,request_count) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,'DAILY_TOP3',1) ON CONFLICT (workspace_id,usage_date,capability) DO UPDATE SET request_count=ai_usage_daily.request_count+1 WHERE ai_usage_daily.request_count < $2 RETURNING request_count", [workspaceId, DAILY_TOP3_DAILY_QUOTA]);
  if (!usage.rows[0]) throw new ApiError(429, "AI_QUOTA_CAPABILITY_EXHAUSTED", "今日每日三件事 AI 建议配额已用完。", [{ retryAfterSeconds: secondsUntilNextUtcDay() }]);
}

async function recordDailyTop3Outcome(pool: Pool, workspaceId: string, outcome: { success: boolean; inputTokens: number; outputTokens: number }): Promise<void> {
  await pool.query("UPDATE ai_usage_daily SET success_count=success_count+$1,failure_count=failure_count+$2,input_tokens=input_tokens+$3,output_tokens=output_tokens+$4 WHERE workspace_id=$5 AND usage_date=(now() AT TIME ZONE 'UTC')::date AND capability='DAILY_TOP3'", [outcome.success ? 1 : 0, outcome.success ? 0 : 1, outcome.inputTokens, outcome.outputTokens, workspaceId]);
}

export async function createAiRun(input: AiContextInput, key: string, context: Context, deps: AiRunDeps) {
  const idempotencyInput = { capability: input.capability, projectId: input.projectId ?? null, instruction: input.instruction ?? "" };
  const client = await deps.pool.connect();
  let run: RunRow | undefined;
  let snapshot: Awaited<ReturnType<typeof buildAiContext>>;
  try {
    await client.query("BEGIN");
    const replay = await replayIdempotent<{ run: ReturnType<typeof summary> }>(client, context, "ai.run.create", key, idempotencyInput);
    if (replay) { await client.query("COMMIT"); return replay.run; }
    snapshot = await buildAiContext(input, context, client);
    const workspace = await workspaceId(client, context.userId);
    if (input.capability === "DAILY_TOP3") await consumeDailyTop3Quota(client, workspace);
    const id = randomUUID();
    await client.query(`INSERT INTO ai_run (id,workspace_id,requested_by_user_id,trace_id,capability,status,provider_key,model_version,prompt_version,input_summary,data_categories,consent_evidence,input_redaction_method,started_at)
      VALUES ($1,$2,$3,$4,$5,'PROCESSING',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,now())`, [id, workspace, context.userId, context.traceId, input.capability, deps.providerKey, deps.model, deps.promptVersion, JSON.stringify({ messageCount: snapshot.messages.length, instructionProvided: input.instruction !== undefined }), JSON.stringify(snapshot.dataCategories), JSON.stringify(snapshot.consentEvidence), JSON.stringify(snapshot.inputRedactionMethod)]);
    const stored = await runById(client, workspace, id);
    if (!stored) throw new Error("AI run was not persisted");
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "AI_RUN_CREATED", resourceType: "ai_run", resourceId: id, afterSummary: { status: "PROCESSING", capability: input.capability }, requestId: context.requestId, traceId: context.traceId, aiRunId: id, result: "SUCCESS" });
    await recordIdempotent(client, context, "ai.run.create", key, idempotencyInput, id, { run: summary(stored) });
    await client.query("COMMIT");
    run = stored;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  try {
    let output = await deps.provider.generate({ model: deps.model, messages: snapshot.messages });
    let proposal = parseProposal(output.content, input.capability);
    if (!proposal) { output = await deps.provider.generate({ model: deps.model, messages: snapshot.messages }); proposal = parseProposal(output.content, input.capability); }
    const finalProposal: Proposal = proposal ?? { kind: "NATURAL_LANGUAGE_FALLBACK", payload: { message: "AI 返回的结构化建议无效，请手动创建或调整任务。" } };
    const nextStatus: RunStatus = finalProposal.kind === "CLARIFYING_QUESTION" ? "WAITING_FOR_INPUT" : finalProposal.kind === "NATURAL_LANGUAGE_FALLBACK" ? "DEGRADED" : "GENERATED";
    if (!run) throw new Error("AI run was not persisted");
    const suggestionId = await persistProposal(deps.pool, { runId: run.id, workspaceId: run.workspace_id, projectId: input.projectId, proposal: finalProposal });
    const updated = await deps.pool.query<RunRow>("UPDATE ai_run SET status=$1,model_version=$2,output_summary=$3::jsonb,input_token_count=$4,output_token_count=$5,finished_at=now() WHERE id=$6 AND workspace_id=$7 RETURNING *", [nextStatus, output.modelVersion, JSON.stringify({ suggestionId, suggestionType: finalProposal.kind, structured: finalProposal.kind === "TASK_PLAN" }), output.inputTokens, output.outputTokens, run.id, run.workspace_id]);
    if (!updated.rows[0]) throw new Error("AI run completion was not persisted");
    if (input.capability === "DAILY_TOP3") await recordDailyTop3Outcome(deps.pool, run.workspace_id, { success: true, inputTokens: output.inputTokens, outputTokens: output.outputTokens });
    return summary(updated.rows[0]);
  } catch (error) {
    if (!run) throw error;
    const code = error instanceof ApiError ? error.code : "AI_PROVIDER_UNAVAILABLE";
    const status: RunStatus = code === "AI_TIMEOUT" ? "TIMED_OUT" : "FAILED";
    const updated = await deps.pool.query<RunRow>("UPDATE ai_run SET status=$1,error_code=$2,failure_detail_safe=$3,finished_at=now() WHERE id=$4 AND workspace_id=$5 RETURNING *", [status, code, "AI 服务未能完成本次请求。", run.id, run.workspace_id]);
    if (!updated.rows[0]) throw new Error("AI run failure was not persisted");
    if (input.capability === "DAILY_TOP3") await recordDailyTop3Outcome(deps.pool, run.workspace_id, { success: false, inputTokens: 0, outputTokens: 0 });
    return summary(updated.rows[0]);
  }
}

export async function getAiRun(runId: string, context: Context, deps: Pick<AiRunDeps, "pool">) {
  const workspace = await workspaceId(deps.pool, context.userId); const run = await runById(deps.pool, workspace, runId);
  if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该 AI 运行。");
  return summary(run);
}

export function aiRunEvents(run: ReturnType<typeof summary>, lastEventId?: string) {
  const terminalEvent = run.status === "GENERATED" ? "run.completed" : run.status === "DEGRADED" ? "run.degraded" : run.status === "WAITING_FOR_INPUT" ? "clarification.required" : "run.failed";
  const events = [
    { id: "1", event: "run.created", data: { runId: run.id, traceId: run.traceId, status: "PROCESSING" } },
    { id: "2", event: "run.progress", data: { runId: run.id, phase: "MODEL_CALL" } },
    { id: "4", event: terminalEvent, data: { runId: run.id, status: run.status, ...(run.errorCode ? { errorCode: run.errorCode } : {}) } }
  ];
  const last = lastEventId === undefined ? 0 : Number(lastEventId);
  if (!Number.isInteger(last) || last < 0 || last > 4) throw new ApiError(422, "VALIDATION_FAILED", "Last-Event-ID 无效。");
  return events.filter((event) => Number(event.id) > last);
}
