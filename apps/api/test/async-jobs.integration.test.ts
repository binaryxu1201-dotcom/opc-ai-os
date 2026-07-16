import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace } from "../src/workspace/service.js";
import { getAsyncJobSummary, listAsyncJobs } from "../src/platform/async-jobs.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const rateLimiter = new RedisSlidingWindowRateLimiter(redis);
afterAll(async () => { redis.disconnect(); await pool.end(); });

async function fixture(suffix: string) {
  const user = await registerUser({ email: `test-async-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-async-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter });
  const context = { userId: user.id, requestId: randomUUID(), traceId: randomUUID() };
  const workspace = await createWorkspace({ name: `Async ${suffix}` }, context, { pool });
  return { userId: user.id, workspace, context };
}

async function cleanup(userId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM async_job WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM ai_run WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]);
    await client.query("DELETE FROM session WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM credential WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM app_user WHERE id=$1", [userId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

describe("async job observability integration", () => {
  it("returns only workspace-scoped jobs and exposes only safe dead-letter summaries", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); userIds.push(first.userId, second.userId);
      const firstRun = randomUUID(); const secondRun = randomUUID();
      await pool.query("INSERT INTO ai_run (id,workspace_id,requested_by_user_id,trace_id,capability,status,provider_key,model_version,prompt_version) VALUES ($1,$2,$3,$4,'DAILY_TOP3','FAILED','test','test','test'),($5,$6,$7,$8,'DAILY_TOP3','FAILED','test','test','test')", [firstRun, first.workspace.id, first.userId, randomUUID(), secondRun, second.workspace.id, second.userId, randomUUID()]);
      await pool.query("INSERT INTO async_job (id,job_type,status,resource_type,resource_id,workspace_id,idempotency_key,failure_code,failure_detail_safe) VALUES ($1,'AI_RETRY','DEAD_LETTER','ai_run',$2,$3,$4,'AI_PROVIDER_UNAVAILABLE','Provider request failed safely.')", [randomUUID(), firstRun, first.workspace.id, `async-first-${suffix}`]);
      await pool.query("INSERT INTO async_job (id,job_type,status,resource_type,resource_id,workspace_id,idempotency_key) VALUES ($1,'AI_RETRY','QUEUED','ai_run',$2,$3,$4)", [randomUUID(), secondRun, second.workspace.id, `async-second-${suffix}`]);
      const jobs = await listAsyncJobs({ status: ["DEAD_LETTER"] }, first.context, pool);
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ status: "DEAD_LETTER", failure: { code: "AI_PROVIDER_UNAVAILABLE", summary: "Provider request failed safely." } });
      expect(await getAsyncJobSummary(first.context, pool)).toMatchObject({ deadLetter: 1, queued: 0 }); expect(await getAsyncJobSummary(second.context, pool)).toMatchObject({ deadLetter: 0, queued: 1 });
    } finally { for (const userId of userIds) await cleanup(userId); }
  });

  it("reserves a null workspace scope exclusively for system audit-partition maintenance jobs", async () => {
    const suffix = randomUUID(); const id = randomUUID();
    try {
      await pool.query("INSERT INTO async_job (id,job_type,status,resource_type,resource_id,workspace_id,idempotency_key) VALUES ($1,'AUDIT_PARTITION_MAINTAIN','QUEUED','system',$2,NULL,$3)", [id, randomUUID(), `audit-partition-${suffix}`]);
      await expect(pool.query("INSERT INTO async_job (id,job_type,status,resource_type,resource_id,workspace_id,idempotency_key) VALUES ($1,'AI_RETRY','QUEUED','ai_run',$2,NULL,$3)", [randomUUID(), randomUUID(), `invalid-system-scope-${suffix}`])).rejects.toMatchObject({ code: "23503" });
    } finally { await pool.query("DELETE FROM async_job WHERE id=$1", [id]); }
  });
});
