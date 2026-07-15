import { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  public constructor(private readonly redis: Redis) {}

  public async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1_000;
    const member = `${now}:${crypto.randomUUID()}`;
    const transaction = this.redis.multi();

    transaction.zremrangebyscore(key, 0, windowStart);
    transaction.zadd(key, now, member);
    transaction.zcard(key);
    transaction.expire(key, windowSeconds);

    const results = await transaction.exec();
    const count = results?.[2]?.[1];
    if (typeof count !== "number") {
      throw new Error("Redis rate limiter returned an invalid counter result");
    }

    if (count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    await this.redis.zrem(key, member);
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }
}
