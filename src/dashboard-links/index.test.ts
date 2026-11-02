import { expect, test } from "bun:test";
import {
  dashboardIssuePath,
  dashboardPath,
  dashboardUrl,
  isDashboardPage,
  isDashboardPath,
  legacyDashboardLocation,
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

test("only dashboard pages and old status links are dashboard pages", () => {
  for (const path of ["/", "/dashboard", "/dashboard/issues", "/status", "/status/runs/r-1"])
    expect(isDashboardPage(path)).toBe(true);
  for (const path of ["/dashboards", "/statuses", "/api/status", "/health", "/onboard/x"])
    expect(isDashboardPage(path)).toBe(false);
  expect(isDashboardPath("/status/issues")).toBe(false);
});

test("old status links map to the same page under /dashboard on this origin", () => {
  expect(legacyDashboardLocation("/status")).toBe("/dashboard/");
  expect(legacyDashboardLocation("/status/", "?engine=demo")).toBe("/dashboard/?engine=demo");
  expect(legacyDashboardLocation("/status/findings", "?status=all")).toBe(
    "/dashboard/findings?status=all",
  );
  expect(legacyDashboardLocation("/status//evil.example/x")).toBe("/dashboard/evil.example/x");
  expect(legacyDashboardLocation("/statuses")).toBeNull();
  expect(legacyDashboardLocation("/dashboard/issues")).toBeNull();
});
