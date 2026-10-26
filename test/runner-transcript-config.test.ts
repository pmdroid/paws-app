import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerTranscriptStorage } from "./local/runner-transcript-config";

test("protected transcript configuration feeds explicit storage and startup without a runner answers health", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-transcript-config-test-"));
  const observations: string[] = [];
  try {
    await probeRunnerTranscriptStorage(root, (name, passed) => {
      expect(passed).toBe(true);
      observations.push(name);
    });
    expect(observations).toHaveLength(9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("transcript configuration stdin failures retain fixed guidance without credential contents", async () => {
  const secret = "StdinOnlyS3Credential";
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { runRunnerTranscriptStorageCli } from "./src/runner-transcript-config";
    Object.defineProperty(process, "stdin", { value: { async *[Symbol.asyncIterator]() { throw new Error("${secret}"); } } });
    process.exitCode = await runRunnerTranscriptStorageCli(["configure"], "/unused");
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exit).toBe(1);
  expect(stderr.trim().split("\n")).toHaveLength(1);
  expect(stderr).toContain("Runner transcript storage configuration is missing or invalid.");
  expect(stderr).not.toContain(secret);
});
