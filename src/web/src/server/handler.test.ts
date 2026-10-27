import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeStatusProvider, handleStatusRequest, startStatusServer, providerFor } from "../engine";
import { parseStatusSnapshot, type StatusSnapshot } from "../contract";
import { fullStatusFixture, statusList } from "../../test/fixtures";

const servers: Array<{ stop: (close?: boolean) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("status HTTP stub", () => {
  test("the Conversations API is gone, so the status handler leaves it unrouted", async () => {
    const response = await handleStatusRequest(
      new Request("http://127.0.0.1:8787/api/linear/conversations"),
      { provider: fakeStatusProvider() },
    );
    expect(response).toBeNull();
  });

  test("GET /api/status returns the serving process snapshot", async () => {
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      provider: fakeStatusProvider(),
    });
    expect(response).not.toBeNull();
    if (!response) return;
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as { source: string; items: unknown[] };
    expect(body.source).toBe("live");
    expect(body.items).toEqual([]);
  });

  test("?slices= answers only the named slices, with an ETag that a 304 honours", async () => {
    let generatedAt = "2026-10-27T10:00:00.000Z";
    let full = fullStatusFixture();
    const provider = {
      ...fakeStatusProvider(),
      snapshot: () => ({ ...statusList(full), generatedAt }),
    };
    const get = (path: string, etag?: string) =>
      handleStatusRequest(
        new Request(`http://127.0.0.1${path}`, etag ? { headers: { "If-None-Match": etag } } : {}),
        { provider },
      ) as Promise<Response>;

    const sliced = await get("/api/status?slices=mergeQueue,items");
    expect(sliced.status).toBe(200);
    const body = (await sliced.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "version",
        "source",
        "generatedAt",
        "project",
        "slices",
        "items",
        "runs",
        "verdicts",
        "agentCloseout",
        "mergeQueue",
      ].sort(),
    );
    expect(body.slices).toEqual(["items", "mergeQueue"]);
    expect((body.items as unknown[]).length).toBeGreaterThan(0);
    const parsed = parseStatusSnapshot(body);
    expect(parsed.ok && parsed.snapshot.questions).toEqual([]);

    const evidence = (await (await get("/api/status?slices=evidence")).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(evidence)).not.toContain("items");
    expect(Object.keys(evidence)).not.toContain("questions");
    expect(evidence.slices).toEqual(["evidence"]);

    const etag = sliced.headers.get("etag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    expect(sliced.headers.get("paws-generated-at")).toBe(generatedAt);

    // A newer read of the same list is a 304 that carries the new time.
    generatedAt = "2026-10-27T10:00:05.000Z";
    const unchanged = await get("/api/status?slices=items,mergeQueue", etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("paws-generated-at")).toBe(generatedAt);

    // Another slice set, or a change inside the slices, is a new body.
    expect((await get("/api/status?slices=items", etag)).status).toBe(200);
    full = { ...full, mergeQueue: [] };
    const changed = await get("/api/status?slices=items,mergeQueue", etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);

    // The whole list still answers without the query, and an unknown slice is refused.
    const whole = (await (await get("/api/status")).json()) as Record<string, unknown>;
    expect(whole.slices).toBeUndefined();
    expect(whole.questions).toBeDefined();
    expect((await get("/api/status?slices=items,everything")).status).toBe(400);
  });

  test("a check log is the last 64 KB of each stream unless the full log is asked for", async () => {
    const requests: unknown[] = [];
    // Two-byte characters, so the cut has to land on a character boundary.
    const stdout = `${"first line\n"}${"é".repeat(40_000)}`;
    const provider = {
      ...fakeStatusProvider(),
      checkLog(request: unknown) {
        requests.push(request);
        return { stdout, stderr: "short" };
      },
    };
    const get = async (path: string) => {
      const response = (await handleStatusRequest(new Request(`http://127.0.0.1${path}`), {
        provider,
      }))!;
      return {
        status: response.status,
        body: (await response.json()) as {
          stdout: string;
          stderr: string;
          truncated: boolean;
          fullPath: string | null;
        },
      };
    };

    const tail = await get("/api/status/items/PAS-1/attempts/2/checks/unit%20tests/log");
    expect(tail.status).toBe(200);
    expect(tail.body.truncated).toBe(true);
    expect(Buffer.byteLength(tail.body.stdout)).toBe(64 * 1024);
    expect(stdout.endsWith(tail.body.stdout)).toBe(true);
    expect(tail.body.stdout).not.toContain("first line");
    expect(tail.body.stderr).toBe("short");
    expect(tail.body.fullPath).toBe(
      "/api/status/items/PAS-1/attempts/2/checks/unit%20tests/log?full=1",
    );

    const full = await get(tail.body.fullPath!);
    expect(full.body).toEqual({ stdout, stderr: "short", truncated: false, fullPath: null });

    await get("/api/status/items/PAS-1/attempts/1/checks/lint/log?run=run-7");
    expect(requests).toEqual([
      { itemId: "PAS-1", attempt: 2, checkId: "unit tests", run: null },
      { itemId: "PAS-1", attempt: 2, checkId: "unit tests", run: null },
      { itemId: "PAS-1", attempt: 1, checkId: "lint", run: "run-7" },
    ]);
    for (const path of [
      "/api/status/items/PAS-1/attempts/0/checks/lint/log",
      "/api/status/items/PAS-1/attempts/x/checks/lint/log",
      "/api/status/items/PAS-1/attempts/1/checks/lint",
      "/api/status/items/PAS-1/attempts/1/checks/lint/log/more",
    ])
      expect((await get(path)).status).toBe(404);
    expect(requests).toHaveLength(3);
  });

  test("a check the provider does not know answers 404", async () => {
    const response = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status/items/PAS-1/attempts/1/checks/lint/log"),
      { provider: fakeStatusProvider() },
    );
    expect(response?.status).toBe(404);
  });

  test("provider selection has only the serving process source", async () => {
    const provider = fakeStatusProvider();
    expect(providerFor({ provider, env: { PAWS_STATUS_DEMO: "1" } })).toBe(provider);
    expect((await providerFor({}).snapshot()).source).toBe("live");
  });

  test("leaves engine routes it does not own", async () => {
    const response = await handleStatusRequest(
      new Request("http://127.0.0.1/webhooks/linear", { method: "POST" }),
      {
        provider: fakeStatusProvider(),
      },
    );
    expect(response).toBeNull();
  });

  test("rejects writes and invalid snapshots", async () => {
    const method = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status", { method: "POST" }),
      {
        provider: fakeStatusProvider(),
      },
    );
    expect(method?.status).toBe(405);

    const broken = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      provider: { snapshot: () => ({}) as StatusSnapshot },
    });
    expect(broken?.status).toBe(500);
  });

  test("always serves live status despite retired demo overrides", async () => {
    const server = startStatusServer({ port: 0, hostname: "127.0.0.1", staticDir: null, env: {} });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const live = await fetch(`${base}/api/status`);
    expect(live.status).toBe(200);
    const body = (await live.json()) as {
      source: string;
      items: unknown[];
      project: { name: string };
    };
    expect(body.source).toBe("live");
    expect(body.items).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Audit log export");

    const demo = await fetch(`${base}/api/status?engine=demo`);
    const sample = (await demo.json()) as { source: string; items: unknown[] };
    expect(sample.source).toBe("live");
    expect(sample.items).toEqual([]);

    const flagged = startStatusServer({
      port: 0,
      hostname: "127.0.0.1",
      staticDir: null,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    servers.push(flagged);
    const forced = await fetch(`http://127.0.0.1:${flagged.port}/api/status`);
    const forcedBody = (await forced.json()) as { source: string };
    expect(forcedBody.source).toBe("live");
  });

  test("serves /status on loopback and ignores path traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paws-status-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><title>Paws status</title><p>status-dashboard</p>",
    );
    const server = startStatusServer({ port: 0, hostname: "127.0.0.1", staticDir: dir });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const root = await fetch(`${base}/?engine=demo`, { redirect: "manual" });
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe("/status/?engine=demo");
    const landing = await fetch(`${base}/?engine=demo`);
    expect(landing.status).toBe(200);
    expect(landing.url).toBe(`${base}/status/?engine=demo`);
    expect(await landing.text()).toContain("status-dashboard");
    const head = await fetch(`${base}/`, { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(307);
    expect(await head.text()).toBe("");
    const write = await fetch(`${base}/`, { method: "POST", redirect: "manual" });
    expect(write.status).toBe(405);

    const page = await fetch(`${base}/status`, { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("status-dashboard");
    expect(html).toContain('<base href="/status/"');

    const slash = await fetch(`${base}/status/`);
    expect(slash.status).toBe(200);
    expect(await slash.text()).toContain('<base href="/status/"');

    const session = await fetch(
      `${base}/status/sessions/1ba8a587-1464-4f23-abec-d6f5a4ac12f0?engine=demo`,
      { redirect: "manual" },
    );
    expect(session.status).toBe(200);
    expect(session.headers.get("location")).toBeNull();
    expect(await session.text()).toContain("status-dashboard");

    await writeFile(
      join(dir, "transcript.html"),
      '<!doctype html><html><head><base href="/" /></head><p>transcript-page</p></html>',
    );
    const transcript = await fetch(`${base}/status/runs/run_01-abc/transcript`);
    expect(transcript.status).toBe(200);
    const transcriptHtml = await transcript.text();
    expect(transcriptHtml).toContain("transcript-page");
    expect(transcriptHtml).toContain('<base href="/status/" />');
    expect(await (await fetch(`${base}/status/runs/run_01-abc/transcript/`)).text()).toContain(
      "transcript-page",
    );
    expect(await (await fetch(`${base}/status/runs/run_01-abc`)).text()).toContain(
      "status-dashboard",
    );

    const escaped = await fetch(`${base}/status/assets/..%2f..%2fpackage.json`);
    expect(escaped.status).toBe(404);

    const other = await fetch(`${base}/webhooks/github`, { method: "POST" });
    expect(other.status).toBe(404);
  });
});
