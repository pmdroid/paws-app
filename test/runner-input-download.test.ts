import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("daemon reads signed attachments and restored prompts through authenticated bounded chunks", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, ["--no-env-file", "test/local/runner-input-download.ts"], {
      encoding: "utf8",
      timeout: 120_000,
    }),
  );
  expect(result.observations).toHaveLength(7);
  expect(result.observations.every((value: { passed: boolean }) => value.passed)).toBe(true);
}, 120_000);
