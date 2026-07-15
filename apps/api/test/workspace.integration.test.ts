import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, getProfile, putProfile } from "../src/workspace/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });

afterAll(async () => { redis.disconnect(); await pool.end(); });

describe("workspace onboarding integration", () => {
  it("creates exactly one workspace with CORE_SERVICE and completes the profile", async () => {
    const suffix = randomUUID(); const context = { requestId: randomUUID(), traceId: randomUUID() }; const testIp = `test-workspace-${suffix}`; let userId: string | undefined;
    try {
      const user = await registerUser({ email: `test-workspace-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test-2026-07", privacyVersion: "test-2026-07" }, testIp, context.requestId, context.traceId, { pool, rateLimiter: new RedisSlidingWindowRateLimiter(redis) });
      userId = user.id; const workspace = await createWorkspace({ name: "Test workspace" }, { ...context, userId }, { pool });
      const consent = await pool.query<{ consent_type: string; status: string }>("SELECT consent_type, status FROM consent WHERE workspace_id = $1", [workspace?.id]);
      expect(consent.rows).toEqual([{ consent_type: "CORE_SERVICE", status: "GRANTED" }]);
      await expect(createWorkspace({ name: "Second" }, { ...context, userId }, { pool })).rejects.toMatchObject({ statusCode: 409, code: "WORKSPACE_ALREADY_EXISTS" });
      const profile = await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Build a resilient test business", expectedVersion: 1 }, { ...context, userId }, { pool });
      expect(profile.completed_at).toBeTruthy();
      expect((await getProfile({ ...context, userId }, { pool })).profile.completed_at).toBeTruthy();
    } finally {
      if (userId) { await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id = $1)", [userId]); await pool.query("DELETE FROM workspace WHERE owner_user_id = $1", [userId]); await pool.query("DELETE FROM credential WHERE user_id = $1", [userId]); await pool.query("DELETE FROM app_user WHERE id = $1", [userId]); }
    }
  });
});
