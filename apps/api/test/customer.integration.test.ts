import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { changeCustomerStage, createCustomer, getCustomer, listCustomers, listCustomerStageHistory, updateCustomer } from "../src/customer/service.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

async function fixture(suffix: string) {
  const base = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-customer-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-customer-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `Customer ${suffix}` }, { ...base, userId: user.id }, { pool });
  const context = { ...base, userId: user.id };
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Exercise CRM boundaries", expectedVersion: 1 }, context, { pool });
  return { userId: user.id, workspace, context };
}

async function cleanup(userIds: string[]) { for (const userId of userIds) { const client = await pool.connect(); try { await client.query("BEGIN"); await client.query("ALTER TABLE customer_stage_history DISABLE TRIGGER customer_stage_history_append_only"); await client.query("DELETE FROM customer_stage_history WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("ALTER TABLE customer_stage_history ENABLE TRIGGER customer_stage_history_append_only"); await client.query("DELETE FROM customer WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]); await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]); await client.query("DELETE FROM session WHERE user_id=$1", [userId]); await client.query("DELETE FROM credential WHERE user_id=$1", [userId]); await client.query("DELETE FROM app_user WHERE id=$1", [userId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); } } }

describe("customer integration", () => {
  it("creates, isolates, replays and updates a customer without exposing stage mutation through PATCH", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); userIds.push(first.userId, second.userId);
      const input = { name: "Acme", source: "Referral", intentLevel: "HIGH" as const, nextAction: "Schedule call", notes: "Private note" }; const key = `customer-create-${suffix}`;
      const created = await createCustomer(input, key, first.context, { pool });
      expect(created.stage).toBe("LEAD"); expect(await createCustomer(input, key, first.context, { pool })).toEqual(created);
      await expect(createCustomer({ ...input, name: "Other" }, key, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
       await expect(getCustomer(created.id, second.context, { pool })).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
       const updated = await updateCustomer(created.id, { nextAction: "Send proposal", expectedVersion: created.version }, `customer-update-${suffix}`, first.context, { pool });
       expect(updated.nextAction).toBe("Send proposal"); expect(updated.stage).toBe("LEAD");
       await expect(updateCustomer(created.id, { name: "Stale", expectedVersion: created.version }, `customer-stale-${suffix}`, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "RESOURCE_VERSION_CONFLICT" });
       expect((await getCustomer(created.id, first.context, { pool })).nextAction).toBe("Send proposal");
       expect((await pool.query("SELECT 1 FROM idempotency_record WHERE actor_user_id=$1 AND scope='customer.update' AND key=$2", [first.userId, `customer-stale-${suffix}`])).rowCount).toBe(0);
       expect((await listCustomers({ stage: ["LEAD"], intentLevel: ["HIGH"], limit: 20 }, first.context, { pool })).customers.map((customer) => customer.id)).toContain(created.id);
    } finally { await cleanup(userIds); }
  });

  it("enforces the stage matrix, records append-only history, and requires a reason for reactivation", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`stage-${suffix}`); userIds.push(account.userId);
      const customer = await createCustomer({ name: "Lead", source: "Inbound", intentLevel: "MEDIUM" }, `customer-stage-create-${suffix}`, account.context, { pool });
      await expect(changeCustomerStage(customer.id, { toStage: "WON", expectedVersion: customer.version }, `customer-won-invalid-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
      const contacted = await changeCustomerStage(customer.id, { toStage: "CONTACTED", expectedVersion: customer.version }, `customer-contacted-${suffix}`, account.context, { pool });
      await expect(changeCustomerStage(customer.id, { toStage: "LEAD", expectedVersion: contacted.version }, `customer-regress-missing-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      const lead = await changeCustomerStage(customer.id, { toStage: "LEAD", reason: "Contact was premature", expectedVersion: contacted.version }, `customer-regress-${suffix}`, account.context, { pool });
      const lost = await changeCustomerStage(customer.id, { toStage: "LOST", expectedVersion: lead.version }, `customer-lost-${suffix}`, account.context, { pool });
      await expect(changeCustomerStage(customer.id, { toStage: "CONTACTED", expectedVersion: lost.version }, `customer-reactivate-missing-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      const reactivated = await changeCustomerStage(customer.id, { toStage: "CONTACTED", reason: "New budget", expectedVersion: lost.version }, `customer-reactivate-${suffix}`, account.context, { pool });
      expect(reactivated.stage).toBe("CONTACTED");
      const history = await listCustomerStageHistory(customer.id, { limit: 20 }, account.context, { pool });
      expect(history.history.map((entry) => `${entry.fromStage}->${entry.toStage}`)).toEqual(["LOST->CONTACTED", "LEAD->LOST", "CONTACTED->LEAD", "LEAD->CONTACTED"]);
      await expect(pool.query("UPDATE customer_stage_history SET reason='mutated' WHERE id=$1", [history.history[0]?.id])).rejects.toMatchObject({ code: "55000" });
    } finally { await cleanup(userIds); }
  });
});
