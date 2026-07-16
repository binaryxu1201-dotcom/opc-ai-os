import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { buildAiContext } from "../src/ai/context.js";
import { parseProposal } from "../src/ai/proposal.js";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { createProject } from "../src/project/service.js";
import { createCustomer } from "../src/customer/service.js";
import { grantConsent } from "../src/workspace/consent.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { AI_EVALUATION_SUITE_VERSION, dailyTop3Samples, lowQualitySamples, promptInjectionSamples, redactionSamples, taskBreakdownSamples } from "./fixtures/ai-evaluation-v1.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

function taskPlanContent(sample: typeof taskBreakdownSamples[number]): string {
  return JSON.stringify({ tasks: Array.from({ length: sample.expectedTaskCount }, (_, index) => ({ title: `${sample.category} task ${index + 1}`, estimatedMinutes: 30, dueAt: "2026-07-17T09:00:00.000Z" })) });
}

function dailyTop3Content(sample: typeof dailyTop3Samples[number]): string {
  return JSON.stringify({ items: Array.from({ length: sample.taskCount }, (_, index) => ({ taskId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, rank: index + 1, reason: `${sample.id} reason ${index + 1}` })) });
}

async function fixture(suffix: string) {
  const base = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-ai-evaluation-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-ai-evaluation-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `AI evaluation ${suffix}` }, { ...base, userId: user.id }, { pool });
  const context = { ...base, userId: user.id };
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Safely exercise versioned AI evaluation fixtures", expectedVersion: 1 }, context, { pool });
  const project = await createProject({ name: "Evaluation project", objective: "Verify AI boundaries" }, `ai-evaluation-project-${suffix}`, context, { pool });
  await grantConsent("AI_BUSINESS_DATA", { policyVersion: "v1", purposeVersion: "v1" }, context, pool);
  return { user, workspace, context, project };
}

async function cleanup(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE customer_stage_history DISABLE TRIGGER customer_stage_history_append_only");
    await client.query("DELETE FROM customer_stage_history WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("ALTER TABLE customer_stage_history ENABLE TRIGGER customer_stage_history_append_only");
    await client.query("DELETE FROM task WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM customer WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]);
    await client.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await client.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]);
    await client.query("DELETE FROM session WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM credential WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM app_user WHERE id=$1", [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

describe(`AI quality, safety, and cost evaluation fixtures ${AI_EVALUATION_SUITE_VERSION}`, () => {
  it("validates the 100-sample task-breakdown quality corpus with stable item keys and executable task fields", () => {
    expect(taskBreakdownSamples).toHaveLength(100);
    for (const sample of taskBreakdownSamples) {
      const proposal = parseProposal(taskPlanContent(sample), "TASK_BREAKDOWN");
      expect(proposal, sample.id).toMatchObject({ kind: "TASK_PLAN" });
      if (proposal?.kind !== "TASK_PLAN") throw new Error(`${sample.id} did not parse as TASK_PLAN`);
      expect(proposal.payload.items).toHaveLength(sample.expectedTaskCount);
      expect(proposal.payload.items.every((item, index) => item.itemKey === `item-${index + 1}` && item.title.length > 0 && item.estimatedMinutes !== null && item.dueAt !== null)).toBe(true);
    }
  });

  it("validates the 50-sample daily-top3 corpus with consecutive ranking and no more than three items", () => {
    expect(dailyTop3Samples).toHaveLength(50);
    for (const sample of dailyTop3Samples) {
      const proposal = parseProposal(dailyTop3Content(sample), "DAILY_TOP3");
      expect(proposal, sample.id).toMatchObject({ kind: "DAILY_TOP3" });
      if (proposal?.kind !== "DAILY_TOP3") throw new Error(`${sample.id} did not parse as DAILY_TOP3`);
      expect(proposal.payload.items).toHaveLength(sample.taskCount);
      expect(proposal.payload.items.every((item, index) => item.rank === index + 1 && item.reason.length > 0)).toBe(true);
    }
  });

  it("validates the 20-sample low-quality corpus as clarifying drafts without inferred business facts", () => {
    expect(lowQualitySamples).toHaveLength(20);
    for (const sample of lowQualitySamples) {
      const proposal = parseProposal(JSON.stringify({ clarificationQuestion: `Please clarify the goal for ${sample.id}.` }), "TASK_BREAKDOWN");
      expect(proposal, sample.id).toEqual({ kind: "CLARIFYING_QUESTION", payload: { question: `Please clarify the goal for ${sample.id}.` } });
      expect(JSON.stringify(proposal), sample.id).not.toContain(sample.input);
    }
  });

  it("keeps all 30 prompt-injection samples in the untrusted user partition without altering controlled system instructions", async () => {
    expect(promptInjectionSamples).toHaveLength(30);
    const account = await fixture(`injection-${randomUUID()}`);
    try {
      const baseline = await buildAiContext({ capability: "DAILY_TOP3" }, account.context, pool);
      for (const sample of promptInjectionSamples) {
        const result = await buildAiContext({ capability: "DAILY_TOP3", instruction: sample.input }, account.context, pool);
        expect(result.messages[0], sample.id).toEqual(baseline.messages[0]);
        expect(result.messages[1], sample.id).toEqual(baseline.messages[1]);
        expect(result.messages[2], sample.id).toEqual({ role: "user", content: sample.input });
        expect(result.messages.slice(0, 2).map((message) => message.content).join("\n"), sample.id).not.toContain(sample.input);
      }
    } finally { await cleanup(account.user.id); }
  });

  it("redacts all 30 forbidden-field samples from model context while preserving only their isolated instruction content", async () => {
    expect(redactionSamples).toHaveLength(30);
    const account = await fixture(`redaction-${randomUUID()}`);
    try {
      for (const sample of redactionSamples) {
        await createCustomer({ name: `Customer ${sample.id}`, source: "Evaluation", intentLevel: "HIGH", nextAction: sample.input, notes: sample.input }, `ai-evaluation-customer-${sample.id}-${randomUUID()}`, account.context, { pool });
      }
      await pool.query("INSERT INTO task (id,workspace_id,project_id,depth,title,description,assignee_user_id,status,created_by_user_id,updated_by_user_id) VALUES ($1,$2,$3,1,$4,$5,$6,'CONFIRMED',$6,$6)", [randomUUID(), account.workspace.id, account.project.id, "Safe task title", redactionSamples.map((sample) => sample.input).join(" "), account.user.id]);
      const result = await buildAiContext({ capability: "DAILY_TOP3" }, account.context, pool);
      const modelContext = result.messages.slice(0, 2).map((message) => message.content).join("\n");
      for (const sample of redactionSamples) {
        expect(modelContext, sample.id).not.toContain(sample.input);
        expect(modelContext, sample.id).not.toContain(`secret-${sample.id.match(/\d+$/)?.[0]}@example.test`);
        expect(modelContext, sample.id).not.toContain(`customer-note-${sample.id.match(/\d+$/)?.[0]}`);
      }
      expect(modelContext).toContain("客户-A");
      expect(result.inputRedactionMethod.customer).toContain("delete:notes");
    } finally { await cleanup(account.user.id); }
  });
});
