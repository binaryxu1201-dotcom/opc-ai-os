import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { Environment } from "@opc/config";
import type { HealthResponse, ReadinessResponse } from "@opc/contracts";
import Fastify, { type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { Client } from "pg";
import { Pool } from "pg";
import { registerErrorHandler } from "./platform/errors.js";
import { createRequestId, registerRequestContext } from "./platform/request-context.js";
import { registerWriteGuard } from "./platform/write-guard.js";
import { ApiError } from "./platform/errors.js";
import { RedisSlidingWindowRateLimiter } from "./platform/rate-limiter.js";
import { registerUser, type RegistrationDependencies } from "./auth/register.js";
import { changePassword, login, refresh, reauthenticate, verifyAccessToken, type AuthenticationDependencies } from "./auth/session.js";
import { createWorkspace, getProfile, getWorkspace, putProfile } from "./workspace/service.js";
import { grantConsent, listConsents, revokeConsent } from "./workspace/consent.js";
import { createProject, getProject, listProjects, transitionProject, updateProject } from "./project/service.js";
import { createTask, getTask, listTasks, transitionTask, updateTask } from "./task/service.js";
import { changeCustomerStage, createCustomer, getCustomer, listCustomers, listCustomerStageHistory, updateCustomer } from "./customer/service.js";
import { getDailyTop3 } from "./dashboard/service.js";
import { AiProviderAdapter, MockAiProvider } from "./ai/provider.js";
import { aiRunEvents, createAiRun, getAiRun } from "./ai/run.js";
import { confirmDailyTop3Suggestion, confirmSuggestion, editSuggestion, rejectSuggestion } from "./ai/suggestion.js";

export interface ReadinessDependencies {
  checkDatabase: () => Promise<boolean>;
  checkRedis: () => Promise<boolean>;
}

interface OwnedRegistrationDependencies extends RegistrationDependencies {
  close: () => Promise<void>;
}

function createRegistrationDependencies(environment: Environment): OwnedRegistrationDependencies {
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  const redis = new Redis(environment.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  return {
    pool,
    rateLimiter: new RedisSlidingWindowRateLimiter(redis),
    async close(): Promise<void> {
      redis.disconnect();
      await pool.end();
    }
  };
}

export function createReadinessDependencies(environment: Environment): ReadinessDependencies {
  return {
    async checkDatabase(): Promise<boolean> {
      const client = new Client({ connectionString: environment.DATABASE_URL });
      try {
        await client.connect();
        await client.query("SELECT 1");
        return true;
      } catch {
        return false;
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    async checkRedis(): Promise<boolean> {
      const client = new Redis(environment.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: 1_000
      });
      try {
        await client.connect();
        return (await client.ping()) === "PONG";
      } catch {
        return false;
      } finally {
        client.disconnect();
      }
    }
  };
}

export function buildApp(environment: Environment, dependencies = createReadinessDependencies(environment), registration?: RegistrationDependencies) {
  const app = Fastify({
    logger: true,
    requestIdHeader: false,
    genReqId: (request) => createRequestId(request.headers["x-request-id"])
  });

  void app.register(cookie);
  void app.register(cors, { origin: environment.WEB_ORIGIN });
  registerRequestContext(app);
  registerWriteGuard(app, environment.WEB_ORIGIN);
  registerErrorHandler(app);

  const ownedRegistrationDependencies = registration ? undefined : createRegistrationDependencies(environment);
  const registrationDependencies: RegistrationDependencies = registration ?? ownedRegistrationDependencies!;
  const authenticationDependencies: AuthenticationDependencies = { ...registrationDependencies, environment };
  const workspaceDependencies = { pool: registrationDependencies.pool };
  const aiDependencies = {
    pool: registrationDependencies.pool,
    provider: new AiProviderAdapter(new MockAiProvider(async (request) => ({ content: request.messages[0]?.content.includes("daily-priority") ? "{\"items\":[]}" : "{\"tasks\":[{\"title\":\"Review current priorities\"}]}" , modelVersion: "mock-v1", inputTokens: 0, outputTokens: 0 }))),
    model: "mock-v1",
    providerKey: "mock",
    promptVersion: "v1"
  };
  const authContext = async (request: FastifyRequest) => { const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined; if (!token) throw new ApiError(401, "UNAUTHENTICATED", "请先登录。"); const claims = await verifyAccessToken(token, environment); return { userId: claims.userId, sessionId: claims.sessionId, requestId: request.id, traceId: request.traceId }; };
  app.addHook("onClose", async () => { if (ownedRegistrationDependencies) await ownedRegistrationDependencies.close(); });
  app.post<{ Body: { email?: string; phone?: string; password: string; termsVersion: string; privacyVersion: string } }>("/api/v1/auth/register", async (request, reply) => {
    const user = await registerUser(request.body, request.ip, request.id, request.traceId, registrationDependencies);
    return reply.code(201).send({ data: user, meta: { requestId: request.id } });
  });
  app.post<{ Body: { identifier: string; password: string } }>("/api/v1/auth/login", async (request, reply) => {
    const session = await login(request.body.identifier, request.body.password, request.ip, request.id, request.traceId, authenticationDependencies);
    reply.setCookie("opc_refresh", session.refreshToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/v1/auth", maxAge: 30 * 24 * 60 * 60 });
    return reply.send({ data: { accessToken: session.accessToken, expiresAt: session.expiresAt, user: session.user }, meta: { requestId: request.id } });
  });
  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const refreshToken = request.cookies.opc_refresh;
    if (!refreshToken) throw new ApiError(419, "SESSION_REVOKED", "会话已失效，请重新登录。");
    const session = await refresh(refreshToken, request.ip, request.id, request.traceId, authenticationDependencies);
    reply.setCookie("opc_refresh", session.refreshToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/v1/auth", maxAge: 30 * 24 * 60 * 60 });
    return reply.send({ data: { accessToken: session.accessToken, expiresAt: session.expiresAt }, meta: { requestId: request.id } });
  });
  app.post<{ Body: { password: string } }>("/api/v1/auth/re-authenticate", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
    const claims = await verifyAccessToken(token, environment);
    await reauthenticate(claims.userId, claims.sessionId, request.body.password, request.id, request.traceId, authenticationDependencies);
    return reply.code(204).send();
  });
  app.post<{ Body: { currentPassword: string; newPassword: string } }>("/api/v1/auth/password", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token) throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
    const claims = await verifyAccessToken(token, environment);
    await changePassword(claims.userId, claims.sessionId, request.body.currentPassword, request.body.newPassword, request.id, request.traceId, authenticationDependencies);
    return reply.code(204).send();
  });
  app.post<{ Body: { name: string; description?: string } }>("/api/v1/workspace", async (request, reply) => { const workspace = await createWorkspace(request.body, await authContext(request), workspaceDependencies); return reply.code(201).send({ data: workspace, meta: { requestId: request.id } }); });
  app.get("/api/v1/workspace", async (request) => ({ data: await getWorkspace(await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get("/api/v1/profile", async (request) => ({ data: await getProfile(await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.put<{ Body: { skills: string[]; entrepreneurStage: string; businessGoal: string; expectedVersion: number } }>("/api/v1/profile", async (request) => ({ data: await putProfile(request.body, await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get("/api/v1/consents", async (request) => ({ data: await listConsents(await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  app.put<{ Params: { type: string }; Body: { policyVersion: string; purposeVersion: string; expectedVersion?: number } }>("/api/v1/consents/:type", async (request) => ({ data: await grantConsent(request.params.type, request.body, await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  app.post<{ Params: { type: string }; Body: { expectedVersion: number } }>("/api/v1/consents/:type/revoke", async (request) => ({ data: await revokeConsent(request.params.type, request.body.expectedVersion, await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  const idempotencyKey = (request: FastifyRequest) => { const key = request.headers["idempotency-key"]; if (typeof key !== "string") throw new ApiError(422, "VALIDATION_FAILED", "写入请求必须提供 Idempotency-Key。"); return key; };
  app.get<{ Querystring: { status?: string | string[]; limit?: string; cursor?: string } }>("/api/v1/projects", async (request) => { const status = request.query.status === undefined ? undefined : Array.isArray(request.query.status) ? request.query.status : [request.query.status]; const result = await listProjects({ status, limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor }, await authContext(request), workspaceDependencies); return { data: result.projects, meta: { nextCursor: result.nextCursor, hasMore: result.hasMore, requestId: request.id } }; });
  app.post<{ Body: { name: string; objective: string; deliverable?: string; plannedStartAt?: string; plannedEndAt?: string } }>("/api/v1/projects", async (request, reply) => reply.code(201).send({ data: await createProject(request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", async (request) => ({ data: await getProject(request.params.projectId, await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.patch<{ Params: { projectId: string }; Body: { name?: string; objective?: string; deliverable?: string | null; plannedStartAt?: string | null; plannedEndAt?: string | null; expectedVersion: number } }>("/api/v1/projects/:projectId", async (request) => ({ data: await updateProject(request.params.projectId, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.post<{ Params: { projectId: string; action: "start" | "pause" | "resume" | "complete" | "cancel" }; Body: { expectedVersion: number; childTaskHandling?: "KEEP" | "CANCEL_ALL" } }>("/api/v1/projects/:projectId/actions/:action", async (request) => ({ data: await transitionProject(request.params.projectId, request.params.action, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { projectId: string }; Querystring: { parentTaskId?: string; status?: string | string[]; limit?: string; cursor?: string } }>("/api/v1/projects/:projectId/tasks", async (request) => { const status = request.query.status === undefined ? undefined : Array.isArray(request.query.status) ? request.query.status : [request.query.status]; const result = await listTasks(request.params.projectId, { parentTaskId: request.query.parentTaskId, status, limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor }, await authContext(request), workspaceDependencies); return { data: result.tasks, meta: { nextCursor: result.nextCursor, hasMore: result.hasMore, requestId: request.id } }; });
  app.post<{ Params: { projectId: string }; Body: { title: string; description?: string; parentTaskId?: string; dueAt?: string; estimatedMinutes?: number } }>("/api/v1/projects/:projectId/tasks", async (request, reply) => reply.code(201).send({ data: await createTask(request.params.projectId, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { taskId: string } }>("/api/v1/tasks/:taskId", async (request) => ({ data: await getTask(request.params.taskId, await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.patch<{ Params: { taskId: string }; Body: { title?: string; description?: string | null; dueAt?: string | null; estimatedMinutes?: number | null; expectedVersion: number } }>("/api/v1/tasks/:taskId", async (request) => ({ data: await updateTask(request.params.taskId, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.post<{ Params: { taskId: string; action: "confirm" | "start" | "complete" | "close" | "cancel" | "defer" }; Body: { expectedVersion: number; childTaskHandling?: "CANCEL_ALL"; isDeferred?: boolean } }>("/api/v1/tasks/:taskId/actions/:action", async (request) => ({ data: await transitionTask(request.params.taskId, request.params.action, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Querystring: { stage?: string | string[]; intentLevel?: string | string[]; limit?: string; cursor?: string } }>("/api/v1/customers", async (request) => { const stage = request.query.stage === undefined ? undefined : Array.isArray(request.query.stage) ? request.query.stage : [request.query.stage]; const intentLevel = request.query.intentLevel === undefined ? undefined : Array.isArray(request.query.intentLevel) ? request.query.intentLevel : [request.query.intentLevel]; const result = await listCustomers({ stage, intentLevel, limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor }, await authContext(request), workspaceDependencies); return { data: result.customers, meta: { nextCursor: result.nextCursor, hasMore: result.hasMore, requestId: request.id } }; });
  app.post<{ Body: { name: string; source: string; intentLevel: "LOW" | "MEDIUM" | "HIGH"; nextAction?: string; notes?: string } }>("/api/v1/customers", async (request, reply) => reply.code(201).send({ data: await createCustomer(request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { customerId: string } }>("/api/v1/customers/:customerId", async (request) => ({ data: await getCustomer(request.params.customerId, await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.patch<{ Params: { customerId: string }; Body: { name?: string; source?: string; intentLevel?: "LOW" | "MEDIUM" | "HIGH"; nextAction?: string | null; notes?: string | null; expectedVersion: number } }>("/api/v1/customers/:customerId", async (request) => ({ data: await updateCustomer(request.params.customerId, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.post<{ Params: { customerId: string }; Body: { toStage: string; reason?: string; expectedVersion: number } }>("/api/v1/customers/:customerId/actions/change-stage", async (request) => ({ data: await changeCustomerStage(request.params.customerId, request.body, idempotencyKey(request), await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { customerId: string }; Querystring: { limit?: string; cursor?: string } }>("/api/v1/customers/:customerId/stage-history", async (request) => { const result = await listCustomerStageHistory(request.params.customerId, { limit: request.query.limit === undefined ? undefined : Number(request.query.limit), cursor: request.query.cursor }, await authContext(request), workspaceDependencies); return { data: result.history, meta: { nextCursor: result.nextCursor, hasMore: result.hasMore, requestId: request.id } }; });
  app.get<{ Querystring: { date?: string } }>("/api/v1/dashboard/daily-top3", async (request) => ({ data: await getDailyTop3(request.query.date === undefined ? {} : { date: request.query.date }, await authContext(request), workspaceDependencies), meta: { requestId: request.id } }));
  app.post<{ Body: { suggestionId: string; expectedVersion: number; items: { taskId: string; rank: number }[] } }>("/api/v1/dashboard/daily-top3/actions/confirm", async (request) => ({ data: await confirmDailyTop3Suggestion(request.body.suggestionId, { expectedVersion: request.body.expectedVersion, items: request.body.items }, idempotencyKey(request), await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  app.post<{ Body: { capability: "TASK_BREAKDOWN" | "DAILY_TOP3"; projectId?: string; input?: { instruction?: string } } }>("/api/v1/ai/runs", async (request, reply) => {
    if (!request.headers.accept?.includes("text/event-stream")) throw new ApiError(422, "VALIDATION_FAILED", "AI 请求必须接受 text/event-stream 响应。");
    const run = await createAiRun({ capability: request.body.capability, ...(request.body.projectId === undefined ? {} : { projectId: request.body.projectId }), ...(request.body.input?.instruction === undefined ? {} : { instruction: request.body.input.instruction }) }, idempotencyKey(request), await authContext(request), aiDependencies);
    const events = aiRunEvents(run);
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-request-id": request.id });
    for (const event of events) reply.raw.write(`event: ${event.event}\nid: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
    reply.raw.end();
  });
  app.get<{ Params: { runId: string } }>("/api/v1/ai/runs/:runId", async (request) => ({ data: await getAiRun(request.params.runId, await authContext(request), aiDependencies), meta: { requestId: request.id } }));
  app.get<{ Params: { runId: string } }>("/api/v1/ai/runs/:runId/events", async (request, reply) => {
    const run = await getAiRun(request.params.runId, await authContext(request), aiDependencies); const events = aiRunEvents(run, typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined);
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-request-id": request.id });
    for (const event of events) reply.raw.write(`event: ${event.event}\nid: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
    reply.raw.end();
  });
  app.post<{ Params: { suggestionId: string }; Body: { expectedVersion: number; items: { itemKey: string; title?: string; description?: string | null; estimatedMinutes?: number | null; dueAt?: string | null }[] } }>("/api/v1/ai/suggestions/:suggestionId/actions/edit", async (request) => ({ data: await editSuggestion(request.params.suggestionId, request.body, idempotencyKey(request), await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  app.post<{ Params: { suggestionId: string }; Body: { expectedVersion: number; editedPayload?: { items: { itemKey: string; title?: string; description?: string | null; estimatedMinutes?: number | null; dueAt?: string | null }[] } } }>("/api/v1/ai/suggestions/:suggestionId/actions/confirm", async (request) => ({ data: await confirmSuggestion(request.params.suggestionId, request.body, idempotencyKey(request), await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));
  app.post<{ Params: { suggestionId: string }; Body: { expectedVersion: number; reason?: string } }>("/api/v1/ai/suggestions/:suggestionId/actions/reject", async (request) => ({ data: await rejectSuggestion(request.params.suggestionId, request.body, idempotencyKey(request), await authContext(request), registrationDependencies.pool), meta: { requestId: request.id } }));

  app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));

  app.get("/ready", async (_request, reply): Promise<ReadinessResponse> => {
    const [database, redis] = await Promise.all([
      dependencies.checkDatabase(),
      dependencies.checkRedis()
    ]);
    const response: ReadinessResponse = {
      status: database && redis ? "ok" : "degraded",
      checks: {
        database: database ? "ok" : "unavailable",
        redis: redis ? "ok" : "unavailable"
      }
    };

    return reply.code(response.status === "ok" ? 200 : 503).send(response);
  });

  return app;
}
