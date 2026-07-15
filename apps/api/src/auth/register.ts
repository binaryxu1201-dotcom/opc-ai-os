import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RateLimiter } from "../platform/rate-limiter.js";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";

const passwordRounds = 12;

export interface RegisterInput { email?: string; phone?: string; password: string; termsVersion: string; privacyVersion: string; }
export interface RegistrationDependencies { pool: Pool; rateLimiter: RateLimiter; }
interface ValidatedRegisterInput { email?: string; phone?: string; password: string; termsVersion: string; privacyVersion: string; }

function normalizeEmail(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

export function validateRegistration(input: RegisterInput): ValidatedRegisterInput {
  const email = normalizeEmail(input.email);
  const phone = input.phone?.trim();
  if (!email && !phone) throw new ApiError(422, "VALIDATION_FAILED", "请提供邮箱或手机号。", [{ field: "email", reason: "required_with_phone" }]);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "VALIDATION_FAILED", "邮箱格式不正确。", [{ field: "email", reason: "invalid" }]);
  if (phone && !/^\+[1-9]\d{1,31}$/.test(phone)) throw new ApiError(422, "VALIDATION_FAILED", "手机号必须符合 E.164 格式。", [{ field: "phone", reason: "invalid" }]);
  if (Buffer.byteLength(input.password, "utf8") > 72 || input.password.length < 12) throw new ApiError(422, "VALIDATION_FAILED", "密码长度必须至少 12 个字符且不超过 72 字节。", [{ field: "password", reason: "invalid_length" }]);
  if (!input.termsVersion || !input.privacyVersion) throw new ApiError(422, "VALIDATION_FAILED", "必须确认服务条款与隐私政策。", [{ field: "termsVersion", reason: "required" }]);
  return {
    password: input.password,
    termsVersion: input.termsVersion,
    privacyVersion: input.privacyVersion,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {})
  };
}

export async function registerUser(input: RegisterInput, ip: string, requestId: string, traceId: string, dependencies: RegistrationDependencies) {
  const data = validateRegistration(input);
  const limit = await dependencies.rateLimiter.consume(`register:${ip}`, 5, 900);
  if (!limit.allowed) throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。", [{ retryAfterSeconds: limit.retryAfterSeconds }]);
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const userId = randomUUID();
    const credentialId = randomUUID();
    const hash = await bcrypt.hash(data.password, passwordRounds);
    await client.query("INSERT INTO app_user (id, email, phone_e164) VALUES ($1, $2, $3)", [userId, data.email ?? null, data.phone ?? null]);
    await client.query("INSERT INTO credential (id, user_id, secret_hash, hash_algorithm) VALUES ($1, $2, $3, 'bcrypt')", [credentialId, userId, hash]);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "SYSTEM", action: "USER_REGISTERED", resourceType: "app_user", resourceId: userId, afterSummary: { userId, termsVersion: data.termsVersion, privacyVersion: data.privacyVersion }, requestId, traceId, result: "SUCCESS" });
    await client.query("COMMIT");
    return { id: userId, email: data.email ?? null, phone: data.phone ?? null, status: "ACTIVE", version: 1 };
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new ApiError(409, "IDENTIFIER_ALREADY_EXISTS", "该邮箱或手机号已被注册。");
    throw error;
  } finally { client.release(); }
}
