import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { createProject } from "../src/project/service.js";
import { getDailyTop3 } from "../src/dashboard/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

async function fixture(suffix: string) {
  const context = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-dashboard-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-dashboard-${suffix}`, context.requestId, context.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `Dashboard ${suffix}` }, { ...context, userId: user.id }, { pool });
  const userContext = { ...context, userId: user.id };
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Exercise dashboard fallback", expectedVersion: 1 }, userContext, { pool });
  const project = await createProject({ name: "Daily priorities", objective: "Exercise dashboard fallback" }, `dashboard-project-${suffix}`, userContext, { pool });
  return { user, workspace, context: userContext, project };
}

async function cleanup(userIds: string[]) {
  for (const userId of userIds) {
    await pool.query("DELETE FROM task WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await pool.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]);
    await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]);
    await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]);
    await pool.query("DELETE FROM session WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM credential WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM app_user WHERE id=$1", [userId]);
  }
}

describe("dashboard daily-top3 integration", () => {
  it("returns at most three workspace-scoped active tasks in deterministic priority order without changing them", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); userIds.push(first.user.id, second.user.id);
      const pausedProject = await createProject({ name: "Paused priorities", objective: "Confirm paused projects remain visible" }, `dashboard-paused-${suffix}`, first.context, { pool });
      const terminalProject = await createProject({ name: "Terminal priorities", objective: "Confirm terminal projects are excluded" }, `dashboard-terminal-${suffix}`, first.context, { pool });
      await pool.query("UPDATE project SET status='PAUSED' WHERE id=$1", [pausedProject.id]);
      await pool.query("UPDATE project SET status='CANCELLED', cancelled_at=now() WHERE id=$1", [terminalProject.id]);
      const overdueId = randomUUID(); const activeId = randomUUID(); const draftId = randomUUID();
      const pausedId = randomUUID(); const fourthId = randomUUID(); const completedId = randomUUID(); const foreignId = randomUUID(); const terminalId = randomUUID();
      const insert = async (id: string, account: typeof first, projectId: string, title: string, status: string, dueAt: Date | null, deferred = false) => {
        await pool.query(`INSERT INTO task (id,workspace_id,project_id,depth,title,assignee_user_id,status,due_at,is_deferred,created_by_user_id,updated_by_user_id)
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$5,$5)`, [id, account.workspace.id, projectId, title, account.user.id, status, dueAt, deferred]);
      };
      await insert(overdueId, first, first.project.id, "Overdue", "CONFIRMED", new Date(Date.now() - 3_600_000));
      await insert(activeId, first, first.project.id, "In progress", "IN_PROGRESS", new Date(Date.now() + 3_600_000));
      await insert(draftId, first, first.project.id, "Draft", "DRAFT", null);
      await insert(pausedId, first, pausedProject.id, "Paused project", "CONFIRMED", new Date(Date.now() + 5_400_000));
      await insert(fourthId, first, first.project.id, "Later", "CONFIRMED", new Date(Date.now() + 7_200_000), true);
      await insert(completedId, first, first.project.id, "Completed", "COMPLETED", new Date(Date.now() - 7_200_000));
      await insert(foreignId, second, second.project.id, "Other workspace", "IN_PROGRESS", new Date(Date.now() - 7_200_000));
      await insert(terminalId, first, terminalProject.id, "Terminal project", "IN_PROGRESS", new Date(Date.now() - 7_200_000));

      const before = await pool.query<{ id: string; status: string; version: number }>("SELECT id,status,version FROM task WHERE workspace_id=$1 ORDER BY id", [first.workspace.id]);
      const result = await getDailyTop3({ date: "2026-07-15" }, first.context, { pool });
      const after = await pool.query<{ id: string; status: string; version: number }>("SELECT id,status,version FROM task WHERE workspace_id=$1 ORDER BY id", [first.workspace.id]);

      expect(result).toMatchObject({ date: "2026-07-15", source: "FALLBACK_ACTIVE_TASKS" });
      expect(result.items.map((item) => item.taskId)).toEqual([overdueId, activeId, pausedId]);
      expect(result.items.map((item) => item.rank)).toEqual([1, 2, 3]);
      expect(result.items.map((item) => item.taskId)).not.toContain(foreignId);
      expect(result.items.map((item) => item.taskId)).not.toContain(terminalId);
      expect(result.items.map((item) => item.taskId)).not.toContain(completedId);
      expect(before.rows).toEqual(after.rows);
      await expect(getDailyTop3({ date: "not-a-date" }, first.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
    } finally { await cleanup(userIds); }
  });

  it("returns an empty fallback list when the workspace has no active tasks", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await fixture(`empty-${suffix}`); userIds.push(account.user.id);
      await pool.query(`INSERT INTO task (id,workspace_id,project_id,depth,title,assignee_user_id,status,completed_at,created_by_user_id,updated_by_user_id)
        VALUES ($1,$2,$3,1,'Completed',$4,'COMPLETED',now(),$4,$4)`, [randomUUID(), account.workspace.id, account.project.id, account.user.id]);
      await expect(getDailyTop3({}, account.context, { pool })).resolves.toMatchObject({ source: "FALLBACK_ACTIVE_TASKS", items: [] });
    } finally { await cleanup(userIds); }
  });
});
