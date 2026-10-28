import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const preload = resolve(import.meta.dir, "sync-process-timeout.ts");

function runFixture(body: string) {
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "sync-timeout-"));
  const file = join(dir, "hang.test.ts");
  writeFileSync(file, `import { test, expect } from "bun:test";\n${body}\n`);
  const started = Date.now();
  const result = Bun.spawnSync(["bun", "test", "--preload", preload, file], {
    cwd: dir,
    env: { ...process.env, PAWS_TEST_SYNC_TIMEOUT_MS: "500" },
    timeout: 15_000,
  });
  return {
    seconds: (Date.now() - started) / 1000,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

test("a synchronous child process in a test stops at the default timeout and names its command", () => {
  const { seconds, output } = runFixture(`
import { spawnSync, execFileSync } from "node:child_process";
test("node", () => { spawnSync("sleep", ["30"]); expect(() => execFileSync("sleep", ["30"])).toThrow(); });
test("bun", () => { Bun.spawnSync(["sleep", "30"]); });
`);
  expect(seconds).toBeLessThan(12);
  expect(output).toContain("2 pass");
  expect(output).toContain("synchronous process timed out after 500 ms: sleep 30");
});

test("an explicit timeout in the test still wins", () => {
  const { output } = runFixture(`
import { spawnSync } from "node:child_process";
test("explicit", () => { expect(spawnSync("sleep", ["1"], { timeout: 5_000 }).status).toBe(0); });
`);
  expect(output).toContain("1 pass");
});
