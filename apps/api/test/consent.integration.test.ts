import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { login, reauthenticate } from "../src/auth/session.js";
import { createWorkspace } from "../src/workspace/service.js";
import { grantConsent, listConsents, revokeConsent } from "../src/workspace/consent.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment(); const pool = new Pool({ connectionString: environment.DATABASE_URL }); const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 }); const limiter = new RedisSlidingWindowRateLimiter(redis);
afterAll(async () => { redis.disconnect(); await pool.end(); });

describe("optional consent integration and workspace isolation", () => {
  it("grants, regrants and revokes only the authenticated workspace consent", async () => {
    const suffix = randomUUID(); const base = { requestId: randomUUID(), traceId: randomUUID() }; const password = "correct-horse-battery-staple"; const userIds: string[] = [];
    try {
      const first = await registerUser({ email: `test-consent-a-${suffix}@example.test`, password, termsVersion: "test", privacyVersion: "test" }, `test-consent-a-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter }); userIds.push(first.id);
      const second = await registerUser({ email: `test-consent-b-${suffix}@example.test`, password, termsVersion: "test", privacyVersion: "test" }, `test-consent-b-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter }); userIds.push(second.id);
      await createWorkspace({ name: "A" }, { ...base, userId: first.id }, { pool }); await createWorkspace({ name: "B" }, { ...base, userId: second.id }, { pool });
      const granted = await grantConsent("AI_BUSINESS_DATA", { policyVersion: "v1", purposeVersion: "v1" }, { ...base, userId: first.id }, pool);
      expect(granted.status).toBe("GRANTED"); expect((await listConsents({ ...base, userId: second.id }, pool)).some((row: { consent_type: string }) => row.consent_type === "AI_BUSINESS_DATA")).toBe(false);
      const session = await login(`test-consent-a-${suffix}@example.test`, password, `test-consent-login-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter: limiter, environment });
      const sessionId = JSON.parse(Buffer.from(session.accessToken.split(".")[1] ?? "", "base64url").toString()).sid as string;
      await expect(revokeConsent("AI_BUSINESS_DATA", granted.version, { ...base, userId: first.id, sessionId }, pool)).rejects.toMatchObject({ statusCode: 422, code: "REAUTH_REQUIRED" });
      await reauthenticate(first.id, sessionId, password, randomUUID(), randomUUID(), { pool, rateLimiter: limiter, environment });
      const revoked = await revokeConsent("AI_BUSINESS_DATA", granted.version, { ...base, userId: first.id, sessionId }, pool); expect(revoked.status).toBe("REVOKED");
      const regranted = await grantConsent("AI_BUSINESS_DATA", { policyVersion: "v2", purposeVersion: "v2", expectedVersion: revoked.version }, { ...base, userId: first.id }, pool); expect(regranted.status).toBe("GRANTED"); expect(regranted.version).toBe(revoked.version + 1);
      await expect(revokeConsent("CORE_SERVICE", 1, { ...base, userId: first.id, sessionId }, pool)).rejects.toMatchObject({ statusCode: 422, code: "CONSENT_REQUIRED" });
    } finally {
      for (const id of userIds) { await pool.query("DELETE FROM session WHERE user_id = $1", [id]); await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id = $1)", [id]); await pool.query("DELETE FROM workspace WHERE owner_user_id = $1", [id]); await pool.query("DELETE FROM credential WHERE user_id = $1", [id]); await pool.query("DELETE FROM app_user WHERE id = $1", [id]); }
    }
  });
});
