import { expect, test } from "bun:test";
import {
  dashboardIssuePath,
  dashboardPath,
  dashboardUrl,
  isDashboardPage,
  isDashboardPath,
} from ".";

test("dashboard links use the canonical path", () => {
  expect(dashboardPath()).toBe("/dashboard/");
  expect(dashboardPath("/settings/account")).toBe("/dashboard/settings/account");
  expect(dashboardUrl("https://paws.example/", "/runners")).toBe(
    "https://paws.example/dashboard/runners",
  );
  expect(dashboardUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/dashboard/");
  expect(dashboardIssuePath("ENG/7")).toBe("/dashboard/issues/ENG%2F7");
});

test("only current dashboard paths are dashboard pages", () => {
  for (const path of ["/", "/dashboard", "/dashboard/issues"])
    expect(isDashboardPage(path)).toBe(true);
  for (const path of [
    "/status",
    "/status/",
    "/status/issues/PAS-1",
    "/dashboards",
    "/statuses",
    "/api/status",
    "/health",
    "/onboard/x",
  ])
    expect(isDashboardPage(path)).toBe(false);
  expect(isDashboardPath("/status/issues")).toBe(false);
});
