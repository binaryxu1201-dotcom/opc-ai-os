import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { login, reauthenticate } from "../src/auth/session.js";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace } from "../src/workspace/service.js";
import { requestDeactivation, revokeDeactivation } from "../src/deactivation/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { buildApp } from "../src/app.js";

const environment = loadEnvironment(); const pool = new Pool({ connectionString: environment.DATABASE_URL }); const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 }); const rateLimiter = new RedisSlidingWindowRateLimiter(redis);
afterAll(async () => { redis.disconnect(); await pool.end(); });
function sessionId(token: string): string { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).sid; }
async function cleanup(userId: string) { const client = await pool.connect(); try { await client.query("BEGIN"); await client.query("DELETE FROM async_job WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM deactivation_request WHERE user_id=$1", [userId]); await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]); await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]); await client.query("DELETE FROM session WHERE user_id=$1", [userId]); await client.query("DELETE FROM credential WHERE user_id=$1", [userId]); await client.query("DELETE FROM app_user WHERE id=$1", [userId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); } }

describe("deactivation integration", () => {
  it("requires current-session reauthentication, freezes the workspace, revokes other sessions, and restores only from GRACE", async () => {
    const suffix = randomUUID(); let userId: string | undefined;
    try {
      const user = await registerUser({ email: `test-deactivation-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-deactivation-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter }); userId = user.id;
      const first = await login(`test-deactivation-${suffix}@example.test`, "correct-horse-battery-staple", `ip-a-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter, environment }); const second = await login(`test-deactivation-${suffix}@example.test`, "correct-horse-battery-staple", `ip-b-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter, environment }); const firstSessionId = sessionId(first.accessToken); const secondSessionId = sessionId(second.accessToken);
      const context = { userId, sessionId: firstSessionId, requestId: randomUUID(), traceId: randomUUID() }; await createWorkspace({ name: `Deactivate ${suffix}` }, context, { pool });
      await expect(requestDeactivation({}, `deactivation-request-${suffix}`, context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "REAUTH_REQUIRED" });
      await reauthenticate(userId, secondSessionId, "correct-horse-battery-staple", randomUUID(), randomUUID(), { pool, rateLimiter, environment }); await expect(requestDeactivation({}, `deactivation-wrong-session-${suffix}`, context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "REAUTH_REQUIRED" });
      await reauthenticate(userId, firstSessionId, "correct-horse-battery-staple", randomUUID(), randomUUID(), { pool, rateLimiter, environment }); const requested = await requestDeactivation({ reason: "Close account" }, `deactivation-request-${suffix}`, context, { pool }); expect(requested.status).toBe("GRACE"); expect(await requestDeactivation({ reason: "Close account" }, `deactivation-request-${suffix}`, context, { pool })).toEqual(requested);
      expect((await pool.query("SELECT status FROM app_user WHERE id=$1", [userId])).rows[0]).toEqual({ status: "DEACTIVATION_GRACE" }); expect((await pool.query("SELECT status FROM workspace WHERE owner_user_id=$1", [userId])).rows[0]).toEqual({ status: "READ_ONLY" }); expect((await pool.query("SELECT revoked_at FROM session WHERE id=$1", [secondSessionId])).rows[0]?.revoked_at).toBeTruthy();
      const app = buildApp(environment, { checkDatabase: async () => true, checkRedis: async () => true }, { pool, rateLimiter }); try { const blocked = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${first.accessToken}`, origin: environment.WEB_ORIGIN, "x-opc-csrf": "1", "idempotency-key": `deactivation-blocked-${suffix}` }, payload: { name: "Blocked", objective: "Must not write" } }); expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe("WORKSPACE_READ_ONLY"); } finally { await app.close(); }
      const revoked = await revokeDeactivation(requested.version, `deactivation-revoke-${suffix}`, context, { pool }); expect(revoked.status).toBe("REVOKED"); expect((await pool.query("SELECT status FROM app_user WHERE id=$1", [userId])).rows[0]).toEqual({ status: "ACTIVE" }); expect((await pool.query("SELECT status FROM workspace WHERE owner_user_id=$1", [userId])).rows[0]).toEqual({ status: "ACTIVE" }); expect((await pool.query("SELECT status FROM async_job WHERE resource_id=$1", [requested.id])).rows[0]).toEqual({ status: "CANCELLED" });
    } finally { if (userId) await cleanup(userId); }
  });
});
