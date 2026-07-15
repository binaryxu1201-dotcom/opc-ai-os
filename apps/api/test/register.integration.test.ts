import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });

afterAll(async () => {
  redis.disconnect();
  await pool.end();
});

describe("registration integration", () => {
  it("creates a bcrypt credential and registration audit without creating a workspace or consent", async () => {
    const suffix = randomUUID();
    const email = `test-registration-${suffix}@example.test`;
    const requestId = randomUUID();
    const traceId = randomUUID();
    const testIp = `test-registration-${suffix}`;
    let userId: string | undefined;

    try {
      const user = await registerUser(
        {
          email,
          password: "correct-horse-battery-staple",
          termsVersion: "test-2026-07",
          privacyVersion: "test-2026-07"
        },
        testIp,
        requestId,
        traceId,
        { pool, rateLimiter: new RedisSlidingWindowRateLimiter(redis) }
      );
      userId = user.id;

      const state = await pool.query<{
        secret_hash: string;
        workspace_count: number;
        consent_count: number;
      }>(
        `SELECT credential.secret_hash,
          (SELECT count(*)::int FROM workspace WHERE owner_user_id = $1) AS workspace_count,
          (SELECT count(*)::int FROM consent c JOIN workspace w ON w.id = c.workspace_id WHERE w.owner_user_id = $1) AS consent_count
         FROM credential
         WHERE credential.user_id = $1 AND credential.status = 'ACTIVE'`,
        [user.id]
      );

      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]?.secret_hash).not.toBe("correct-horse-battery-staple");
      await expect(bcrypt.compare("correct-horse-battery-staple", state.rows[0]?.secret_hash ?? "")).resolves.toBe(true);
      expect(state.rows[0]?.workspace_count).toBe(0);
      expect(state.rows[0]?.consent_count).toBe(0);
    } finally {
      if (userId) {
        await pool.query("DELETE FROM credential WHERE user_id = $1", [userId]);
        await pool.query("DELETE FROM app_user WHERE id = $1", [userId]);
      }
    }
  });
});
