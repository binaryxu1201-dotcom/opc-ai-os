import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (request, reply) => {
    request.traceId = randomUUID();
    reply.header("x-request-id", request.id);
  });
}

export function createRequestId(requestId: string | string[] | undefined): string {
  const candidate = Array.isArray(requestId) ? requestId[0] : requestId;
  return isUuid(candidate) ? candidate : randomUUID();
}

export function getRequestMeta(request: FastifyRequest): { requestId: string; traceId: string } {
  return { requestId: request.id, traceId: request.traceId };
}
