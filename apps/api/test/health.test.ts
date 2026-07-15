import { describe, expect, it } from "vitest";
import { buildApp, type ReadinessDependencies } from "../src/app.js";

const environment = {
  NODE_ENV: "test" as const,
  API_HOST: "127.0.0.1",
  API_PORT: 3001,
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
  REDIS_URL: "redis://127.0.0.1:6379",
  WEB_ORIGIN: "http://localhost:3000"
};

const readyDependencies: ReadinessDependencies = {
  checkDatabase: async () => true,
  checkRedis: async () => true
};

describe("health endpoints", () => {
  it("returns liveness without binding a network port", async () => {
    const app = buildApp(environment, readyDependencies);
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("returns degraded readiness when a dependency is unavailable", async () => {
    const app = buildApp(environment, {
      checkDatabase: async () => true,
      checkRedis: async () => false
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { database: "ok", redis: "unavailable" }
    });
    await app.close();
  });
});
