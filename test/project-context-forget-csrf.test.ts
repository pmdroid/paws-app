import { afterAll, beforeAll, expect, test } from "bun:test";
import { startDashboardFixture, type DashboardFixture } from "./dashboard-fixture";

let f: DashboardFixture;
const reached: string[] = [];

beforeAll(async () => {
  f = await startDashboardFixture({
    projectContext: async (request) => {
      reached.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ status: "forgotten", forgotten: { entries: 1 } });
    },
  });
});
afterAll(async () => {
  await f.close();
});

test("forgetting a context entry needs the session's CSRF token and the workspace origin", async () => {
  const path = "/api/context/project/p1/records/r1/forget";
  const post = (headers: Record<string, string>) =>
    fetch(`${f.origin}${path}`, { method: "POST", headers: { cookie: f.cookie, ...headers } });
  expect((await post({ origin: f.origin })).status).toBe(403);
  expect((await post({ origin: f.origin, "x-paws-csrf": "forged" })).status).toBe(403);
  expect((await post({ origin: "https://evil.example", "x-paws-csrf": f.csrfToken })).status).toBe(
    403,
  );
  expect(reached).toEqual([]);
  expect((await post({ origin: f.origin, "x-paws-csrf": f.csrfToken })).status).toBe(200);
  expect(reached).toEqual([`POST ${path}`]);
});
