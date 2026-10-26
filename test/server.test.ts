import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server";

describe("server", () => {
  test("health, status, webhooks, and unknown paths", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      webhooks: false,
      runnerHostEnrollment: async () => Response.json({ enrollment: true }),
    });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({
        ok: false,
        service: "paws",
        failedChecks: ["database"],
      });

      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get("content-type")).toContain("text/html");
      expect(await status.text()).toContain("Paws");

      const api = await fetch(`${base}/api/status`);
      expect(api.status).toBe(200);
      expect(api.headers.get("content-type")).toContain("application/json");
      expect(api.headers.get("access-control-allow-origin")).toBe("*");
      const snapshot = await api.json();
      expect(snapshot).toMatchObject({ version: 1, source: "demo" });

      const missing = await fetch(`${base}/webhooks/linear`, { method: "POST" });
      expect(missing.status).toBe(404);

      const runners = await fetch(`${base}/api/runners`);
      expect(runners.status).toBe(200);
      expect(await runners.json()).toEqual({
        runners: [],
        setupRequired: true,
        workspaceReady: false,
      });
      for (const path of [
        "/api/runner-pairings",
        "/api/runners/pairings/inspect",
        "/api/runners/pairings/approve",
      ]) {
        const removed = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "0123456789abcdef" }),
        });
        expect(removed.status).toBe(404);
      }

      const github = await fetch(`${base}/webhooks/github`, {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=abc" },
      });
      expect(github.status).toBe(404);

      const nested = await fetch(`${base}/webhooks/linear/extra`);
      expect(nested.status).toBe(404);

      const githubSignIn = await fetch(`${base}/api/auth/github`);
      expect(githubSignIn.status).toBe(404);
      const githubDevice = await fetch(`${base}/api/auth/github/device`, { method: "POST" });
      expect(githubDevice.status).toBe(404);

      const other = await fetch(`${base}/metrics`);
      expect(other.status).toBe(404);
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });

  test("webhook routes fail closed when linear.webhooks is on", async () => {
    const server = startServer({ port: 0, hostname: "127.0.0.1", webhooks: true });
    const base = `http://${server.hostname}:${server.port}`;
    try {
      const missing = await fetch(`${base}/webhooks/linear`, { method: "POST" });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ ok: false, reason: "missing_signature" });

      const unsigned = await fetch(`${base}/webhooks/github`, {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=abc" },
      });
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toEqual({ ok: false, reason: "missing_secret" });
    } finally {
      server.stop(true);
    }
  });
});
