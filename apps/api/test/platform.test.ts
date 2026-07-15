import { describe, expect, it } from "vitest";
import { buildApp, type ReadinessDependencies } from "../src/app.js";
import { ApiError } from "../src/platform/errors.js";

const environment = {
  NODE_ENV: "test" as const,
  API_HOST: "127.0.0.1",
  API_PORT: 3001,
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  REDIS_URL: "redis://127.0.0.1:6379",
  WEB_ORIGIN: "http://localhost:3000"
};

const dependencies: ReadinessDependencies = {
  checkDatabase: async () => true,
  checkRedis: async () => true
};

describe("platform request safeguards", () => {
  it("propagates a valid client request ID", async () => {
    const requestId = "0197e1bc-0000-7000-8000-000000000801";
    const app = buildApp(environment, dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": requestId }
    });

    expect(response.headers["x-request-id"]).toBe(requestId);
    await app.close();
  });

  it("generates a request ID for an invalid client value", async () => {
    const app = buildApp(environment, dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "not-a-uuid" }
    });

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    await app.close();
  });

  it("rejects writes without an allowed origin and CSRF header", async () => {
    const app = buildApp(environment, dependencies);
    app.post("/test-write", async () => ({ data: {} }));
    const response = await app.inject({ method: "POST", url: "/test-write" });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(response.json().meta.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await app.close();
  });

  it("rejects writes missing the CSRF header after origin validation", async () => {
    const app = buildApp(environment, dependencies);
    app.post("/test-write", async () => ({ data: {} }));
    const response = await app.inject({
      method: "POST",
      url: "/test-write",
      headers: { origin: environment.WEB_ORIGIN }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_REQUIRED");
    await app.close();
  });

  it("allows writes with the approved origin and CSRF header", async () => {
    const app = buildApp(environment, dependencies);
    app.post("/test-write", async (request) => ({ data: { traceId: request.traceId } }));
    const response = await app.inject({
      method: "POST",
      url: "/test-write",
      headers: { origin: environment.WEB_ORIGIN, "x-opc-csrf": "1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.traceId).toMatch(/^[0-9a-f-]{36}$/i);
    await app.close();
  });

  it("returns stable errors without internal details", async () => {
    const app = buildApp(environment, dependencies);
    app.get("/test-error", async () => {
      throw new ApiError(422, "VALIDATION_FAILED", "字段校验失败。", [{ field: "email", reason: "invalid" }]);
    });
    const response = await app.inject({ method: "GET", url: "/test-error" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", message: "字段校验失败。" },
      meta: { requestId: expect.any(String) }
    });
    await app.close();
  });
});
