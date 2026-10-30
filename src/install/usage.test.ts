import { expect, test } from "bun:test";
import { claudeLimits, claudeUsageLimits, codexLimits, codexWindow } from "./usage";

test("Claude rate-limit events report the 5-hour and weekly windows as percentages", () => {
  const event = {
    status: "allowed",
    resetsAt: 1792650600,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.16, resetsAt: 1792650600 },
      seven_day: { utilization: 0.03, resetsAt: 1792987200 },
    },
  };
  expect(claudeLimits(event)).toEqual([
    { window: "5-hour", usedPercent: 16, resetsAt: 1792650600_000 },
    { window: "Weekly", usedPercent: 3, resetsAt: 1792987200_000 },
  ]);
});

test("a Claude event without unified windows reports the window it names", () => {
  expect(
    claudeLimits({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.92 }),
  ).toEqual([{ window: "Weekly", usedPercent: 92, resetsAt: null }]);
  expect(claudeLimits({ status: "allowed", rateLimitType: "five_hour" })).toEqual([]);
  expect(claudeLimits({ rateLimitType: "overage", utilization: 0.5 })).toEqual([]);
  for (const value of [undefined, null, "limit", 3, { unifiedWindows: "none" }])
    expect(claudeLimits(value)).toEqual([]);
});

test("Claude /usage reports the session and weekly windows with their reset times", () => {
  const report = {
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 7,
        resets_at: "2026-10-30T19:09:59.676247+00:00",
        is_active: true,
      },
      { kind: "weekly_all", group: "weekly", percent: 106, resets_at: null, is_active: false },
      { kind: "weekly_opus", group: "weekly", percent: 50, resets_at: null },
    ],
    extra_usage: { is_enabled: false },
  };
  expect(claudeUsageLimits(report)).toEqual([
    { window: "5-hour", usedPercent: 7, resetsAt: Date.parse("2026-10-30T19:09:59.676Z") },
    { window: "Weekly", usedPercent: 100, resetsAt: null },
  ]);
  for (const value of [undefined, null, {}, { limits: "none" }, { limits: [{ kind: "session" }] }])
    expect(claudeUsageLimits(value)).toEqual([]);
});

test("Codex rate limits name their window from its duration and clamp the percentage", () => {
  const result = {
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793082749 },
      secondary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null },
      credits: { hasCredits: true, balance: "855.28" },
    },
  };
  expect(codexLimits(result)).toEqual([
    { window: "Weekly", usedPercent: 100, resetsAt: 1793082749_000 },
    { window: "5-hour", usedPercent: 100, resetsAt: null },
  ]);
  expect(codexLimits({ rateLimits: { primary: { usedPercent: 5 }, secondary: null } })).toEqual([]);
  for (const value of [undefined, null, {}, { rateLimits: "none" }])
    expect(codexLimits(value)).toEqual([]);
  expect([300, 1440, 10080, 43200].map(codexWindow)).toEqual([
    "5-hour",
    "1-day",
    "Weekly",
    "30-day",
  ]);
});
