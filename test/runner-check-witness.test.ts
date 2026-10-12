import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("trusted witness preserves setup dirt and bounds decoded binary output", () => {
  const result = Bun.spawnSync(
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      resolve(import.meta.dir, "local/runner-check-witness-test.py"),
    ],
    { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toContain("Ran 3 tests");
  expect(result.exitCode).toBe(0);
});
