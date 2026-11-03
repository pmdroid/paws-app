import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeStatusProvider, handleStatusRequest, startStatusServer, providerFor } from "../engine";
import type { IssueListResponse } from "../contract";

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

  test("the retired status snapshot routes answer 404", async () => {
    const provider = fakeStatusProvider();
    for (const path of [
      "/api/status",
      "/api/status?slices=items",
      "/api/status/items/PAS-1",
      "/api/issues/PAS-1/attempts/1/checks/x/log",
    ]) {
      const response = await handleStatusRequest(new Request(`http://127.0.0.1${path}`), {
        provider,
      });
      expect(response?.status ?? 404).toBe(404);
    }
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
          generatedAt?: string;
        },
      };
    };

    const tail = await get("/api/issues/PAS-1/attempts/2/checks/unit%20tests/log");
    expect(tail.status).toBe(200);
    expect(tail.body.truncated).toBe(true);
    expect(Buffer.byteLength(tail.body.stdout)).toBe(64 * 1024);
    expect(stdout.endsWith(tail.body.stdout)).toBe(true);
    expect(tail.body.stdout).not.toContain("first line");
    expect(tail.body.stderr).toBe("short");
    expect(tail.body.fullPath).toBe("/api/issues/PAS-1/attempts/2/checks/unit%20tests/log?full=1");

    const full = await get(tail.body.fullPath!);
    const { generatedAt: _generatedAt, ...fullBody } = full.body;
    expect(fullBody).toEqual({ stdout, stderr: "short", truncated: false, fullPath: null });

    await get("/api/issues/PAS-1/attempts/1/checks/lint/log?run=run-7");
    expect(requests).toEqual([
      { itemId: "PAS-1", attempt: 2, checkId: "unit tests", run: null },
      { itemId: "PAS-1", attempt: 2, checkId: "unit tests", run: null },
      { itemId: "PAS-1", attempt: 1, checkId: "lint", run: "run-7" },
    ]);
    for (const path of [
      "/api/issues/PAS-1/attempts/0/checks/lint/log",
      "/api/issues/PAS-1/attempts/x/checks/lint/log",
      "/api/issues/PAS-1/attempts/1/checks/lint",
      "/api/issues/PAS-1/attempts/1/checks/lint/log/more",
    ])
      expect((await get(path)).status).toBe(404);
    expect(requests).toHaveLength(3);
  });

  test("a check the provider does not know answers 404", async () => {
    const response = await handleStatusRequest(
      new Request("http://127.0.0.1/api/issues/PAS-1/attempts/1/checks/lint/log"),
      { provider: fakeStatusProvider() },
    );
    expect(response?.status).toBe(404);
  });

  test("provider selection has only the serving process source", async () => {
    const provider = fakeStatusProvider();
    expect(providerFor({ provider, env: { PAWS_STATUS_DEMO: "1" } })).toBe(provider);
    expect((await providerFor({}).issues!()).source).toBe("live");
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

  test("rejects writes and invalid resource bodies", async () => {
    const method = await handleStatusRequest(
      new Request("http://127.0.0.1/api/issues", { method: "POST" }),
      {
        provider: fakeStatusProvider(),
      },
    );
    expect(method?.status).toBe(405);

    const broken = await handleStatusRequest(new Request("http://127.0.0.1/api/issues"), {
      provider: { issues: () => ({}) as IssueListResponse },
    });
    expect(broken?.status).toBe(500);
  });

  test("always serves live status despite retired demo overrides", async () => {
    const server = startStatusServer({ port: 0, hostname: "127.0.0.1", staticDir: null, env: {} });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const live = await fetch(`${base}/api/issues`);
    expect(live.status).toBe(200);
    const body = (await live.json()) as {
      source: string;
      issues: unknown[];
      project: { name: string };
    };
    expect(body.source).toBe("live");
    expect(body.issues).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Audit log export");

    const demo = await fetch(`${base}/api/issues?engine=demo`);
    const sample = (await demo.json()) as { source: string; issues: unknown[] };
    expect(sample.source).toBe("live");
    expect(sample.issues).toEqual([]);

    const flagged = startStatusServer({
      port: 0,
      hostname: "127.0.0.1",
      staticDir: null,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    servers.push(flagged);
    const forced = await fetch(`http://127.0.0.1:${flagged.port}/api/issues`);
    const forcedBody = (await forced.json()) as { source: string };
    expect(forcedBody.source).toBe("live");
  });

  test("serves /dashboard on loopback and ignores path traversal", async () => {
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
    expect(root.headers.get("location")).toBe("/dashboard/?engine=demo");
    const landing = await fetch(`${base}/?engine=demo`);
    expect(landing.status).toBe(200);
    expect(landing.url).toBe(`${base}/dashboard/?engine=demo`);
    expect(await landing.text()).toContain("status-dashboard");
    const head = await fetch(`${base}/`, { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(307);
    expect(await head.text()).toBe("");
    const write = await fetch(`${base}/`, { method: "POST", redirect: "manual" });
    expect(write.status).toBe(405);

    const page = await fetch(`${base}/dashboard`, { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("status-dashboard");
    expect(html).toContain('<base href="/dashboard/"');

    const slash = await fetch(`${base}/dashboard/`);
    expect(slash.status).toBe(200);
    expect(await slash.text()).toContain('<base href="/dashboard/"');

    const session = await fetch(
      `${base}/dashboard/sessions/1ba8a587-1464-4f23-abec-d6f5a4ac12f0?engine=demo`,
      { redirect: "manual" },
    );
    expect(session.status).toBe(200);
    expect(session.headers.get("location")).toBeNull();
    expect(await session.text()).toContain("status-dashboard");

    await writeFile(
      join(dir, "transcript.html"),
      '<!doctype html><html><head><base href="/" /></head><p>transcript-page</p></html>',
    );
    const transcript = await fetch(`${base}/dashboard/runs/run_01-abc/transcript`);
    expect(transcript.status).toBe(200);
    const transcriptHtml = await transcript.text();
    expect(transcriptHtml).toContain("transcript-page");
    expect(transcriptHtml).toContain('<base href="/dashboard/" />');
    expect(await (await fetch(`${base}/dashboard/runs/run_01-abc/transcript/`)).text()).toContain(
      "transcript-page",
    );
    expect(await (await fetch(`${base}/dashboard/runs/run_01-abc`)).text()).toContain(
      "status-dashboard",
    );

    const escaped = await fetch(`${base}/dashboard/assets/..%2f..%2fpackage.json`);
    expect(escaped.status).toBe(404);

    const other = await fetch(`${base}/webhooks/github`, { method: "POST" });
    expect(other.status).toBe(404);
  });
  test("redirects old /status page links to /dashboard with their queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paws-status-"));
    dirs.push(dir);
    await writeFile(join(dir, "index.html"), "<!doctype html><p>status-dashboard</p>");
    await writeFile(join(dir, "transcript.html"), "<!doctype html><p>transcript-page</p>");
    const server = startStatusServer({ port: 0, hostname: "127.0.0.1", staticDir: dir });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const moved: [string, string][] = [
      ["/status", "/dashboard/"],
      ["/status/", "/dashboard/"],
      ["/status/?engine=demo", "/dashboard/?engine=demo"],
      ["/status/overview", "/dashboard/overview"],
      ["/status/queue", "/dashboard/queue"],
      ["/status/epics", "/dashboard/epics"],
      ["/status/issues", "/dashboard/issues"],
      ["/status/issues/PAS-633?tab=1", "/dashboard/issues/PAS-633?tab=1"],
      ["/status/issues/ENG%2F7", "/dashboard/issues/ENG%2F7"],
      ["/status/questions/q-1", "/dashboard/questions/q-1"],
      ["/status/merge-queue", "/dashboard/merge-queue"],
      [
        "/status/findings?repository=acme%2Fapp&severity=high&review=r&status=all&path=a.ts",
        "/dashboard/findings?repository=acme%2Fapp&severity=high&review=r&status=all&path=a.ts",
      ],
      ["/status/evidence", "/dashboard/evidence"],
      [
        "/status/runners/01JRUNNER0000000000000000A",
        "/dashboard/runners/01JRUNNER0000000000000000A",
      ],
      [
        "/status/settings/integrations?connecting=1",
        "/dashboard/settings/integrations?connecting=1",
      ],
      ["/status/runs", "/dashboard/runs"],
      ["/status/runs/r-1", "/dashboard/runs/r-1"],
      ["/status/runs/run_01-abc/transcript", "/dashboard/runs/run_01-abc/transcript"],
      ["/status/sessions/s-1", "/dashboard/sessions/s-1"],
      ["/status/verdicts/v-1", "/dashboard/verdicts/v-1"],
      ["/status/assets/app.js", "/dashboard/assets/app.js"],
      ["/status//evil.example/x", "/dashboard/evil.example/x"],
    ];
    for (const [from, to] of moved) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${base}${from}`, { method, redirect: "manual" });
        expect([from, method, response.status]).toEqual([from, method, 307]);
        expect(response.headers.get("location")).toBe(to);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    const post = await fetch(`${base}/status/settings/agents`, {
      method: "POST",
      redirect: "manual",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("location")).toBeNull();
    expect((await fetch(`${base}/statuses`, { redirect: "manual" })).status).toBe(404);

    const followed = await fetch(`${base}/status/runs/run_01-abc/transcript`);
    expect(followed.url).toBe(`${base}/dashboard/runs/run_01-abc/transcript`);
    expect(await followed.text()).toContain("transcript-page");
    expect((await fetch(`${base}/status/projects`)).status).toBe(404);
    expect((await fetch(`${base}/status/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/status/settings/unknown`)).status).toBe(200);

    const evidence = await fetch(`${base}/evidence/01JEV1DENCE0000000000000AB?t=3`, {
      redirect: "manual",
    });
    expect(evidence.status).toBe(307);
    expect(evidence.headers.get("location")).toBe(
      "/dashboard/evidence/01JEV1DENCE0000000000000AB?t=3",
    );
  });
});
