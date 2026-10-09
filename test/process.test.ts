import { describe, expect, test } from "bun:test";
import { insertQueuedItem } from "../src/db";
import { startPaws } from "../src/index";
import type { StatusReport } from "../src/web";
import { tempHome } from "./helpers";

describe("process", () => {
  test("startPaws migrates and serves health", async () => {
    const home = tempHome();
    const paws = startPaws({ PAWS_HOME: home, PAWS_PORT: "0", PAWS_HOST: "127.0.0.1" });
    try {
      const health = await fetch(`http://${paws.server.hostname}:${paws.server.port}/health`);
      expect(health.status).toBe(200);
      expect(paws.paths.db.startsWith(home)).toBe(true);
    } finally {
      paws.stop();
    }
  });

  test("bun src/index.ts prints ready", async () => {
    const home = tempHome();
    const env: Record<string, string | undefined> = {
      ...process.env,
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
    };
    for (const key of [
      "LINEAR_ACCESS_TOKEN",
      "LINEAR_REFRESH_TOKEN",
      "LINEAR_CLIENT_ID",
      "LINEAR_CLIENT_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "NGROK_AUTHTOKEN",
      "PAWS_PUBLIC_URL",
      "PAWS_NO_TUNNEL",
    ]) {
      delete env[key];
    }
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await readUntil(proc, "paws ready", 5000);
    proc.kill();
    await proc.exited;
    expect(text).toContain("paws ready · http://127.0.0.1:");
  });

  test("hosted mode skips ngrok and serves engine status", async () => {
    const home = tempHome();
    const paws = startPaws({
      PAWS_MODE: "hosted",
      PAWS_HOME: home,
      PAWS_HOST: "127.0.0.1",
      PORT: "0",
      RAILWAY_PUBLIC_DOMAIN: "paws.up.railway.app",
      PAWS_DASHBOARD_TOKEN: "dashboard-token-value",
    });
    try {
      expect(paws.env.hosted).toBe(true);
      expect(paws.env.publicUrl).toBe("https://paws.up.railway.app");
      expect(paws.tunnelRequested).toBe(false);
      insertQueuedItem(paws.db, { id: "eng-1", title: "Ship hosted mode" });
      const response = await fetch(
        `http://${paws.server.hostname}:${paws.server.port}/api/status`,
        { headers: { authorization: "Bearer dashboard-token-value" } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as StatusReport;
      expect(body.source).toBe("engine");
      expect(body.mode).toBe("hosted");
      expect(body.publicUrl).toBe("https://paws.up.railway.app");
      expect(body.counts.items).toBe(1);
      expect(body.items[0]).toMatchObject({
        id: "eng-1",
        title: "Ship hosted mode",
        state: "queued",
      });
      expect(JSON.stringify(body)).not.toContain("session");
    } finally {
      paws.stop();
    }
  });

  test("bun src/index.ts doctor reports a hosted environment", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "doctor"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        PAWS_MODE: "hosted",
        PAWS_HOME: "/data",
        PORT: "8080",
        RAILWAY_PUBLIC_DOMAIN: "paws.up.railway.app",
        LINEAR_CLIENT_ID: "client",
        LINEAR_CLIENT_SECRET: "secret",
        LINEAR_WEBHOOK_SECRET: "hook",
        LINEAR_ACCESS_TOKEN: "token",
        GITHUB_APP_ID: "11",
        GITHUB_APP_INSTALLATION_ID: "22",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "gh-hook",
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
        PAWS_DASHBOARD_TOKEN: "dashboard-token-value",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(text).toContain("paws doctor · hosted");
    expect(text).toContain("ready");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });
});

async function readUntil(proc: Bun.Subprocess, needle: string, timeoutMs: number): Promise<string> {
  const stdout = proc.stdout;
  if (stdout === undefined || typeof stdout === "number") {
    throw new Error("stdout was not piped");
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timed out waiting for ${needle}: ${text}`)), remaining);
      }),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}
