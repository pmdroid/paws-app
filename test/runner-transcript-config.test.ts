import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeRunnerTranscriptAdapters,
  probeRunnerTranscriptStartup,
  probeRunnerTranscriptStorage,
} from "./local/runner-transcript-config";
import {
  checkLegacyRunnerTranscriptStorage,
  loadRunnerTranscriptS3,
} from "../src/runner-transcript-config";

async function observe(probe: typeof probeRunnerTranscriptStorage, expected: number) {
  const root = mkdtempSync(join(tmpdir(), "paws-transcript-config-test-"));
  const observations: string[] = [];
  try {
    await probe(root, (name, passed) => {
      expect(passed).toBe(true);
      observations.push(name);
    });
    expect(observations).toHaveLength(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("protected transcript configuration feeds explicit storage", async () => {
  await observe(probeRunnerTranscriptStorage, 4);
});

test("startup without a runner answers health and remote prerequisites fail first", async () => {
  await observe(probeRunnerTranscriptStartup, 1);
});

test("configured transcript adapters preserve transcripts in S3 and on local disk", async () => {
  await observe(probeRunnerTranscriptAdapters, 4);
});

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

test("the startup check reads only a legacy file, and leaves PAWS_S3_* settings to the table", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-transcript-legacy-"));
  const previous = process.env.PAWS_S3_BUCKET;
  try {
    checkLegacyRunnerTranscriptStorage(home);
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "secrets", "runner-transcript-storage.json"), "invalid", {
      mode: 0o600,
    });
    expect(() => checkLegacyRunnerTranscriptStorage(home)).toThrow(
      /configuration is missing or invalid/,
    );
    rmSync(join(home, "secrets", "runner-transcript-storage.json"));
    process.env.PAWS_S3_BUCKET = "fixture-bucket";
    expect(() => loadRunnerTranscriptS3(home)).toThrow(/configuration is missing or invalid/);
    checkLegacyRunnerTranscriptStorage(home);
  } finally {
    if (previous === undefined) delete process.env.PAWS_S3_BUCKET;
    else process.env.PAWS_S3_BUCKET = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
