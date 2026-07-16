import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendAuditEvent } from "../platform/audit.js";
import type { ExportStorage } from "./storage.js";

export async function enqueueExpiredExportCleanup(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM export_job WHERE status IN ('READY','DOWNLOADED') AND expires_at<=now() FOR UPDATE SKIP LOCKED");
    for (const row of expired.rows) await client.query("INSERT INTO async_job (id,job_type,status,resource_type,resource_id,workspace_id,idempotency_key) VALUES ($1,'EXPORT_CLEANUP','QUEUED','export_job',$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING", [randomUUID(), row.id, row.workspace_id, `export-cleanup:${row.id}`]);
    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function cleanupExpiredExport(id: string, pool: Pool, storage: ExportStorage): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ workspace_id: string; status: string; object_key: string | null; expires_at: Date | null }>("SELECT workspace_id,status,object_key,expires_at FROM export_job WHERE id=$1 FOR UPDATE", [id]);
    const job = found.rows[0];
    if (!job || job.status === "EXPIRED") { await client.query("COMMIT"); return; }
    if (!job.expires_at || job.expires_at > new Date() || !["READY", "DOWNLOADED"].includes(job.status)) throw new Error("Export is not eligible for cleanup.");
    await client.query("COMMIT");
    if (job.object_key) await storage.remove(job.object_key);
    await client.query("BEGIN");
    const updated = await client.query("UPDATE export_job SET status='EXPIRED',object_key=NULL,version=version+1 WHERE id=$1 AND status IN ('READY','DOWNLOADED')", [id]);
    if (updated.rowCount) {
      await client.query("UPDATE export_download_token SET revoked_at=COALESCE(revoked_at,now()) WHERE export_job_id=$1 AND consumed_at IS NULL", [id]);
      await client.query("UPDATE async_job SET status='SUCCEEDED',finished_at=now() WHERE resource_id=$1 AND job_type='EXPORT_CLEANUP'", [id]);
      await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "WORKER", workspaceId: job.workspace_id, action: "EXPORT_EXPIRED", resourceType: "EXPORT_JOB", resourceId: id, afterSummary: { status: "EXPIRED" }, result: "SUCCESS" });
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
