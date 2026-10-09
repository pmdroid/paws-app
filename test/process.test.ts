import { describe, expect, test } from "bun:test";
import { writeConfigFile, pawsPaths, ensureLayout } from "../src/config";
import { startPaws } from "../src/index";
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
    expect(text).toContain("dashboard http://127.0.0.1:");
    expect(text).toContain("/status");
  });

  test("a setup-written config listens on loopback and serves live status", async () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeConfigFile(paths.configFile, {
      linearMode: "comments",
      linearTeam: "ENG",
      linearTeamId: "team_eng",
      linearViewerId: "viewer_1",
      linearSecret: "secrets/linear-api-key",
      linearClientFile: null,
      githubAuth: "gh",
      repo: "pmdroid/paws-demo",
      closeoutBin: `${home}/bin/closeout`,
      checkout: home,
      maxTurns: 80,
      maxAwakeMs: 45 * 60 * 1000,
    });
    const paws = startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "0.0.0.0",
    });
    try {
      expect(paws.server.hostname).toBe("127.0.0.1");
      expect(paws.tunnelRequested).toBe(false);
      expect(paws.tunnelUrl).toBeNull();
      const base = `http://${paws.server.hostname}:${paws.server.port}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const status = await fetch(`${base}/api/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ source: "live" });
      const hidden = await fetch(`${base}/webhooks/linear`, { method: "POST" });
      expect(hidden.status).toBe(404);
    } finally {
      paws.stop();
    }
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
