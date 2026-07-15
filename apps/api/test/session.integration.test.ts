import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { login, reauthenticate, refresh } from "../src/auth/session.js";
import { registerUser } from "../src/auth/register.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const rateLimiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

describe("session family integration", () => {
  it("rotates refresh tokens and revokes the whole family when a rotated token is replayed", async () => {
    const email = `test-session-${randomUUID()}@example.test`;
    const requestId = randomUUID();
    const traceId = randomUUID();
    const testIp = `test-session-${randomUUID()}`;
    let userId: string | undefined;
    try {
      const user = await registerUser({ email, password: "correct-horse-battery-staple", termsVersion: "test-2026-07", privacyVersion: "test-2026-07" }, testIp, requestId, traceId, { pool, rateLimiter });
      userId = user.id;
      const first = await login(email, "correct-horse-battery-staple", testIp, randomUUID(), randomUUID(), { pool, rateLimiter, environment });
      const second = await refresh(first.refreshToken, testIp, randomUUID(), randomUUID(), { pool, rateLimiter, environment });
      await expect(refresh(first.refreshToken, testIp, randomUUID(), randomUUID(), { pool, rateLimiter, environment })).rejects.toMatchObject({ statusCode: 419, code: "REFRESH_TOKEN_REUSED" });
      await expect(refresh(second.refreshToken, testIp, randomUUID(), randomUUID(), { pool, rateLimiter, environment })).rejects.toMatchObject({ statusCode: 419 });
      const authenticated = await login(email, "correct-horse-battery-staple", testIp, randomUUID(), randomUUID(), { pool, rateLimiter, environment });
      await reauthenticate(user.id, JSON.parse(Buffer.from(authenticated.accessToken.split(".")[1] ?? "", "base64url").toString()).sid, "correct-horse-battery-staple", randomUUID(), randomUUID(), { pool, rateLimiter, environment });
    } finally {
      if (userId) {
        await pool.query("DELETE FROM session WHERE user_id = $1", [userId]);
        await pool.query("DELETE FROM credential WHERE user_id = $1", [userId]);
        await pool.query("DELETE FROM app_user WHERE id = $1", [userId]);
      }
    }
  });
});
