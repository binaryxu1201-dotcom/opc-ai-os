import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";

export interface WorkspaceDeps { pool: Pool; }
type Context = { userId: string; requestId: string; traceId: string };

async function currentWorkspace(pool: Pool, userId: string) {
  const result = await pool.query<{ id: string; name: string; description: string | null; status: string; version: number; created_at: Date; updated_at: Date }>("SELECT id, name, description, status, version, created_at, updated_at FROM workspace WHERE owner_user_id = $1", [userId]);
  return result.rows[0];
}

export async function createWorkspace(input: { name: string; description?: string }, context: Context, deps: WorkspaceDeps) {
  const name = input.name.trim(); if (!name || name.length > 80) throw new ApiError(422, "VALIDATION_FAILED", "工作空间名称长度必须为 1 到 80 个字符。");
  if (input.description && input.description.length > 500) throw new ApiError(422, "VALIDATION_FAILED", "工作空间简介不能超过 500 个字符。");
  const client = await deps.pool.connect(); try { await client.query("BEGIN"); const id = randomUUID(); const year = new Date().getUTCFullYear();
    await client.query("INSERT INTO workspace (id, owner_user_id, name, description, rename_year) VALUES ($1,$2,$3,$4,$5)", [id, context.userId, name, input.description?.trim() || null, year]);
    await client.query("INSERT INTO consent (id, workspace_id, consent_type, policy_version, purpose_version, granted_by_user_id) VALUES ($1,$2,'CORE_SERVICE','initial','initial',$3)", [randomUUID(), id, context.userId]);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: id, action: "WORKSPACE_CREATED", resourceType: "workspace", resourceId: id, afterSummary: { status: "ACTIVE" }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" }); await client.query("COMMIT");
    return currentWorkspace(deps.pool, context.userId);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); if ((error as { code?: string }).code === "23505") throw new ApiError(409, "WORKSPACE_ALREADY_EXISTS", "该账户已创建工作空间。"); throw error; } finally { client.release(); }
}

export async function getWorkspace(context: Context, deps: WorkspaceDeps) { const workspace = await currentWorkspace(deps.pool, context.userId); if (!workspace) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。"); return workspace; }

export async function getProfile(context: Context, deps: WorkspaceDeps) { const workspace = await getWorkspace(context, deps); const result = await deps.pool.query("SELECT workspace_id, skills, entrepreneur_stage, business_goal, completed_at, visibility_setting, version, created_at, updated_at FROM profile WHERE workspace_id = $1", [workspace.id]); return { workspace, profile: result.rows[0] ?? null }; }

export async function putProfile(input: { skills: string[]; entrepreneurStage: string; businessGoal: string; expectedVersion: number }, context: Context, deps: WorkspaceDeps) {
  if (!Array.isArray(input.skills) || input.skills.length > 20 || input.skills.some((skill) => !skill.trim())) throw new ApiError(422, "VALIDATION_FAILED", "技能必须为最多 20 项的非空列表。");
  if (!input.entrepreneurStage || input.entrepreneurStage.length > 32 || !input.businessGoal || input.businessGoal.length > 1000) throw new ApiError(422, "VALIDATION_FAILED", "创业阶段和经营目标不符合长度要求。");
  const workspace = await getWorkspace(context, deps); const client = await deps.pool.connect(); try { await client.query("BEGIN");
    const result = await client.query(`INSERT INTO profile (workspace_id, skills, entrepreneur_stage, business_goal, completed_at, version) VALUES ($1,$2::jsonb,$3,$4,now(),1) ON CONFLICT (workspace_id) DO UPDATE SET skills = EXCLUDED.skills, entrepreneur_stage = EXCLUDED.entrepreneur_stage, business_goal = EXCLUDED.business_goal, completed_at = now(), version = profile.version + 1 WHERE profile.version = $5 RETURNING *`, [workspace.id, JSON.stringify(input.skills.map((skill) => skill.trim())), input.entrepreneurStage, input.businessGoal, input.expectedVersion]);
    if (!result.rows[0]) throw new ApiError(409, "RESOURCE_VERSION_CONFLICT", "数据已被更新，请刷新后重试。");
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace.id, action: "PROFILE_UPDATED", resourceType: "profile", resourceId: workspace.id, afterSummary: { completed: true }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" }); await client.query("COMMIT"); return result.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
