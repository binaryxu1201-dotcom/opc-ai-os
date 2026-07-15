import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: readonly Record<string, unknown>[]
  ) {
    super(message);
  }
}

function sendError(error: ApiError, request: FastifyRequest, reply: FastifyReply): void {
  reply.code(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    },
    meta: { requestId: request.id }
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      sendError(error, request, reply);
      return;
    }

    request.log.error({ err: error }, "Unhandled API error");
    reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。"
      },
      meta: { requestId: request.id }
    });
  });
}
