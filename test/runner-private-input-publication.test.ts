import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("candidate history cannot publish private inputs or mint write credentials", () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--no-env-file", "test/local/runner-private-input-publication.ts"],
      { encoding: "utf8", timeout: 90_000 },
    ),
  );
  expect(result.observations).toHaveLength(12);
  expect(result.observations.every((value: { passed: boolean }) => value.passed)).toBe(true);
}, 90_000);
