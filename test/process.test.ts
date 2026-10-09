import { describe, expect, test } from "bun:test";
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
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PAWS_HOME: home,
        PAWS_PORT: "0",
        PAWS_HOST: "127.0.0.1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await readUntil(proc, "paws ready", 5000);
    proc.kill();
    await proc.exited;
    expect(text).toContain("paws ready · http://127.0.0.1:");
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
