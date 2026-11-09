import { expect, test } from "bun:test";

const fixture = new URL("./fixtures/spawn-sync-gc.ts", import.meta.url).pathname;

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
  expect(JSON.parse(stdout)).toEqual({ collected: 3, output: "polled\n", timedOut: false });
});
