import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Environment } from "@opc/config";
import type { Pool, PoolClient } from "pg";
import type { RateLimiter } from "../platform/rate-limiter.js";
import { appendAuditEvent } from "../platform/audit.js";
import { ApiError } from "../platform/errors.js";

const accessLifetimeSeconds = 15 * 60;
const refreshLifetimeSeconds = 30 * 24 * 60 * 60;
const reauthLifetimeSeconds = 15 * 60;
const passwordRounds = 12;

export interface AuthenticationDependencies { pool: Pool; rateLimiter: RateLimiter; environment: Environment; }
export interface AuthResult { accessToken: string; expiresAt: string; refreshToken: string; user: { id: string; email: string | null; phone: string | null; status: string; version: number }; }

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function createRefreshToken(): string { return randomBytes(48).toString("base64url"); }
function secret(environment: Environment): Uint8Array { return new TextEncoder().encode(environment.ACCESS_TOKEN_SECRET); }
function normalizeIdentifier(identifier: string): string { return identifier.trim().toLowerCase(); }

async function signAccessToken(environment: Environment, userId: string, sessionId: string, sessionVersion: number): Promise<{ accessToken: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + accessLifetimeSeconds * 1_000);
  const accessToken = await new SignJWT({ sid: sessionId, sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId).setIssuer(environment.ACCESS_TOKEN_ISSUER).setAudience(environment.ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt().setExpirationTime(Math.floor(expiresAt.getTime() / 1_000)).sign(secret(environment));
  return { accessToken, expiresAt: expiresAt.toISOString() };
}

export async function verifyAccessToken(token: string, environment: Environment): Promise<{ userId: string; sessionId: string; sessionVersion: number }> {
  try {
    const { payload } = await jwtVerify(token, secret(environment), { issuer: environment.ACCESS_TOKEN_ISSUER, audience: environment.ACCESS_TOKEN_AUDIENCE });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.sv !== "number") throw new Error("Missing required claims");
    return { userId: payload.sub, sessionId: payload.sid, sessionVersion: payload.sv };
  } catch { throw new ApiError(401, "ACCESS_TOKEN_INVALID", "访问令牌无效或已过期。"); }
}

async function createSession(client: PoolClient, userId: string, environment: Environment, ip: string, parentSessionId?: string, familyId: string = randomUUID(), sessionVersion = 1, lastAuthenticatedAt?: Date): Promise<AuthResult> {
  const refreshToken = createRefreshToken(); const sessionId = randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + refreshLifetimeSeconds * 1_000);
  await client.query(`INSERT INTO session (id, user_id, session_family_id, refresh_token_hash, session_version, parent_session_id, ip_prefix_hash, issued_at, expires_at, last_authenticated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [sessionId, userId, familyId, hashToken(refreshToken), sessionVersion, parentSessionId ?? null, hashToken(ip), now, expiresAt, lastAuthenticatedAt ?? null]);
  const user = await client.query<{ id: string; email: string | null; phone_e164: string | null; status: string; version: number }>("SELECT id, email, phone_e164, status, version FROM app_user WHERE id = $1", [userId]);
  const access = await signAccessToken(environment, userId, sessionId, sessionVersion);
  const current = user.rows[0]; if (!current) throw new Error("Session user disappeared");
  return { ...access, refreshToken, user: { id: current.id, email: current.email, phone: current.phone_e164, status: current.status, version: current.version } };
}

export async function login(identifier: string, password: string, ip: string, requestId: string, traceId: string, dependencies: AuthenticationDependencies): Promise<AuthResult> {
  const normalized = normalizeIdentifier(identifier); const ipKey = `login_fail:ip:${ip}`; const accountKey = `login_fail:account:${normalized}`;
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; secret_hash: string; status: string }>(`SELECT app_user.id, credential.secret_hash, app_user.status FROM app_user JOIN credential ON credential.user_id = app_user.id AND credential.status = 'ACTIVE' WHERE app_user.email = $1 OR app_user.phone_e164 = $1 FOR UPDATE`, [normalized]);
    const candidate = result.rows[0];
    if (!candidate || candidate.status !== "ACTIVE" || !(await bcrypt.compare(password, candidate.secret_hash))) {
      await client.query("ROLLBACK");
      const [ipLimit, accountLimit] = await Promise.all([dependencies.rateLimiter.consume(ipKey, 5, 900), dependencies.rateLimiter.consume(accountKey, 5, 900)]);
      if (!ipLimit.allowed || !accountLimit.allowed) throw new ApiError(429, "RATE_LIMITED", "登录尝试过于频繁，请稍后重试。");
      throw new ApiError(401, "UNAUTHENTICATED", "邮箱、手机号或密码不正确。");
    }
    const session = await createSession(client, candidate.id, dependencies.environment, ip);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: candidate.id, action: "USER_LOGGED_IN", resourceType: "session", resourceId: session.user.id, requestId, traceId, result: "SUCCESS" });
    await client.query("COMMIT"); return session;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function refresh(refreshToken: string, ip: string, requestId: string, traceId: string, dependencies: AuthenticationDependencies): Promise<AuthResult> {
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN"); const tokenHash = hashToken(refreshToken);
    const result = await client.query<{ id: string; user_id: string; session_family_id: string; session_version: number; revoked_at: Date | null; expires_at: Date; last_authenticated_at: Date | null }>("SELECT id, user_id, session_family_id, session_version, revoked_at, expires_at, last_authenticated_at FROM session WHERE refresh_token_hash = $1 FOR UPDATE", [tokenHash]);
    const current = result.rows[0];
    if (!current || current.revoked_at || current.expires_at <= new Date()) {
      if (current?.revoked_at) await client.query("UPDATE session SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'REPLAY_DETECTED') WHERE session_family_id = $1 AND revoked_at IS NULL", [current.session_family_id]);
      await client.query("COMMIT"); throw new ApiError(419, current?.revoked_at ? "REFRESH_TOKEN_REUSED" : "REFRESH_TOKEN_EXPIRED", "会话已失效，请重新登录。");
    }
    await client.query("UPDATE session SET revoked_at = now(), revoke_reason = 'ROTATED', last_used_at = now() WHERE id = $1", [current.id]);
    const inheritedReauth = current.last_authenticated_at && current.last_authenticated_at.getTime() + reauthLifetimeSeconds * 1_000 > Date.now() ? current.last_authenticated_at : undefined;
    const next = await createSession(client, current.user_id, dependencies.environment, ip, current.id, current.session_family_id, current.session_version + 1, inheritedReauth);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: current.user_id, action: "SESSION_REFRESHED", resourceType: "session", resourceId: current.id, requestId, traceId, result: "SUCCESS" });
    await client.query("COMMIT"); return next;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function reauthenticate(userId: string, sessionId: string, password: string, requestId: string, traceId: string, dependencies: AuthenticationDependencies): Promise<void> {
  const client = await dependencies.pool.connect(); try { await client.query("BEGIN"); const result = await client.query<{ secret_hash: string }>("SELECT secret_hash FROM credential WHERE user_id = $1 AND status = 'ACTIVE'", [userId]);
    if (!result.rows[0] || !(await bcrypt.compare(password, result.rows[0].secret_hash))) throw new ApiError(401, "UNAUTHENTICATED", "密码不正确。");
    await client.query("UPDATE session SET last_authenticated_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [sessionId, userId]);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: userId, action: "USER_REAUTHENTICATED", resourceType: "session", resourceId: sessionId, requestId, traceId, result: "SUCCESS" }); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string, requestId: string, traceId: string, dependencies: AuthenticationDependencies): Promise<void> {
  if (newPassword.length < 12 || Buffer.byteLength(newPassword, "utf8") > 72) throw new ApiError(422, "VALIDATION_FAILED", "新密码长度必须至少 12 个字符且不超过 72 字节。");
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query<{ secret_hash: string; session_family_id: string; last_authenticated_at: Date | null }>(`SELECT credential.secret_hash, session.session_family_id, session.last_authenticated_at FROM credential JOIN session ON session.user_id = credential.user_id WHERE credential.user_id = $1 AND credential.status = 'ACTIVE' AND session.id = $2 AND session.revoked_at IS NULL FOR UPDATE`, [userId, sessionId]);
    const current = state.rows[0];
    if (!current || !current.last_authenticated_at || current.last_authenticated_at.getTime() + reauthLifetimeSeconds * 1_000 <= Date.now()) throw new ApiError(422, "REAUTH_REQUIRED", "该操作需要在当前会话中重新验证身份。");
    if (!(await bcrypt.compare(currentPassword, current.secret_hash))) throw new ApiError(401, "UNAUTHENTICATED", "当前密码不正确。");
    const nextHash = await bcrypt.hash(newPassword, passwordRounds);
    await client.query("UPDATE credential SET secret_hash = $1, changed_at = now() WHERE user_id = $2 AND status = 'ACTIVE'", [nextHash, userId]);
    await client.query("UPDATE session SET revoked_at = now(), revoke_reason = 'PASSWORD_CHANGED' WHERE user_id = $1 AND session_family_id <> $2 AND revoked_at IS NULL", [userId, current.session_family_id]);
    await appendAuditEvent(client, { eventId: randomUUID(), occurredAt: new Date(), actorType: "USER", actorId: userId, action: "PASSWORD_CHANGED", resourceType: "credential", requestId, traceId, result: "SUCCESS" });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
