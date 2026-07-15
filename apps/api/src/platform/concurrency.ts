import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";

export interface WriteContext {
  userId: string;
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function validateExpectedVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(422, "VALIDATION_FAILED", "expectedVersion 无效。");
  }
}

export function requireUpdatedRow<T>(row: T | undefined): T {
  if (!row) {
    throw new ApiError(409, "RESOURCE_VERSION_CONFLICT", "数据已被更新，请刷新后重试。");
  }
  return row;
}

export async function replayIdempotent<T = never>(client: PoolClient, context: WriteContext, scope: string, key: string, input: unknown): Promise<T | undefined> {
  if (key.length < 16 || key.length > 128) {
    throw new ApiError(422, "VALIDATION_FAILED", "Idempotency-Key 长度必须为 16 到 128 个字符。");
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.userId}:${scope}:${key}`]);
  await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1 AND scope=$2 AND key=$3 AND expires_at <= now()", [context.userId, scope, key]);
  const existing = await client.query<{ request_hash: string; response_body_safe: T }>("SELECT request_hash,response_body_safe FROM idempotency_record WHERE actor_user_id=$1 AND scope=$2 AND key=$3", [context.userId, scope, key]);
  const record = existing.rows[0];
  if (!record) return undefined;
  if (record.request_hash !== requestHash(input)) {
    throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该幂等键已用于不同请求。");
  }
  return record.response_body_safe;
}

export async function recordIdempotent(client: PoolClient, context: WriteContext, scope: string, key: string, input: unknown, resourceId: string, response: unknown): Promise<void> {
  await client.query("INSERT INTO idempotency_record (actor_user_id,scope,key,request_hash,response_status,response_body_safe,resource_id,expires_at) VALUES ($1,$2,$3,$4,200,$5::jsonb,$6,now()+interval '24 hours')", [context.userId, scope, key, requestHash(input), JSON.stringify(response), resourceId]);
}
