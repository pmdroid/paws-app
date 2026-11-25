import { afterEach, expect, test } from "bun:test";
import type { MetricLabels } from "../src/metrics";
import { startServer } from "../src/server";
import { DASHBOARD_ROUTES } from "./dashboard-routes";

type Recorded = { name: string; labels: MetricLabels; value: number };

const CATCH_ALLS = [
  "/api/*",
  "/api/settings/*",
  "/api/retros/*",
  "/api/improvements/*",
  "/api/notebooks/*",
  "/webhooks/*",
];

let server: ReturnType<typeof startServer> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

function serve(respond: (path: string) => Response | Promise<Response>) {
  const recorded: Recorded[] = [];
  server = startServer({
    port: 0,
    metrics: { recordDuration: (name, labels, value) => recorded.push({ name, labels, value }) },
    onboarding: async (request) => respond(new URL(request.url).pathname),
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { recorded, base };
}

async function settled(recorded: Recorded[], count: number) {
  for (let tries = 0; recorded.length < count && tries < 100; tries++) await Bun.sleep(5);
}

test("an issue request records the route pattern, never the id", async () => {
  const { recorded, base } = serve(() => Response.json({ title: "Fix the thing" }));
  const response = await fetch(`${base}/api/issues/01JABCDEF0000000000000000X`);
  expect(await response.json()).toEqual({ title: "Fix the thing" });
  await settled(recorded, 2);
  const labels = { route: "/api/issues/:id", method: "GET", status_class: "2xx" };
  expect(recorded.find((entry) => entry.name === "http.request")?.labels).toEqual(labels);
  expect(recorded.find((entry) => entry.name === "http.response_bytes")).toEqual({
    name: "http.response_bytes",
    labels,
    value: JSON.stringify({ title: "Fix the thing" }).length,
  });
  expect(JSON.stringify(recorded)).not.toContain("01JABCDEF");
});

test("a 500 response records the 5xx status class", async () => {
  const { recorded, base } = serve(() => new Response("boom", { status: 500 }));
  const response = await fetch(`${base}/webhooks/linear`, { method: "POST", body: "{}" });
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("boom");
  await settled(recorded, 2);
  expect(recorded.map((entry) => [entry.name, entry.labels])).toEqual([
    ["http.request", { route: "/webhooks/linear", method: "POST", status_class: "5xx" }],
    ["http.response_bytes", { route: "/webhooks/linear", method: "POST", status_class: "5xx" }],
  ]);
});

test("unknown paths record route other", async () => {
  const { recorded, base } = serve(() => new Response("missing", { status: 404 }));
  expect((await fetch(`${base}/nowhere/secret-123`)).status).toBe(404);
  expect((await fetch(`${base}/api/unknown/thing`, { method: "DELETE" })).status).toBe(404);
  await settled(recorded, 4);
  const requests = recorded.filter((entry) => entry.name === "http.request");
  expect(requests.map((entry) => entry.labels)).toEqual([
    { route: "other", method: "GET", status_class: "4xx" },
    { route: "other", method: "DELETE", status_class: "4xx" },
  ]);
});

test("a streamed body is measured and still delivered whole", async () => {
  const chunks = ["first,", "second,", "third"];
  const { recorded, base } = serve(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
      ),
  );
  const response = await fetch(`${base}/dashboard/runs/01JRUN/transcript`);
  expect(await response.text()).toBe(chunks.join(""));
  await settled(recorded, 2);
  expect(recorded.find((entry) => entry.name === "http.response_bytes")?.value).toBe(
    chunks.join("").length,
  );
  expect(recorded[0]?.labels.route).toBe("/dashboard/runs/:id/transcript");
});

test("every HTTP route in the route map records its own pattern", async () => {
  const { recorded, base } = serve(() => new Response(null, { status: 204 }));
  const patterns = [
    ...new Set(
      DASHBOARD_ROUTES.filter((entry) => entry.surface === "http").map((entry) => entry.pattern),
    ),
  ].filter((pattern) => !CATCH_ALLS.includes(pattern));
  const sample = (pattern: string) => pattern.replace(/:[a-z]+/g, "PAS-1").replace(/\/\*$/, "/x/y");
  for (const pattern of patterns) await fetch(`${base}${sample(pattern)}`);
  await settled(recorded, patterns.length * 2);
  const routes = recorded
    .filter((entry) => entry.name === "http.request")
    .map((entry) => entry.labels.route);
  expect(routes).toEqual(patterns);
});
