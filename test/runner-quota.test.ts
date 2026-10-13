import { expect, test } from "bun:test";
import { quotaSignal } from "../src/runner-placement/quota";

const now = Date.parse("2026-10-13T12:00:00Z");
test("Quota exhaustion uses explicit reset evidence and keeps unknown cooldown separate", () => {
  expect(quotaSignal("Rate limit exceeded; resets at 2026-10-13T13:30:00Z", now)).toEqual({
    state: "exhausted",
    resetsAt: now + 5_400_000,
    cooldownUntil: now + 5_400_000,
  });
  expect(quotaSignal("You've hit your session limit. Try again in 30 minutes", now)).toEqual({
    state: "exhausted",
    resetsAt: now + 1_800_000,
    cooldownUntil: now + 1_800_000,
  });
  expect(quotaSignal("You've hit your limit. Try again in 2h 30m", now)).toEqual({
    state: "exhausted",
    resetsAt: now + 9_000_000,
    cooldownUntil: now + 9_000_000,
  });
  expect(quotaSignal("HTTP 429\nRetry-After: 120", now)).toEqual({
    state: "exhausted",
    resetsAt: now + 120_000,
    cooldownUntil: now + 120_000,
  });
  expect(quotaSignal("quota_exceeded\nRetry-After: Tue, 13 Oct 2026 14:00:00 GMT", now)).toEqual({
    state: "exhausted",
    resetsAt: now + 7_200_000,
    cooldownUntil: now + 7_200_000,
  });
  expect(quotaSignal("HTTP 429\nRetry-After: 0", now)).toEqual({
    state: "exhausted",
    resetsAt: now,
    cooldownUntil: now,
  });
  expect(quotaSignal("insufficient_quota", now)).toEqual({
    state: "exhausted",
    resetsAt: null,
    cooldownUntil: now + 900_000,
  });
});
test("Quota warning remains usable and ordinary errors cannot invent provider limits", () => {
  expect(quotaSignal("10% remaining", now)).toEqual({
    state: "low",
    resetsAt: null,
    cooldownUntil: now,
  });
  expect(quotaSignal("Usage: 0% remaining", now)?.state).toBe("exhausted");
  for (const text of [
    "Authentication required",
    "Request failed",
    "Quota 75% remaining",
    "Rate limits are configurable",
    "429 records processed",
  ])
    expect(quotaSignal(text, now)).toBeNull();
  expect(quotaSignal("quota exhausted; resets at 2025-10-13T13:30:00Z", now)?.resetsAt).toBeNull();
});
