import { expect, test } from "bun:test";
import { createLinearClient, linearCaller } from "../src/linear";
import { createMetricsRecorder } from "../src/metrics";
import { waitFor } from "./wait-for";

const auth = {
  hasToken: async () => true,
  ensureFresh: async () => "synthetic-linear-token",
  forceRefresh: async () => "synthetic-linear-token",
};

function rows(metrics: ReturnType<typeof createMetricsRecorder>) {
  return metrics
    .drain(Number.POSITIVE_INFINITY)
    .filter(({ name }) => name !== "linear.phase")
    .map(({ name, labels, count, gauge }) => ({ name, labels, count, gauge }));
}

test("a Linear call records its caller, status class and remaining requests", async () => {
  const metrics = createMetricsRecorder();
  const client = createLinearClient({
    auth,
    metrics,
    fetch: async () =>
      Response.json(
        { data: { viewer: { id: "u" } } },
        { headers: { "X-RateLimit-Requests-Remaining": "120" } },
      ),
  });
  expect(await linearCaller("poller", () => client.query("query { viewer { id } }"))).toEqual({
    viewer: { id: "u" },
  });
  expect(rows(metrics)).toEqual([
    {
      name: "linear.call",
      labels: { caller: "poller", status_class: "2xx" },
      count: 1,
      gauge: null,
    },
    { name: "linear.rate_remaining", labels: {}, count: 1, gauge: 120 },
  ]);
});

test("a Linear 429 counts as rate limited and a failed fetch as a network call", async () => {
  const metrics = createMetricsRecorder();
  const limited = createLinearClient({
    auth,
    metrics,
    fetch: async () => Response.json({ errors: [{ message: "RATELIMITED" }] }, { status: 429 }),
  });
  const offline = createLinearClient({
    auth,
    metrics,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const query = (client: typeof limited) =>
    linearCaller("poller", () => client.query("query { viewer { id } }"));
  await expect(query(limited)).rejects.toThrow();
  await expect(query(offline)).rejects.toThrow("fetch failed");
  expect(rows(metrics).map((row) => [row.name, row.labels])).toEqual([
    ["linear.call", { caller: "poller", status_class: "4xx" }],
    ["linear.rate_limited", { caller: "poller" }],
    ["linear.call", { caller: "poller", status_class: "network" }],
  ]);
});

test("a Linear call records the duration of each phase", async () => {
  const metrics = createMetricsRecorder();
  const client = createLinearClient({
    auth,
    metrics,
    fetch: async () => Response.json({ data: { viewer: { id: "u" } } }),
  });
  await client.query("query { viewer { id } }", {}, { signal: new AbortController().signal });
  const phases = metrics
    .drain(Number.POSITIVE_INFINITY)
    .filter(({ name }) => name === "linear.phase")
    .map(({ labels }) => labels["phase"])
    .sort();
  expect(phases).toEqual(["authorize", "body", "current", "fetch", "ledger", "token"]);
});

test("a stalled response body aborts at the deadline and is cancelled", async () => {
  let cancelled = false;
  let requested = false;
  const stalled = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode('{"data":')),
    cancel: () => {
      cancelled = true;
    },
  });
  const client = createLinearClient({
    auth,
    metrics: createMetricsRecorder(),
    fetch: async () => {
      requested = true;
      return new Response(stalled, { headers: { "content-type": "application/json" } });
    },
  });
  const deadline = new AbortController();
  const query = client.query("query { viewer { id } }", {}, { signal: deadline.signal });
  const reason = new DOMException("The operation timed out.", "TimeoutError");
  await waitFor(() => requested);
  deadline.abort(reason);
  await expect(query).rejects.toBe(reason);
  await waitFor(() => cancelled);
});
