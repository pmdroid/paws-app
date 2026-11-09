import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const FIXED_IN = "1.4.4";
const fixture = new URL("./fixtures/spawn-sync-gc.ts", import.meta.url).pathname;
const PIN = /(?:^bun = "|bun-version: |BUN_VERSION = ")(\d+\.\d+\.\d+)/gm;

test.each([
  "mise.toml",
  ".github/workflows/ci.yml",
  ".github/workflows/runner-release.yml",
  "deploy/linux/release.py",
  "src/install-host/install.ts",
])("%s pins a Bun whose spawnSync keeps its child's exit", (path) => {
  const text = readFileSync(new URL(`../${path}`, import.meta.url).pathname, "utf8");
  const pins = [...text.matchAll(PIN)].map((match) => match[1]!);
  expect(pins.length).toBeGreaterThan(0);
  for (const pin of pins) expect(Bun.semver.order(pin, FIXED_IN), pin).toBeGreaterThanOrEqual(0);
});

// The CI hang behind PAS-1453: spawnSync stopped polling, so an exited git stayed a zombie.
test("spawnSync still sees its child exit after a collection during an earlier call", async () => {
  const child = Bun.spawn([process.execPath, fixture], {
    // The writers only hold a poll when stderr is a pipe; this makes the collection prompt.
    env: { ...process.env, BUN_JSC_slowPathAllocsBetweenGCs: "3" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ output: "polled\n", timedOut: false });
});
