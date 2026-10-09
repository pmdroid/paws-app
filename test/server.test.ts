import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server";
import type { StatusReport } from "../src/web";

describe("server", () => {
  test("health, status, webhooks, and unknown paths", async () => {
    const server = startServer({ port: 0, hostname: "127.0.0.1" });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: "paws" });

      const root = await fetch(`${base}/`, { redirect: "manual" });
      expect(root.status).toBe(302);
      expect(root.headers.get("location")).toContain("/status");

      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get("content-type")).toContain("text/html");
      const html = await status.text();
      expect(html).toContain("Paws");
      expect(html).toContain("/api/status");

      const api = await fetch(`${base}/api/status`);
      expect(api.status).toBe(200);
      const body = (await api.json()) as StatusReport;
      expect(body.source).toBe("demo");
      expect(body.service).toBe("paws");
      expect(body.items[0]?.title).toContain("Sample:");

      const missing = await fetch(`${base}/webhooks/linear`, { method: "POST" });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ ok: false, reason: "missing_signature" });

      const unsigned = await fetch(`${base}/webhooks/github`, {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=abc" },
      });
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toEqual({ ok: false, reason: "missing_secret" });

      const other = await fetch(`${base}/metrics`);
      expect(other.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("hosted dashboard requires bearer or basic auth and keeps health open", async () => {
    const token = "dashboard-token-value";
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      hosted: true,
      dashboardToken: token,
    });
    const base = `http://${server.hostname}:${server.port}`;
    const basic = `Basic ${Buffer.from(`paws:${token}`).toString("base64")}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);

      const locked = await fetch(`${base}/api/status`);
      expect(locked.status).toBe(401);
      expect(locked.headers.get("www-authenticate")).toContain("Bearer");
      expect(await locked.json()).toEqual({ ok: false, reason: "unauthorized" });

      const bearer = await fetch(`${base}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.status).toBe(200);
      expect(((await bearer.json()) as StatusReport).source).toBe("demo");

      const password = await fetch(`${base}/status`, {
        headers: { authorization: basic },
      });
      expect(password.status).toBe(200);
      expect(password.headers.get("content-type")).toContain("text/html");

      const wrong = await fetch(`${base}/status`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("hosted mode without a dashboard token fails closed", async () => {
    const server = startServer({ port: 0, hostname: "127.0.0.1", hosted: true });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      expect((await fetch(`${base}/status`)).status).toBe(401);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
