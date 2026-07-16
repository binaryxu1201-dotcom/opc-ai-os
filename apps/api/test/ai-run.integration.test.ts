import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { createProject } from "../src/project/service.js";
import { grantConsent } from "../src/workspace/consent.js";
import { AiProviderAdapter, MockAiProvider } from "../src/ai/provider.js";
import { aiRunEvents, createAiRun, getAiRun } from "../src/ai/run.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { buildApp } from "../src/app.js";
import { SignJWT } from "jose";
import { confirmSuggestion, editSuggestion, rejectSuggestion } from "../src/ai/suggestion.js";
import { confirmDailyTop3Suggestion } from "../src/ai/suggestion.js";
import { getDailyTop3 } from "../src/dashboard/service.js";
import { DAILY_TOP3_DAILY_QUOTA } from "../src/ai/run.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

async function fixture(suffix: string) {
  const base = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-ai-run-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-ai-run-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `AI run ${suffix}` }, { ...base, userId: user.id }, { pool });
  const context = { ...base, userId: user.id };
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Exercise AI runs", expectedVersion: 1 }, context, { pool });
  const project = await createProject({ name: "AI project", objective: "Exercise AI runs" }, `ai-run-project-${suffix}`, context, { pool });
  await grantConsent("AI_BUSINESS_DATA", { policyVersion: "v1", purposeVersion: "v1" }, context, pool);
  return { user, workspace, context, project };
}

async function cleanup(userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE ai_suggestion_decision DISABLE TRIGGER ai_suggestion_decision_append_only");
      await client.query("DELETE FROM task WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM ai_suggestion WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM ai_run WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM ai_usage_daily WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]);
      await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
      await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]);
      await client.query("DELETE FROM session WHERE user_id=$1", [userId]);
      await client.query("DELETE FROM credential WHERE user_id=$1", [userId]);
      await client.query("DELETE FROM app_user WHERE id=$1", [userId]);
      await client.query("ALTER TABLE ai_suggestion_decision ENABLE TRIGGER ai_suggestion_decision_append_only");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function accessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId, sv: 1 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(environment.ACCESS_TOKEN_ISSUER)
    .setAudience(environment.ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(environment.ACCESS_TOKEN_SECRET));
}

describe("AI run integration", () => {
  it("persists a redacted terminal snapshot, replays idempotently, isolates workspaces, and recovers SSE snapshots", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); userIds.push(first.user.id, second.user.id);
      let calls = 0;
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => { calls += 1; return { content: "{\"tasks\":[{\"title\":\"Review milestone\"}]}", modelVersion: "mock-v1", inputTokens: 12, outputTokens: 8 }; })), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const key = `ai-run-create-${suffix}`;
      const input = { capability: "TASK_BREAKDOWN" as const, projectId: first.project.id, instruction: "Plan the project for owner@example.test" };
      const created = await createAiRun(input, key, first.context, deps);
      await pool.query("UPDATE consent SET status='REVOKED',revoked_at=now(),version=version+1 WHERE workspace_id=$1 AND consent_type='AI_BUSINESS_DATA'", [first.workspace.id]);
      const replayed = await createAiRun(input, key, first.context, deps);

      expect(created.status).toBe("GENERATED");
      expect(replayed.id).toBe(created.id);
      expect(calls).toBe(1);
      await expect(createAiRun({ ...input, instruction: "Different request" }, key, first.context, deps)).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
      expect(JSON.stringify(created)).not.toContain("owner@example.test");
      await expect(getAiRun(created.id, second.context, { pool })).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
      expect(aiRunEvents(created).map((event) => event.id)).toEqual(["1", "2", "4"]);
      expect(aiRunEvents(created, "2").map((event) => event.id)).toEqual(["4"]);
      await expect(Promise.resolve().then(() => aiRunEvents(created, "bad"))).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      expect((await pool.query("SELECT count(*)::int AS count FROM task WHERE workspace_id=$1", [first.workspace.id])).rows[0]?.count).toBe(0);
      expect((await pool.query<{ suggestion_type: string; status: string }>("SELECT suggestion_type,status FROM ai_suggestion WHERE ai_run_id=$1", [created.id])).rows).toEqual([{ suggestion_type: "TASK_PLAN", status: "GENERATED" }]);
    } finally { await cleanup(userIds); }
  });

  it("persists a stable failed run without provider internals", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`failed-${suffix}`); userIds.push(account.user.id);
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => { throw new Error("upstream secret stack trace"); })), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const run = await createAiRun({ capability: "TASK_BREAKDOWN", projectId: account.project.id }, `ai-run-failed-${suffix}`, account.context, deps);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "AI_PROVIDER_UNAVAILABLE" });
      expect(JSON.stringify(run)).not.toContain("upstream secret stack trace");
    } finally { await cleanup(userIds); }
  });

  it("retries invalid structured output once, then degrades with a draft-only fallback", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`degraded-${suffix}`); userIds.push(account.user.id); let calls = 0;
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => { calls += 1; return { content: "not-json", modelVersion: "mock-v1", inputTokens: 2, outputTokens: 2 }; })), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const run = await createAiRun({ capability: "TASK_BREAKDOWN", projectId: account.project.id }, `ai-run-degraded-${suffix}`, account.context, deps);
      expect(run.status).toBe("DEGRADED");
      expect(calls).toBe(2);
      expect((await pool.query<{ suggestion_type: string }>("SELECT suggestion_type FROM ai_suggestion WHERE ai_run_id=$1", [run.id])).rows).toEqual([{ suggestion_type: "NATURAL_LANGUAGE_FALLBACK" }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM task WHERE workspace_id=$1", [account.workspace.id])).rows[0]?.count).toBe(0);
    } finally { await cleanup(userIds); }
  });

  it("persists a clarification draft and moves the run to waiting-for-input without task writes", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`clarify-${suffix}`); userIds.push(account.user.id);
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => ({ content: "{\"clarificationQuestion\":\"What is the primary deliverable?\"}", modelVersion: "mock-v1", inputTokens: 3, outputTokens: 3 }))), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const run = await createAiRun({ capability: "TASK_BREAKDOWN", projectId: account.project.id }, `ai-run-clarify-${suffix}`, account.context, deps);
      expect(run.status).toBe("WAITING_FOR_INPUT");
      expect((await pool.query<{ suggestion_type: string }>("SELECT suggestion_type FROM ai_suggestion WHERE ai_run_id=$1", [run.id])).rows).toEqual([{ suggestion_type: "CLARIFYING_QUESTION" }]);
      expect(aiRunEvents(run).at(-1)?.event).toBe("clarification.required");
      expect((await pool.query("SELECT count(*)::int AS count FROM task WHERE workspace_id=$1", [account.workspace.id])).rows[0]?.count).toBe(0);
    } finally { await cleanup(userIds); }
  });

  it("edits, confirms, and rejects draft suggestions transactionally without duplicate task writes", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`confirm-${suffix}`);
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => ({ content: "{\"tasks\":[{\"title\":\"Draft one\"},{\"title\":\"Draft two\"}]}", modelVersion: "mock-v1", inputTokens: 2, outputTokens: 2 }))), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const run = await createAiRun({ capability: "TASK_BREAKDOWN", projectId: account.project.id }, `ai-run-confirm-${suffix}`, account.context, deps);
      const suggestion = (await pool.query<{ id: string; version: number; proposed_payload: { items: { itemKey: string }[] } }>("SELECT id,version,proposed_payload FROM ai_suggestion WHERE ai_run_id=$1", [run.id])).rows[0];
      if (!suggestion) throw new Error("Suggestion missing");
      const firstKey = suggestion.proposed_payload.items[0]?.itemKey;
      const edited = await editSuggestion(suggestion.id, { expectedVersion: suggestion.version, items: [{ itemKey: firstKey!, title: "Edited task" }] }, `ai-suggestion-edit-${suffix}`, account.context, pool);
      await expect(editSuggestion(suggestion.id, { expectedVersion: suggestion.version, items: [{ itemKey: firstKey! }] }, `ai-suggestion-stale-${suffix}`, account.context, pool)).rejects.toMatchObject({ statusCode: 409, code: "RESOURCE_VERSION_CONFLICT" });
      const confirmed = await confirmSuggestion(suggestion.id, { expectedVersion: edited.version, editedPayload: { items: [{ itemKey: firstKey!, title: "Confirmed task" }] } }, `ai-suggestion-confirm-${suffix}`, account.context, pool);
      expect(confirmed.status).toBe("CONFIRMED"); expect(confirmed.createdResources).toHaveLength(1);
      const tasks = await pool.query<{ title: string; status: string; source: string; source_ai_item_key: string }>("SELECT title,status,source,source_ai_item_key FROM task WHERE source_ai_suggestion_id=$1", [suggestion.id]);
      expect(tasks.rows).toEqual([{ title: "Confirmed task", status: "CONFIRMED", source: "AI_CONFIRMED", source_ai_item_key: firstKey }]);
      await expect(confirmSuggestion(suggestion.id, { expectedVersion: confirmed.version }, `ai-suggestion-confirm-again-${suffix}`, account.context, pool)).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
      const decisions = await pool.query<{ decision: string }>("SELECT decision FROM ai_suggestion_decision WHERE suggestion_id=$1 ORDER BY created_at", [suggestion.id]);
      expect(decisions.rows.map((row) => row.decision)).toEqual(["EDITED", "EDITED", "CONFIRMED"]);

      const rejectedRun = await createAiRun({ capability: "TASK_BREAKDOWN", projectId: account.project.id }, `ai-run-reject-${suffix}`, { ...account.context, traceId: randomUUID() }, deps);
      const rejectedSuggestion = (await pool.query<{ id: string; version: number }>("SELECT id,version FROM ai_suggestion WHERE ai_run_id=$1", [rejectedRun.id])).rows[0];
      if (!rejectedSuggestion) throw new Error("Rejected suggestion missing");
      const rejected = await rejectSuggestion(rejectedSuggestion.id, { expectedVersion: rejectedSuggestion.version, reason: "Not aligned" }, `ai-suggestion-reject-${suffix}`, account.context, pool);
      expect(rejected.status).toBe("REJECTED");
      expect((await pool.query("SELECT count(*)::int AS count FROM task WHERE source_ai_suggestion_id=$1", [rejectedSuggestion.id])).rows[0]?.count).toBe(0);
    } finally { if (userIds.length > 0) await cleanup(userIds); }
  });

  it("creates a max-three daily recommendation, records quota, falls back safely, and confirms ordering without task writes", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`daily-${suffix}`); userIds.push(account.user.id);
      const taskIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const [index, taskId] of taskIds.entries()) {
        await pool.query("INSERT INTO task (id,workspace_id,project_id,depth,title,assignee_user_id,status,created_by_user_id,updated_by_user_id) VALUES ($1,$2,$3,1,$4,$5,'CONFIRMED',$5,$5)", [taskId, account.workspace.id, account.project.id, `Daily task ${index + 1}`, account.user.id]);
      }
      const content = JSON.stringify({ items: taskIds.slice(0, 3).map((taskId, index) => ({ taskId, rank: index + 1, reason: `Reason ${index + 1}` })) });
      const deps = { pool, provider: new AiProviderAdapter(new MockAiProvider(async () => ({ content, modelVersion: "mock-v1", inputTokens: 5, outputTokens: 7 }))), model: "mock-v1", providerKey: "mock", promptVersion: "v1" };
      const firstRun = await createAiRun({ capability: "DAILY_TOP3" }, `ai-daily-first-${suffix}`, account.context, deps);
      expect(firstRun.status).toBe("GENERATED");
      const suggestion = (await pool.query<{ id: string; version: number; proposed_payload: { items: { taskId: string; rank: number; reason: string }[] } }>("SELECT id,version,proposed_payload FROM ai_suggestion WHERE ai_run_id=$1", [firstRun.id])).rows[0];
      if (!suggestion) throw new Error("Daily suggestion missing");
      expect(suggestion.proposed_payload.items).toHaveLength(3);
      const before = await pool.query<{ id: string; status: string; version: number }>("SELECT id,status,version FROM task WHERE workspace_id=$1 ORDER BY id", [account.workspace.id]);
      const dashboard = await getDailyTop3({}, account.context, { pool });
      expect(dashboard).toMatchObject({ source: "AI_DAILY_TOP3", suggestion: { id: suggestion.id, version: suggestion.version } });
      expect(dashboard.items.map((item) => item.taskId)).toEqual(taskIds.slice(0, 3));
      const confirmed = await confirmDailyTop3Suggestion(suggestion.id, { expectedVersion: suggestion.version, items: [{ taskId: taskIds[1]!, rank: 1 }, { taskId: taskIds[0]!, rank: 2 }] }, `daily-confirm-${suffix}`, account.context, pool);
      const after = await pool.query<{ id: string; status: string; version: number }>("SELECT id,status,version FROM task WHERE workspace_id=$1 ORDER BY id", [account.workspace.id]);
      expect(confirmed).toMatchObject({ status: "CONFIRMED", createdResources: [] });
      expect(before.rows).toEqual(after.rows);
      const decision = await pool.query<{ decision: string; edited_payload: { items: { taskId: string; rank: number }[] } }>("SELECT decision,edited_payload FROM ai_suggestion_decision WHERE suggestion_id=$1", [suggestion.id]);
      expect(decision.rows).toMatchObject([{ decision: "CONFIRMED", edited_payload: { items: [{ taskId: taskIds[1], rank: 1 }, { taskId: taskIds[0], rank: 2 }] } }]);
      await expect(confirmDailyTop3Suggestion(suggestion.id, { expectedVersion: confirmed.version, items: [{ taskId: taskIds[0]!, rank: 1 }] }, `daily-confirm-again-${suffix}`, account.context, pool)).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
      for (let attempt = 2; attempt <= DAILY_TOP3_DAILY_QUOTA; attempt += 1) await createAiRun({ capability: "DAILY_TOP3" }, `ai-daily-${attempt}-${suffix}`, { ...account.context, traceId: randomUUID() }, deps);
      await expect(createAiRun({ capability: "DAILY_TOP3" }, `ai-daily-over-quota-${suffix}`, { ...account.context, traceId: randomUUID() }, deps)).rejects.toMatchObject({ statusCode: 429, code: "AI_QUOTA_CAPABILITY_EXHAUSTED" });
      const usage = await pool.query<{ request_count: number; success_count: number; failure_count: number; input_tokens: string; output_tokens: string }>("SELECT request_count,success_count,failure_count,input_tokens,output_tokens FROM ai_usage_daily WHERE workspace_id=$1 AND usage_date=(now() AT TIME ZONE 'UTC')::date AND capability='DAILY_TOP3'", [account.workspace.id]);
      expect(usage.rows).toEqual([{ request_count: DAILY_TOP3_DAILY_QUOTA, success_count: DAILY_TOP3_DAILY_QUOTA, failure_count: 0, input_tokens: "15", output_tokens: "21" }]);
    } finally { await cleanup(userIds); }
  });

  it("serves a safe authenticated SSE lifecycle and Last-Event-ID recovery", async () => {
    const suffix = randomUUID(); const userIds: string[] = []; let app: ReturnType<typeof buildApp> | undefined;
    try {
      const account = await fixture(`sse-${suffix}`); userIds.push(account.user.id);
      const sessionId = randomUUID();
      await pool.query(`INSERT INTO session (id,user_id,session_family_id,refresh_token_hash,session_version,ip_prefix_hash,expires_at)
        VALUES ($1,$2,$3,$4,1,$5,now()+interval '1 day')`, [sessionId, account.user.id, randomUUID(), `hash-${suffix}`, `ip-${suffix}`]);
      const token = await accessToken(account.user.id, sessionId);
      app = buildApp(environment, undefined, { pool, rateLimiter: limiter });
      const headers = { authorization: `Bearer ${token}`, accept: "text/event-stream", origin: environment.WEB_ORIGIN, "x-opc-csrf": "1", "idempotency-key": `ai-run-sse-${suffix}` };
      const created = await app.inject({ method: "POST", url: "/api/v1/ai/runs", headers, payload: { capability: "TASK_BREAKDOWN", projectId: account.project.id, input: { instruction: "never expose owner@example.test" } } });
      expect(created.statusCode).toBe(200);
      expect(created.headers["content-type"]).toContain("text/event-stream");
      expect(created.body).toContain("event: run.created");
      expect(created.body).toContain("event: run.completed");
      expect(created.body).not.toContain("owner@example.test");
      const runId = JSON.parse(created.body.match(/data: (.+)/)?.[1] ?? "{}").runId as string;
      const recovered = await app.inject({ method: "GET", url: `/api/v1/ai/runs/${runId}/events`, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": "2" } });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.body).not.toContain("event: run.created");
      expect(recovered.body).toContain("event: run.completed");
    } finally { if (app) await app.close(); await cleanup(userIds); }
  });
});
