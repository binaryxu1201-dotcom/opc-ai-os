import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnvironment } from "@opc/config";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { registerUser } from "../src/auth/register.js";
import { createWorkspace, putProfile } from "../src/workspace/service.js";
import { RedisSlidingWindowRateLimiter } from "../src/platform/rate-limiter.js";
import { createProject, getProject, listProjects, transitionProject, updateProject } from "../src/project/service.js";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
const limiter = new RedisSlidingWindowRateLimiter(redis);

afterAll(async () => { redis.disconnect(); await pool.end(); });

async function createOnboardedUser(suffix: string) {
  const context = { requestId: randomUUID(), traceId: randomUUID() };
  const user = await registerUser({ email: `test-project-${suffix}@example.test`, password: "correct-horse-battery-staple", termsVersion: "test", privacyVersion: "test" }, `test-project-${suffix}`, context.requestId, context.traceId, { pool, rateLimiter: limiter });
  const workspace = await createWorkspace({ name: `Workspace ${suffix}` }, { ...context, userId: user.id }, { pool });
  await putProfile({ skills: ["TypeScript"], entrepreneurStage: "IDEATION", businessGoal: "Exercise project boundaries", expectedVersion: 1 }, { ...context, userId: user.id }, { pool });
  return { user, workspace, context: { ...context, userId: user.id } };
}

async function cleanup(userIds: string[]): Promise<void> {
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

describe("project integration", () => {
  it("enforces onboarding, workspace isolation, idempotent creation, optimistic updates and project transitions", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const first = await createOnboardedUser(`a-${suffix}`); const second = await createOnboardedUser(`b-${suffix}`); userIds.push(first.user.id, second.user.id);
      const createInput = { name: "Launch", objective: "Ship the first milestone", deliverable: "Release notes", plannedStartAt: "2026-07-15", plannedEndAt: "2026-07-31" };
      const key = `project-create-${suffix}`;
      const created = await createProject(createInput, key, first.context, { pool });
      const replay = await createProject(createInput, key, first.context, { pool });
      expect(replay).toEqual(created); expect(created.status).toBe("DRAFT"); expect(created.version).toBe(1);
      await expect(createProject({ ...createInput, name: "Other" }, key, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
      await expect(getProject(created.id, second.context, { pool })).rejects.toMatchObject({ statusCode: 404, code: "RESOURCE_NOT_FOUND" });
      const page = await listProjects({ status: ["DRAFT"], limit: 20 }, first.context, { pool }); expect(page.projects.map((project) => project.id)).toContain(created.id);
      await expect(transitionProject(created.id, "start", { expectedVersion: 1 }, `project-start-${suffix}`, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
      await pool.query(`INSERT INTO task (id, workspace_id, project_id, depth, title, assignee_user_id, status, created_by_user_id, updated_by_user_id)
        VALUES ($1,$2,$3,1,'Confirm launch',$4,'CONFIRMED',$4,$4)`, [randomUUID(), first.workspace.id, created.id, first.user.id]);
      const started = await transitionProject(created.id, "start", { expectedVersion: 1 }, `project-start-ok-${suffix}`, first.context, { pool }); expect(started.status).toBe("IN_PROGRESS");
      const paused = await transitionProject(created.id, "pause", { expectedVersion: started.version }, `project-pause-${suffix}`, first.context, { pool }); expect(paused.status).toBe("PAUSED");
       const resumed = await transitionProject(created.id, "resume", { expectedVersion: paused.version }, `project-resume-${suffix}`, first.context, { pool }); expect(resumed.status).toBe("IN_PROGRESS");
       const updated = await updateProject(created.id, { name: "Launch revised", expectedVersion: resumed.version }, `project-update-${suffix}`, first.context, { pool }); expect(updated.name).toBe("Launch revised");
       await expect(updateProject(created.id, { name: "Stale", expectedVersion: resumed.version }, `project-update-stale-${suffix}`, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "RESOURCE_VERSION_CONFLICT" });
       expect((await getProject(created.id, first.context, { pool })).name).toBe("Launch revised");
       expect((await pool.query("SELECT 1 FROM idempotency_record WHERE actor_user_id=$1 AND scope='project.update' AND key=$2", [first.user.id, `project-update-stale-${suffix}`])).rowCount).toBe(0);
       await pool.query("UPDATE task SET status='COMPLETED', completed_at=now() WHERE project_id=$1", [created.id]);
      const completed = await transitionProject(created.id, "complete", { expectedVersion: updated.version }, `project-complete-${suffix}`, first.context, { pool }); expect(completed.status).toBe("COMPLETED"); expect(completed.completedAt).toBeTruthy();
      await expect(updateProject(created.id, { name: "No longer editable", expectedVersion: completed.version }, `project-update-final-${suffix}`, first.context, { pool })).rejects.toMatchObject({ statusCode: 409, code: "INVALID_STATE_TRANSITION" });
    } finally { await cleanup(userIds); }
  });

  it("requires explicit cancellation handling and cancels active project tasks only when requested", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await createOnboardedUser(`cancel-${suffix}`); userIds.push(account.user.id);
      const project = await createProject({ name: "Cancel", objective: "Verify cancellation" }, `project-cancel-create-${suffix}`, account.context, { pool });
      const taskId = randomUUID();
      await pool.query(`INSERT INTO task (id, workspace_id, project_id, depth, title, assignee_user_id, status, created_by_user_id, updated_by_user_id)
        VALUES ($1,$2,$3,1,'Open task',$4,'CONFIRMED',$4,$4)`, [taskId, account.workspace.id, project.id, account.user.id]);
      await expect(transitionProject(project.id, "cancel", { expectedVersion: project.version }, `project-cancel-missing-${suffix}`, account.context, { pool })).rejects.toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
      const cancelled = await transitionProject(project.id, "cancel", { expectedVersion: project.version, childTaskHandling: "CANCEL_ALL" }, `project-cancel-all-${suffix}`, account.context, { pool });
      expect(cancelled.status).toBe("CANCELLED");
      expect((await pool.query<{ status: string }>("SELECT status FROM task WHERE id=$1", [taskId])).rows[0]?.status).toBe("CANCELLED");
    } finally { await cleanup(userIds); }
  });

  it("derives stable project progress from all task states without changing project state", async () => {
    const suffix = randomUUID(); const userIds: string[] = [];
    try {
      const account = await createOnboardedUser(`progress-${suffix}`); userIds.push(account.user.id);
      const project = await createProject({ name: "Progress", objective: "Derive task progress" }, `project-progress-${suffix}`, account.context, { pool });
      const tasks = [
        { status: "DRAFT", dueAt: new Date(Date.now() - 3_600_000) },
        { status: "CONFIRMED", dueAt: null },
        { status: "IN_PROGRESS", dueAt: new Date(Date.now() - 3_600_000) },
        { status: "COMPLETED", dueAt: null },
        { status: "CLOSED", dueAt: null },
        { status: "CANCELLED", dueAt: null }
      ];
      for (const [index, task] of tasks.entries()) {
        await pool.query(`INSERT INTO task (id,workspace_id,project_id,depth,title,assignee_user_id,status,due_at,completed_at,closed_at,cancelled_at,created_by_user_id,updated_by_user_id)
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,CASE WHEN $6 IN ('COMPLETED','CLOSED') THEN now() ELSE NULL END,CASE WHEN $6='CLOSED' THEN now() ELSE NULL END,CASE WHEN $6='CANCELLED' THEN now() ELSE NULL END,$5,$5)`, [randomUUID(), account.workspace.id, project.id, `Task ${index}`, account.user.id, task.status, task.dueAt]);
      }
      const summary = (await getProject(project.id, account.context, { pool })).taskSummary;
      expect(summary).toEqual({ total: 6, completed: 2, cancelled: 1, draft: 1, confirmed: 1, inProgress: 1, nonTerminal: 3, overdue: 2, completionRate: 40 });
      expect((await getProject(project.id, account.context, { pool })).status).toBe("DRAFT");
      const empty = await createProject({ name: "Empty", objective: "No tasks" }, `project-empty-${suffix}`, account.context, { pool });
      expect((await getProject(empty.id, account.context, { pool })).taskSummary.completionRate).toBeNull();
    } finally { await cleanup(userIds); }
  });
});
