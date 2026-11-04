import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ALIAS_KINDS } from "../src/dashboard/src/aliases";
import { matchRoute } from "../src/dashboard/src/client/route";
import { SETTINGS_PAGES } from "../src/dashboard/src/client/settings-pages";
import { startDashboardFixture, type DashboardFixture } from "./dashboard-fixture";
import {
  DASHBOARD_ROUTES,
  htmlEntrypoints,
  normalizeRoute,
  routeHeads,
  routeMatches,
  sourceRoutes,
} from "./dashboard-routes";

const ROOT = join(import.meta.dir, "..");
const http = DASHBOARD_ROUTES.filter((entry) => entry.surface === "http");
const pages = DASHBOARD_ROUTES.filter(
  (entry) => entry.surface === "spa" || entry.surface === "settings",
);
const sample = (pattern: string) => pattern.replace(/:[a-z]+/g, "PAS-1");
const head = (pattern: string) => pattern.split("/")[1] ?? "";

describe("dashboard route coverage", () => {
  test("every route the source names maps to an entry", () => {
    const unmapped = sourceRoutes(ROOT)
      .filter(
        (route) =>
          !http.some(
            (entry) =>
              routeMatches(entry.pattern, route.path) ||
              (typeof entry.via === "string" && routeMatches(entry.via, route.path)),
          ),
      )
      .map((route) => `${route.path} (${route.file})`);
    expect(unmapped).toEqual([]);
  });

  test("every HTTP entry still has a source registration", () => {
    const found = sourceRoutes(ROOT).map((route) => route.path);
    const stale = http
      .filter((entry) => entry.via !== null)
      .filter((entry) => !found.some((path) => routeMatches(entry.via ?? entry.pattern, path)))
      .map((entry) => `${entry.method} ${entry.pattern}`);
    expect(stale).toEqual([]);
  });

  test("entries are unique and name an owner", () => {
    const keys = DASHBOARD_ROUTES.map(
      (entry) => `${entry.surface} ${entry.method} ${entry.pattern}`,
    );
    expect(keys.length).toBe(new Set(keys).size);
    for (const entry of DASHBOARD_ROUTES) expect(entry.owner).toMatch(/^(PAS-\d+|src\/[a-z-]+)$/);
  });

  test("SPA heads match matchRoute and each entry opens its view", () => {
    const heads = [...routeHeads(ROOT), ...ALIAS_KINDS].sort();
    const mapped = [...new Set(pages.map((entry) => head(entry.pattern)))].sort();
    expect(mapped).toEqual(heads);
    for (const entry of pages)
      expect([entry.pattern, matchRoute(sample(entry.pattern))?.view]).toEqual([
        entry.pattern,
        entry.view,
      ]);
  });

  test("settings entries are the settings registry", () => {
    const mapped = DASHBOARD_ROUTES.filter((entry) => entry.surface === "settings").map(
      (entry) => entry.pattern,
    );
    expect(mapped).toEqual(SETTINGS_PAGES.map((page) => `/settings/${page.id}`));
  });

  test("HTML entrypoints are mapped", () => {
    const mapped = DASHBOARD_ROUTES.filter((entry) => entry.surface === "html")
      .map((entry) => entry.pattern)
      .sort();
    expect(mapped).toEqual(htmlEntrypoints(ROOT));
  });

  test("source paths normalize to their route shape", () => {
    expect(normalizeRoute("/api/runners/${encodeURIComponent(id)}/policy")).toBe(
      "/api/runners/:param/policy",
    );
    expect(normalizeRoute("\\/api\\/runners\\/([0-9A-Z]{26})\\/status$")).toBe(
      "/api/runners/:param/status",
    );
    expect(normalizeRoute("/api/workspaces/audit${append}")).toBe("/api/workspaces/audit");
    expect(normalizeRoute("/onboard/[A-Za-z0-9]{26}")).toBe("/onboard/:param");
    expect(normalizeRoute("/api/closeout-artifact?${params}")).toBe("/api/closeout-artifact");
  });
});

describe("dashboard routes on the production server", () => {
  let fixture: DashboardFixture;
  beforeAll(async () => {
    fixture = await startDashboardFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  const request = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${fixture.origin}${fixture.fill(path)}`, {
      method: method === "*" ? "GET" : method.split(" ")[0],
      redirect: "manual",
      headers,
    });

  test("anonymous requests answer each entry's status", async () => {
    const observed: string[] = [];
    const expected: string[] = [];
    for (const entry of http) {
      if (entry.sample === undefined) continue;
      const status = entry.anonymous ?? (entry.sample.startsWith("/api/") ? 401 : undefined);
      if (status === undefined) continue;
      const response = await request(entry.method, entry.sample);
      observed.push(`${entry.method} ${entry.sample} ${response.status}`);
      expected.push(`${entry.method} ${entry.sample} ${status}`);
    }
    expect(observed).toEqual(expected);
  });

  test("a member's requests answer each entry's status", async () => {
    const observed: string[] = [];
    const expected: string[] = [];
    for (const entry of http) {
      if (entry.sample === undefined || entry.member === undefined) continue;
      const response = await request(entry.method, entry.sample, { cookie: fixture.cookie });
      observed.push(`${entry.method} ${entry.sample} ${response.status}`);
      expected.push(`${entry.method} ${entry.sample} ${entry.member}`);
    }
    expect(observed).toEqual(expected);
  });
});
