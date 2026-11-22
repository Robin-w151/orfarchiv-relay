export const RateLimitResult = {
  Allowed: 'allowed',
  Limited: 'limited',
  Exceeded: 'exceeded',
} as const;
export type RateLimitResult = (typeof RateLimitResult)[keyof typeof RateLimitResult];

export const RATE_LIMIT_CLOSE_FACTOR = 3;

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly messagesPerSecond: number,
    now: number,
  ) {
    this.tokens = messagesPerSecond;
    this.updatedAt = now;
  }

  take(now: number): RateLimitResult {
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.messagesPerSecond, this.tokens + elapsedSeconds * this.messagesPerSecond);
    this.updatedAt = now;
    this.tokens -= 1;

    if (this.tokens >= 0) {
      return RateLimitResult.Allowed;
    }
    if (this.tokens >= -(RATE_LIMIT_CLOSE_FACTOR - 1) * this.messagesPerSecond) {
      return RateLimitResult.Limited;
    }
    return RateLimitResult.Exceeded;
  }
}
