import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runnerCheckResultSigningBytes } from "../src/runner-verifier";
import type { RunnerCheckResult } from "../src/runner-check";

const helper = resolve(import.meta.dir, "../deploy/linux/check-verifier.py");
const load =
  "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('verifier',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.stdout.buffer.write(m.signing_bytes(json.load(sys.stdin)))";
const result: RunnerCheckResult = {
  format: 1,
  executionId: "01K00000000000000000000001",
  verificationAttemptId: "01K00000000000000000000002",
  candidateSha: "a".repeat(40),
  inputSha256: "b".repeat(64),
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: '日本語 🐕 e\u0301 \u2028\u2029\0\n"\\',
  stderr: "診断\t🙂",
  stdoutTruncated: false,
  stderrTruncated: true,
  durationMs: 9007199254740991,
  dirty: false,
  headMoved: true,
};

function canonical(value: unknown) {
  return Bun.spawnSync(["/usr/bin/python3", "-I", "-B", "-c", load, helper], {
    stdin: Buffer.from(JSON.stringify(value)),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
}

test("Python signing bytes match the public verifier for Unicode and reordered result fields", () => {
  for (const value of [
    result,
    Object.fromEntries(Object.entries(result).reverse()) as RunnerCheckResult,
    { ...result, exitCode: null, signal: 15 },
  ]) {
    const actual = canonical(value);
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout).toEqual(runnerCheckResultSigningBytes(value));
  }
});

test("Python signer rejects ambiguous or unbounded result encodings", () => {
  for (const mutation of [
    { extra: true },
    { format: true },
    { executionId: "../escape" },
    { candidateSha: "A".repeat(40) },
    { timedOut: 1 },
    { exitCode: true },
    { signal: 15 },
    { durationMs: 9007199254740992 },
    { stdout: "\ud800" },
    { stdout: "🐕".repeat(262145) },
  ]) {
    expect(canonical({ ...result, ...mutation }).exitCode).not.toBe(0);
  }
});
