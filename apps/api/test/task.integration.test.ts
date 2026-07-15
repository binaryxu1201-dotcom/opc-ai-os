import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { createProject } from "../src/project/service.js";
import { createTask, getTask, listTasks, transitionTask, updateTask } from "../src/task/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

async function fixture(suffix: string) {
  const base = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-task-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-task-${suffix}`, base.requestId, base.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `Task ${suffix}` }, { ...base, userId: user.id }, { pool });
  const context = { ...base, userId: user.id };
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Exercise task boundaries", expectedVersion: 1 }, context, { pool });
  const project = await createProject({ name: "Tasks", objective: "Exercise task boundaries" }, `task-project-${suffix}`, context, { pool });
  return { userId: user.id, workspace, context, project };
}

async function cleanup(userIds: string[]) { for (const userId of userIds) { await pool.query("DELETE FROM task WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await pool.query("DELETE FROM project WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await pool.query("DELETE FROM idempotency_record WHERE actor_user_id=$1", [userId]); await pool.query("DELETE FROM consent WHERE workspace_id IN (SELECT id FROM workspace WHERE owner_user_id=$1)", [userId]); await pool.query("DELETE FROM workspace WHERE owner_user_id=$1", [userId]); await pool.query("DELETE FROM session WHERE user_id=$1", [userId]); await pool.query("DELETE FROM credential WHERE user_id=$1", [userId]); await pool.query("DELETE FROM app_user WHERE id=$1", [userId]); } }

describe("task integration", () => {
  it("creates an isolated three-level tree and rejects a fourth level", async () => {
    const suffix = randomUUID(); const users: string[] = [];
    try {
      const first = await fixture(`a-${suffix}`); const second = await fixture(`b-${suffix}`); users.push(first.userId, second.userId);
      const key = `task-root-${suffix}`; const root = await createTask(first.project.id, { title: "Root", estimatedMinutes: 30 }, key, first.context, { pool });
      expect(await createTask(first.project.id, { title: "Root", estimatedMinutes: 30 }, key, first.context, { pool })).toEqual(root);
      const child = await createTask(first.project.id, { title: "Child", parentTaskId: root.id }, `task-child-${suffix}`, first.context, { pool });
      const grandchild = await createTask(first.project.id, { title: "Grandchild", parentTaskId: child.id }, `task-grandchild-${suffix}`, first.context, { pool });
      expect([root.depth, child.depth, grandchild.depth]).toEqual([1, 2, 3]);
      await expect(createTask(first.project.id, { title: "Fourth", parentTaskId: grandchild.id }, `task-fourth-${suffix}`, first.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "TASK_DEPTH_EXCEEDED" });
      await expect(getTask(root.id, second.context, { pool })).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
      const rootChildren = await listTasks(first.project.id, { parentTaskId: root.id, limit: 20 }, first.context, { pool });
      expect(rootChildren.tasks.map((task) => task.id)).toEqual([child.id]);
    } finally { await cleanup(users); }
  });

  it("enforces state transitions, optimistic locking, defer and explicit descendant cancellation", async () => {
    const suffix = randomUUID(); const users: string[] = [];
    try {
      const account = await fixture(`state-${suffix}`); users.push(account.userId);
      const root = await createTask(account.project.id, { title: "Root" }, `task-state-root-${suffix}`, account.context, { pool });
      const child = await createTask(account.project.id, { title: "Child", parentTaskId: root.id }, `task-state-child-${suffix}`, account.context, { pool });
      await expect(transitionTask(root.id, "start", { expectedVersion: root.version }, `task-start-invalid-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
      const confirmed = await transitionTask(root.id, "confirm", { expectedVersion: root.version }, `task-confirm-${suffix}`, account.context, { pool });
      const started = await transitionTask(root.id, "start", { expectedVersion: confirmed.version }, `task-start-${suffix}`, account.context, { pool });
       const deferred = await transitionTask(root.id, "defer", { expectedVersion: started.version, isDeferred: true }, `task-defer-${suffix}`, account.context, { pool });
       const updated = await updateTask(root.id, { title: "Revised", expectedVersion: deferred.version }, `task-update-${suffix}`, account.context, { pool });
       await expect(updateTask(root.id, { title: "Stale", expectedVersion: deferred.version }, `task-stale-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "RESOURCE_VERSION_CONFLICT" });
       expect((await getTask(root.id, account.context, { pool })).title).toBe("Revised");
       expect((await pool.query("SELECT 1 FROM idempotency_record WHERE actor_user_id=$1 AND scope='task.update' AND key=$2", [account.userId, `task-stale-${suffix}`])).rowCount).toBe(0);
       await expect(transitionTask(root.id, "cancel", { expectedVersion: updated.version }, `task-cancel-missing-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      const cancelled = await transitionTask(root.id, "cancel", { expectedVersion: updated.version, childTaskHandling: "CANCEL_ALL" }, `task-cancel-all-${suffix}`, account.context, { pool });
      expect(cancelled.status).toBe("CANCELLED"); expect((await getTask(child.id, account.context, { pool })).status).toBe("CANCELLED");
      await expect(updateTask(root.id, { title: "Terminal", expectedVersion: cancelled.version }, `task-terminal-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
    } finally { await cleanup(users); }
  });
});
