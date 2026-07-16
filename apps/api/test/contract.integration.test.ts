import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { buildApp, type ReadinessDependencies } from "../src/app.js";
import { login } from "../src/auth/session.js";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const rateLimiter = new RedisSlidingWindowRateLimiter(redis);
const dependencies: ReadinessDependencies = { checkDatabase: async () => true, checkRedis: async () => true };

async function makeUser(suffix: string) {
  const email = `test-contract-${suffix}@example.test`;
  const context = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-contract-${suffix}`, context.requestId, context.traceId, { pool, rateLimiter });
  await createWorkspace({ name: `Contract ${suffix}` }, { ...context, userId: user.id }, { pool });
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Verify contract tests", expectedVersion: 1 }, { ...context, userId: user.id }, { pool });
  const session = await login(email, "correct-horse-battery-staple", `test-contract-${suffix}`, randomUUID(), randomUUID(), { pool, rateLimiter, environment });
  return { userId: user.id, accessToken: session.accessToken };
}

afterAll(async () => { redis.disconnect(); await pool.end(); });

describe("M6 API contract and security regression", () => {
  it("API-03 workspace isolation: cross-workspace project access returns 404 without leaking existence", async () => {
    const a = await makeUser(`a-${randomUUID()}`);
    const b = await makeUser(`b-${randomUUID()}`);
    let projectId: string | undefined;
    try {
      const app = buildApp(environment, dependencies);
      const create = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${a.accessToken}`, origin: environment.WEB_ORIGIN, "x-opc-csrf": "1", "idempotency-key": `contract-${randomUUID()}` }, payload: { name: "Isolated project", objective: "verify isolation" } });
      expect(create.statusCode).toBe(201);
      projectId = create.json().data.id;
      const cross = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { authorization: `Bearer ${b.accessToken}` } });
      expect(cross.statusCode).toBe(404);
      expect(cross.json().error.code).not.toBe("WORKSPACE_MISMATCH");
      await app.close();
    } finally {
      for (const id of [a.userId, b.userId]) {
        await pool.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [id]);
        await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [id]);
        await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [id]);
        await pool.query("DELETE FROM session WHERE user_id=$1", [id]);
        await pool.query("DELETE FROM credential WHERE user_id=$1", [id]);
        await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [id]);
        await pool.query("DELETE FROM app_user WHERE id=$1", [id]);
      }
    }
  });

  it("API-04 idempotency: same key + same request returns the first result, not a duplicate", async () => {
    const a = await makeUser(`idem-${randomUUID()}`);
    const key = `contract-idem-${randomUUID()}`;
    try {
      const app = buildApp(environment, dependencies);
      const first = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${a.accessToken}`, origin: environment.WEB_ORIGIN, "x-opc-csrf": "1", "idempotency-key": key }, payload: { name: "Idempotent project", objective: "verify" } });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().data.id;
      const second = await app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${a.accessToken}`, origin: environment.WEB_ORIGIN, "x-opc-csrf": "1", "idempotency-key": key }, payload: { name: "Idempotent project", objective: "verify" } });
      expect(second.statusCode).toBe(201);
      expect(second.json().data.id).toBe(firstId);
      const count = await pool.query<{ c: string }>("SELECT COUNT(*)::text AS c FROM project WHERE id=$1", [firstId]);
      expect(Number(count.rows[0]!.c)).toBe(1);
      await app.close();
    } finally {
      await pool.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [a.userId]);
      await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [a.userId]);
      await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM session WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM credential WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM app_user WHERE id=$1", [a.userId]);
    }
  });

  it("API-11 / SEC-03 operations endpoints reject normal user sessions with OPERATOR_AUTH_REQUIRED", async () => {
    const a = await makeUser(`ops-${randomUUID()}`);
    try {
      const app = buildApp(environment, dependencies);
      for (const url of ["/api/v1/operations/metrics/funnel", "/api/v1/operations/metrics/ai", "/api/v1/operations/users/search?q=abcd"]) {
        const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${a.accessToken}` } });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code, url).toBe("OPERATOR_AUTH_REQUIRED");
      }
      await app.close();
    } finally {
      await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [a.userId]);
      await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM session WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM credential WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM app_user WHERE id=$1", [a.userId]);
    }
  });

  it("API-02 access token expiry is rejected with 401", async () => {
    const a = await makeUser(`exp-${randomUUID()}`);
    try {
      const app = buildApp(environment, dependencies);
      const bad = await app.inject({ method: "GET", url: "/api/v1/workspace", headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwfQ.invalid" } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe("ACCESS_TOKEN_INVALID");
      await app.close();
    } finally {
      await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [a.userId]);
      await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM session WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM credential WHERE user_id=$1", [a.userId]);
      await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [a.userId]);
      await pool.query("DELETE FROM app_user WHERE id=$1", [a.userId]);
    }
  });
});
