import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function registerWriteGuard(app: FastifyInstance, webOrigin: string): void {
  app.addHook("onRequest", async (request) => {
    if (!writeMethods.has(request.method)) {
      return;
    }

    if (request.headers.origin !== webOrigin) {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "请求来源不被允许。");
    }

    if (request.headers["x-opc-csrf"] !== "1") {
      throw new ApiError(403, "CSRF_REQUIRED", "请求缺少必要的 CSRF 校验。");
    }
  });
}
