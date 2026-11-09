import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const FIXED_IN = "1.4.4";
const fixture = new URL("./fixtures/spawn-sync-gc.ts", import.meta.url).pathname;
const mise = new URL("../mise.toml", import.meta.url).pathname;

test("the repository pins a Bun whose spawnSync keeps its child's exit", () => {
  const pinned = /^bun = "(.+)"$/m.exec(readFileSync(mise, "utf8"))?.[1];
  expect(Bun.semver.order(pinned ?? "0.0.0", FIXED_IN)).toBeGreaterThanOrEqual(0);
});

// The CI hang behind PAS-1453: spawnSync stopped polling, so an exited git stayed a zombie.
// An older Bun has the bug and fails this by design; there is no fix there to assert.
test.skipIf(Bun.semver.order(Bun.version, FIXED_IN) < 0)(
  "spawnSync still sees its child exit after a collection during an earlier call",
  async () => {
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
    expect(JSON.parse(stdout)).toEqual({ collected: 3, output: "polled\n", timedOut: false });
  },
);
