import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fakeStatusProvider, handleStatusRequest, startStatusServer } from "../engine";
import type { StatusSnapshot } from "../contract";

const servers: Array<{ stop: (close?: boolean) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers) server.stop(true);
  servers.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("status HTTP stub", () => {
  test("GET /api/status returns the sample snapshot and allows the static site to read it", async () => {
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      provider: fakeStatusProvider(),
    });
    expect(response).not.toBeNull();
    if (!response) return;
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as { source: string; items: unknown[] };
    expect(body.source).toBe("demo");
    expect(body.items.length).toBeGreaterThan(0);
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

  test("defaults to an empty live snapshot and serves demo only when asked", async () => {
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
    expect(sample.source).toBe("demo");
    expect(sample.items.length).toBeGreaterThan(0);

    const flagged = startStatusServer({
      port: 0,
      hostname: "127.0.0.1",
      staticDir: null,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    servers.push(flagged);
    const forced = await fetch(`http://127.0.0.1:${flagged.port}/api/status`);
    const forcedBody = (await forced.json()) as { source: string };
    expect(forcedBody.source).toBe("demo");
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
