import type { Pool, PoolClient } from "pg";

export interface AuditEventInput {
  eventId: string;
  occurredAt: Date;
  actorType: "USER" | "ADMIN" | "WORKER" | "SYSTEM";
  actorId?: string;
  workspaceId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeSummary?: Record<string, unknown>;
  afterSummary?: Record<string, unknown>;
  summaryTruncated?: boolean;
  traceId?: string;
  requestId?: string;
  aiRunId?: string;
  result: "SUCCESS" | "DENIED" | "FAILED";
  failureCode?: string;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function appendAuditEvent(connection: Queryable, event: AuditEventInput): Promise<void> {
  await connection.query(
    `SELECT append_audit_event(
      $1::uuid, $2::timestamptz, $3::text, $4::uuid, $5::uuid, $6::varchar, $7::varchar,
      $8::uuid, $9::jsonb, $10::jsonb, $11::boolean, $12::uuid, $13::uuid, $14::uuid, $15::text, $16::varchar
    )`,
    [
      event.eventId,
      event.occurredAt,
      event.actorType,
      event.actorId ?? null,
      event.workspaceId ?? null,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      event.beforeSummary ?? {},
      event.afterSummary ?? {},
      event.summaryTruncated ?? false,
      event.traceId ?? null,
      event.requestId ?? null,
      event.aiRunId ?? null,
      event.result,
      event.failureCode ?? null
    ]
  );
}
