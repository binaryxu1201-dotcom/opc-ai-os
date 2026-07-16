import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { createProject } from "../src/project/service.js";
import { createTask } from "../src/task/service.js";
import { createCustomer } from "../src/customer/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { downloadExport, generateExport, getExport, issueDownloadToken, listExports, requestExport } from "../src/export/service.js";
import { cleanupExpiredExport, enqueueExpiredExportCleanup } from "../src/export/cleanup.js";
import type { ExportStorage } from "../src/export/storage.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);
afterAll(async () => { redis.disconnect(); await pool.end(); });

class MemoryStorage implements ExportStorage {
  private readonly objects = new Map<string, Buffer>();
  async put(key: string, content: Buffer): Promise<void> { this.objects.set(key, content); }
  async get(key: string): Promise<Buffer> { const object = this.objects.get(key); if (!object) throw new Error("missing object"); return object; }
  async remove(key: string): Promise<void> { this.objects.delete(key); }
}
const storage = new MemoryStorage();
async function fixture(suffix: string) { const base = { requestId: randomUUID(), traceId: randomUUID() }; const user = await registerUser({ email: `test-export-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-export-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter }); const workspace = await createWorkspace({ name: `Export ${suffix}` }, { ...base, userId: user.id }, { pool }); const context = { ...base, userId: user.id }; await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Validate secure exports", expectedVersion: 1 }, context, { pool }); return { userId: user.id, workspace, context }; }
async function cleanup(userIds: string[]) { for (const userId of userIds) { const client = await pool.connect(); try { await client.query("BEGIN"); await client.query("DELETE FROM export_download_token WHERE export_job_id IN (SELECT id FROM export_job WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1))", [userId]); await client.query("DELETE FROM async_job WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM export_job WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM task WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM customer WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]); await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]); await client.query("DELETE FROM session WHERE user_id=$1", [userId]); await client.query("DELETE FROM credential WHERE user_id=$1", [userId]); await client.query("DELETE FROM app_user WHERE id=$1", [userId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); } } }

describe("export integration", () => {
  it("creates a scoped CSV export, hashes a one-time token, and rejects replay or cross-workspace access", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); userIds.push(first.userId, second.userId); const deps = { pool, storage };
      const project = await createProject({ name: "=formula project", objective: "Export it" }, `export-project-${suffix}`, first.context, { pool });
      await createTask(project.id, { title: "+formula task", description: "Task data" }, `export-task-${suffix}`, first.context, { pool });
      await createCustomer({ name: "@formula customer", source: "Referral", intentLevel: "HIGH", notes: "Customer data" }, `export-customer-${suffix}`, first.context, { pool });
      const input = { format: "CSV" as const, scope: "CORE_BUSINESS_DATA" as const }; const requested = await requestExport(input, `export-request-${suffix}`, first.context, deps);
      expect(requested.status).toBe("QUEUED"); expect(await requestExport(input, `export-request-${suffix}`, first.context, deps)).toEqual(requested);
      expect((await pool.query("SELECT status FROM async_job WHERE resource_id=$1 AND job_type='EXPORT_GENERATE'", [requested.id])).rows[0]).toEqual({ status: "QUEUED" });
      await generateExport(requested.id, pool, storage); const ready = await getExport(requested.id, first.context, deps);
      expect(ready).toMatchObject({ status: "READY", sizeBytes: expect.any(Number), checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/), expiresAt: expect.any(String) });
      await expect(getExport(requested.id, second.context, deps)).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
      const issued = await issueDownloadToken(requested.id, ready.version, first.context, deps); expect(issued.downloadToken).toHaveLength(43); expect(JSON.stringify(ready)).not.toContain(issued.downloadToken);
      const savedToken = await pool.query<{ token_hash: string }>("SELECT token_hash FROM export_download_token WHERE export_job_id=$1", [requested.id]); expect(savedToken.rows[0]?.token_hash).not.toBe(issued.downloadToken);
      const downloaded = await downloadExport(requested.id, issued.downloadToken, first.context, deps); const csv = downloaded.content.toString("utf8"); expect(csv).toContain("'=formula project"); expect(csv).toContain("'+formula task"); expect(csv).toContain("'@formula customer"); expect(csv).not.toContain(second.workspace.id);
      await expect(downloadExport(requested.id, issued.downloadToken, first.context, deps)).rejects.toMatchObject({ statusCode: 409, code: "DOWNLOAD_TOKEN_CONSUMED" });
      expect((await getExport(requested.id, first.context, deps)).status).toBe("DOWNLOADED"); expect((await listExports(first.context, deps)).map((item) => item.id)).toContain(requested.id);
    } finally { await cleanup(userIds); }
  });

  it("queues expired exports, deletes their private object, revokes active tokens, and is idempotent", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`cleanup-${suffix}`); userIds.push(account.userId); const deps = { pool, storage }; const input = { format: "CSV" as const, scope: "CORE_BUSINESS_DATA" as const };
      const requested = await requestExport(input, `export-cleanup-request-${suffix}`, account.context, deps); await generateExport(requested.id, pool, storage); const ready = await getExport(requested.id, account.context, deps); const issued = await issueDownloadToken(requested.id, ready.version, account.context, deps);
      const key = (await pool.query<{ object_key: string }>("SELECT object_key FROM export_job WHERE id=$1", [requested.id])).rows[0]?.object_key; expect(key).toBeTruthy(); await pool.query("UPDATE export_job SET expires_at=now()-interval '1 second' WHERE id=$1", [requested.id]);
      expect(await enqueueExpiredExportCleanup(pool)).toBe(1); expect(await enqueueExpiredExportCleanup(pool)).toBe(1);
      expect((await pool.query("SELECT count(*)::int AS count FROM async_job WHERE resource_id=$1 AND job_type='EXPORT_CLEANUP'", [requested.id])).rows[0]).toEqual({ count: 1 });
      await cleanupExpiredExport(requested.id, pool, storage); await expect(storage.get(key!)).rejects.toThrow("missing object");
      expect((await getExport(requested.id, account.context, deps)).status).toBe("EXPIRED"); expect((await pool.query("SELECT revoked_at FROM export_download_token WHERE export_job_id=$1 AND token_hash<>$2", [requested.id, issued.downloadToken])).rows[0]?.revoked_at).toBeTruthy();
      await cleanupExpiredExport(requested.id, pool, storage); expect((await getExport(requested.id, account.context, deps)).status).toBe("EXPIRED");
    } finally { await cleanup(userIds); }
  });
});
