import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";

const optionalTypes = new Set(["AI_BUSINESS_DATA", "MODEL_IMPROVEMENT", "PERSONALIZATION", "MARKETING"]);
type Context = { userId: string; requestId: string; traceId: string; sessionId?: string };

async function workspaceId(pool: Pool, userId: string): Promise<string> { const r = await pool.query<{ id: string }>("SELECT id FROM workspace WHERE owner_user_id = $1", [userId]); if (!r.rows[0]) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。"); return r.rows[0].id; }
function checkType(type: string): void { if (!optionalTypes.has(type)) throw new ApiError(422, "CONSENT_REQUIRED", "该授权项不可通过此接口变更。"); }

export async function listConsents(context: Context, pool: Pool) { const id = await workspaceId(pool, context.userId); return (await pool.query("SELECT id, consent_type, status, policy_version, purpose_version, granted_at, revoked_at, version FROM consent WHERE workspace_id = $1 ORDER BY consent_type", [id])).rows; }

export async function grantConsent(type: string, input: { policyVersion: string; purposeVersion: string; expectedVersion?: number }, context: Context, pool: Pool) {
  checkType(type); if (!input.policyVersion || !input.purposeVersion || input.policyVersion.length > 32 || input.purposeVersion.length > 32) throw new ApiError(422, "VALIDATION_FAILED", "政策和用途版本不能为空且不得超过 32 个字符。");
  const workspace = await workspaceId(pool, context.userId); const client = await pool.connect(); try { await client.query("BEGIN");
    const existing = await client.query<{ version: number }>("SELECT version FROM consent WHERE workspace_id = $1 AND consent_type = $2 FOR UPDATE", [workspace, type]);
    let row; if (!existing.rows[0]) row = await client.query("INSERT INTO consent (id, workspace_id, consent_type, policy_version, purpose_version, granted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [randomUUID(), workspace, type, input.policyVersion, input.purposeVersion, context.userId]);
    else { if (input.expectedVersion === undefined || input.expectedVersion !== existing.rows[0].version) throw new ApiError(409, "RESOURCE_VERSION_CONFLICT", "数据已被更新，请刷新后重试。"); row = await client.query("UPDATE consent SET status='GRANTED', policy_version=$1, purpose_version=$2, granted_at=now(), revoked_at=NULL, granted_by_user_id=$3, revoked_by_user_id=NULL, version=version+1 WHERE workspace_id=$4 AND consent_type=$5 AND version=$6 RETURNING *", [input.policyVersion, input.purposeVersion, context.userId, workspace, type, input.expectedVersion]); }
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "CONSENT_GRANTED", resourceType: "consent", resourceId: row.rows[0]?.id, afterSummary: { type, status: "GRANTED" }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" }); await client.query("COMMIT"); return row.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function revokeConsent(type: string, expectedVersion: number, context: Context, pool: Pool) {
  checkType(type); if (!context.sessionId) throw new ApiError(401, "UNAUTHENTICATED", "请先登录。"); const workspace = await workspaceId(pool, context.userId); const client = await pool.connect(); try { await client.query("BEGIN");
    const reauth = await client.query<{ last_authenticated_at: Date | null }>("SELECT last_authenticated_at FROM session WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE", [context.sessionId, context.userId]); if (!reauth.rows[0]?.last_authenticated_at || reauth.rows[0].last_authenticated_at.getTime() + 900_000 <= Date.now()) throw new ApiError(422, "REAUTH_REQUIRED", "该操作需要在当前会话中重新验证身份。");
    const row = await client.query("UPDATE consent SET status='REVOKED', revoked_at=now(), revoked_by_user_id=$1, version=version+1 WHERE workspace_id=$2 AND consent_type=$3 AND version=$4 AND status='GRANTED' RETURNING *", [context.userId, workspace, type, expectedVersion]); if (!row.rows[0]) throw new ApiError(409, "RESOURCE_VERSION_CONFLICT", "数据已被更新，请刷新后重试。");
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: context.userId, workspaceId: workspace, action: "CONSENT_REVOKED", resourceType: "consent", resourceId: row.rows[0].id, afterSummary: { type, status: "REVOKED" }, requestId: context.requestId, traceId: context.traceId, result: "SUCCESS" }); await client.query("COMMIT"); return row.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
