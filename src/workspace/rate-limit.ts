/** One in-memory sliding-window counter. Keys are client IPs or link ids, never URLs. */
export type RateLimitRule = { name: string; limit: number; windowMs: number };

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Bounds memory when many distinct keys arrive; the oldest keys are dropped first. */
const MAX_KEYS = 10_000;

export function createRateLimiter(rule: RateLimitRule, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  function recent(key: string, at: number): number[] {
    const kept = (hits.get(key) ?? []).filter((time) => time > at - rule.windowMs);
    if (kept.length === 0) hits.delete(key);
    else hits.set(key, kept);
    return kept;
  }
  function blocked(key: string, at: number): RateLimitDecision {
    const kept = recent(key, at);
    if (kept.length < rule.limit) return { allowed: true };
    const opensAt = kept[kept.length - rule.limit]! + rule.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((opensAt - at) / 1000)) };
  }
  function record(key: string, at: number) {
    const kept = recent(key, at);
    hits.delete(key);
    hits.set(key, [...kept, at]);
    while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!);
  }
  return {
    rule,
    /** Answers whether one more event fits, without counting it. */
    check(key: string): RateLimitDecision {
      return blocked(key, now());
    },
    /** Counts one event when it fits. */
    take(key: string): RateLimitDecision {
      const at = now();
      const decision = blocked(key, at);
      if (decision.allowed) record(key, at);
      return decision;
    },
    /** Counts one event that already happened, such as a failed callback. */
    record(key: string): void {
      record(key, now());
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/** PAS-673 limits for the onboarding link and the Linear sign-in callback. */
export const ONBOARDING_RATE_LIMITS = {
  startsPerIp: { name: "onboarding.start.ip", limit: 10, windowMs: 60_000 },
  startsPerLink: { name: "onboarding.start.link", limit: 20, windowMs: 24 * 60 * 60_000 },
  failedCallbacksPerIp: { name: "linear.callback.failed.ip", limit: 5, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;
