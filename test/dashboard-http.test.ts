import { afterAll, beforeAll, expect, test } from "bun:test";
import { startDashboardFixture, type DashboardFixture } from "./dashboard-fixture";

let f: DashboardFixture;
beforeAll(async () => {
  f = await startDashboardFixture();
});
afterAll(async () => {
  await f.close();
});

const get = (path: string, headers: Record<string, string> = {}, signedIn = true) =>
  fetch(`${f.origin}${f.fill(path)}`, {
    redirect: "manual",
    headers: signedIn ? { cookie: f.cookie, ...headers } : headers,
  });

const LISTS = [
  "/api/overview",
  "/api/issues",
  "/api/questions",
  "/api/merge-queue",
  "/api/evidence",
];
const DETAILS = (item: string) => [
  `/api/issues/${item}`,
  `/api/questions/q-${item}`,
  `/api/evidence/${f.evidence[item]}/metadata`,
  `/api/aliases/runs/${f.runs[item]}`,
  `/api/aliases/sessions/session-${item === "PAS-1" ? "mine" : "other"}`,
  `/api/aliases/verdicts/${item}`,
];

const MINE = ["PAS-1", "PAS-3"];
const OTHER = ["PAS-2", "PAS-4"];

async function readers(path: string): Promise<string> {
  const body = await (await get(path)).text();
  const mine = MINE.some((item) => body.includes(item));
  const other = OTHER.some((item) => body.includes(item));
  return mine && other ? "both" : mine ? "mine" : other ? "other" : "none";
}

test("anonymous readers get 401 from every resource and the sign-in page from every page", async () => {
  for (const path of [...LISTS, ...DETAILS("PAS-1"), "/api/issues/PAS-1/attempts/1/checks/x/log"])
    expect([path, (await get(path, {}, false)).status]).toEqual([path, 401]);
  const page = await get("/dashboard/issues/PAS-1", {}, false);
  expect(page.status).toBe(200);
  expect(await page.text()).not.toContain("PAS-1");
});

test("lists and details show only the member's sessions; a hidden item is an unknown one", async () => {
  for (const path of LISTS) expect([path, await readers(path)]).toEqual([path, "mine"]);
  for (const path of DETAILS("PAS-1"))
    expect([path, (await get(path)).status]).toEqual([path, 200]);
  const unknown = [
    "/api/issues/PAS-404",
    "/api/questions/q-404",
    "/api/evidence/01JEV1DENCE0000000000000AB/metadata",
    "/api/aliases/runs/run-404",
    "/api/aliases/sessions/session-404",
    "/api/aliases/verdicts/PAS-404",
  ];
  const hidden = DETAILS("PAS-2");
  for (const [index, path] of hidden.entries()) {
    const response = await get(path);
    const missing = await get(unknown[index]!);
    expect([path, response.status]).toEqual([path, 404]);
    expect(await response.text()).toBe(await missing.text());
  }
  const transcript = await get(`/api/runs/transcript?run=${f.runs["PAS-2"]}`);
  expect(transcript.status).toBe(404);
  expect((await get(`/api/evidence/${f.evidence["PAS-2"]}`)).status).toBe(404);
  expect((await get("/api/issues", { "x-paws-workspace": "elsewhere" })).status).toBe(403);
  expect((await get("/api/issues?workspaceId=elsewhere")).status).toBe(403);
});

test("a membership change applies through warm caches and stored ETags", async () => {
  const tags = new Map<string, string>();
  for (const path of [...LISTS, ...DETAILS("PAS-1")]) {
    const response = await get(path);
    expect(response.status).toBe(200);
    if (response.headers.get("etag")) tags.set(path, response.headers.get("etag")!);
    expect((await get(path, { "if-none-match": tags.get(path) ?? "" })).status).toBe(
      tags.has(path) ? 304 : 200,
    );
  }
  await f.revoke();
  for (const path of LISTS) {
    const response = await get(path, { "if-none-match": tags.get(path)! });
    expect([path, response.status]).toEqual([path, 200]);
    expect([path, await readers(path)]).toEqual([path, "other"]);
  }
  for (const path of DETAILS("PAS-1"))
    expect([path, (await get(path, { "if-none-match": tags.get(path) ?? "" })).status]).toEqual([
      path,
      404,
    ]);
  for (const path of DETAILS("PAS-2"))
    expect([path, (await get(path)).status]).toEqual([path, 200]);
});

test("mutations need the session's CSRF token and the workspace origin", async () => {
  for (const path of ["/api/link-asks", "/api/execution-controls", "/api/questions/answer"]) {
    const post = (headers: Record<string, string>) =>
      fetch(`${f.origin}${path}`, {
        method: "POST",
        headers: { cookie: f.cookie, "content-type": "application/json", ...headers },
        body: "{}",
      });
    expect([path, (await post({ origin: f.origin })).status]).toEqual([path, 403]);
    expect([
      path,
      (await post({ origin: "https://evil.example", "x-paws-csrf": f.csrfToken })).status,
    ]).toEqual([path, 403]);
    expect((await post({ origin: f.origin, "x-paws-csrf": f.csrfToken })).status).not.toBe(403);
  }
});

test("old links redirect to the same dashboard page and the page loads on a direct refresh", async () => {
  const links: Array<[string, string]> = [
    ["/", "/dashboard/"],
    ["/?engine=live", "/dashboard/?engine=live"],
    ["/status", "/dashboard/"],
    ["/status/", "/dashboard/"],
    ["/status/issues/PAS-1?from=linear", "/dashboard/issues/PAS-1?from=linear"],
    ["/status/questions/q-PAS-1", "/dashboard/questions/q-PAS-1"],
    ["/status/runs/{run}", "/dashboard/runs/{run}"],
    ["/status/sessions/session-mine", "/dashboard/sessions/session-mine"],
    ["/status/verdicts/PAS-1", "/dashboard/verdicts/PAS-1"],
    ["/status/runs/{run}/transcript", "/dashboard/runs/{run}/transcript"],
    ["/status/merge-queue", "/dashboard/merge-queue"],
    ["/status/queue", "/dashboard/queue"],
    ["/status/epics", "/dashboard/epics"],
    ["/status/evidence/{evidence}", "/dashboard/evidence/{evidence}"],
    ["/status/settings/integrations", "/dashboard/settings/integrations"],
    ["/status//evil.example/x", "/dashboard/evil.example/x"],
    ["/evidence/{evidence}?t=3", "/dashboard/evidence/{evidence}?t=3"],
  ];
  for (const [from, to] of links) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${f.origin}${f.fill(from)}`, {
        method,
        redirect: "manual",
        headers: { cookie: f.cookie },
      });
      expect([method, from, response.status, response.headers.get("location")]).toEqual([
        method,
        from,
        307,
        f.fill(to),
      ]);
    }
    const page = await get(to);
    expect([to, page.status]).toEqual([to, 200]);
    expect(await page.text()).toContain('<base href="/dashboard/" />');
  }
  for (const path of ["/status/issues/PAS-1", "/evidence/{evidence}"])
    expect((await fetch(`${f.origin}${f.fill(path)}`, { method: "POST" })).status).toBe(405);
  for (const path of ["/api/status", "/api/status?slices=items", "/api/status/items/PAS-1"])
    expect([path, (await get(path)).status]).toEqual([path, 404]);
});
