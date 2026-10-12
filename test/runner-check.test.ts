import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  publishRunnerCheckAttempt,
  publishRunnerCheckCommand,
  readRunnerCheckResult,
  runnerCheckWorkspace,
  runnerCheckInputHash,
  deriveRunnerCheckInput,
  RunnerCheckInputSchema,
  RunnerCheckResultSchema,
  type RunnerCheckInput,
  type RunnerCheckPaths,
} from "../src/runner-check";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const attemptId = "01K00000000000000000000000";
const executionId = "01K00000000000000000000001";
const candidateSha = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-check-inputs-"));
  roots.push(root);
  const paths: RunnerCheckPaths = {
    inputRoot: join(root, "inputs"),
    workRoot: join(root, "work"),
    resultRoot: join(root, "results"),
    runnerUid: process.getuid!(),
    runnerGid: process.getgid!(),
    inputGid: process.getgid!(),
    checkUid: process.getuid!() + 1,
    checkGid: process.getgid!() + 1,
  };
  for (const path of [
    paths.inputRoot,
    join(paths.inputRoot, "attempts"),
    join(paths.inputRoot, "commands"),
  ]) {
    mkdirSync(path, { mode: 0o750 });
    chmodSync(path, 0o750);
  }
  const bundle = join(root, "source.bundle");
  writeFileSync(bundle, "synthetic immutable bundle", { mode: 0o600 });
  const input: RunnerCheckInput = {
    format: 1,
    executionId,
    verificationAttemptId: attemptId,
    candidateSha,
    argv: ["/usr/bin/true"],
    cwd: runnerCheckWorkspace(paths, attemptId),
    env: { LANG: "C" },
    timeoutMs: 1000,
  };
  return { root, paths, bundle, input };
}
const linux = process.platform === "linux" && process.getuid!() > 0 && process.getgid!() > 0;

test("check input digest binds strict command content independent of object key order", () => {
  const { input } = fixture();
  const left = runnerCheckInputHash({ ...input, env: { LANG: "C", CHECK: "yes" } });
  const right = runnerCheckInputHash({ ...input, env: { CHECK: "yes", LANG: "C" } });
  expect(left).toBe(right);
  expect(left).not.toBe(runnerCheckInputHash({ ...input, env: { CHECK: "no", LANG: "C" } }));
  expect(() => runnerCheckInputHash({ ...input, argv: [] })).toThrow();
});

test("signed check requests derive fixed paths and environment without accepting inherited fields", () => {
  const request = {
    executionId,
    verificationAttemptId: attemptId,
    candidateSha,
    argv: ["bun", "test"],
    cwd: ".",
    timeoutMs: 1000,
  };
  const input = deriveRunnerCheckInput(request);
  const attempt = `/var/lib/paws-check-attempts/${attemptId}`;
  expect(input.cwd).toBe(`${attempt}/workspace`);
  expect(input.env).toEqual({
    HOME: `${attempt}/home`,
    TMPDIR: `${attempt}/tmp`,
    PATH: "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
  });
  expect(deriveRunnerCheckInput({ ...request, cwd: "packages/api" }).cwd).toBe(
    `${attempt}/workspace/packages/api`,
  );
  for (const cwd of ["", "/tmp", "../outside", "a/../b", "a//b", "a/", "./a"])
    expect(() => deriveRunnerCheckInput({ ...request, cwd })).toThrow();
  expect(() => deriveRunnerCheckInput({ ...request, env: {} } as typeof request)).toThrow();
  expect(() => deriveRunnerCheckInput({ ...request, timeoutMs: 900_001 })).toThrow();
  expect(() =>
    deriveRunnerCheckInput({ ...request, argv: Array<string>(32).fill("a".repeat(8192)) }),
  ).toThrow("exceeds size limit");
});

test.skipIf(!linux)("check attempts pin one immutable bundle and candidate across commands", () => {
  const { paths, bundle, input } = fixture();
  const attempt = publishRunnerCheckAttempt(
    paths,
    { verificationAttemptId: attemptId, candidateSha },
    { repositoryBundle: bundle },
  );
  expect(attempt.bundleSha256).toHaveLength(64);
  expect(
    publishRunnerCheckAttempt(
      paths,
      { verificationAttemptId: attemptId, candidateSha },
      { repositoryBundle: bundle },
    ),
  ).toEqual(attempt);
  expect(publishRunnerCheckCommand(paths, input)).toEqual(input);
  expect(publishRunnerCheckCommand(paths, { ...input, env: { LANG: "C" } })).toEqual(input);
  expect(() => publishRunnerCheckCommand(paths, { ...input, argv: ["/usr/bin/false"] })).toThrow(
    "already exists",
  );
  expect(() =>
    publishRunnerCheckCommand(paths, {
      ...input,
      executionId: "01K00000000000000000000002",
      candidateSha: "b".repeat(40),
    }),
  ).toThrow("candidate mismatch");
  writeFileSync(bundle, "changed bundle");
  expect(() =>
    publishRunnerCheckAttempt(
      paths,
      { verificationAttemptId: attemptId, candidateSha },
      { repositoryBundle: bundle },
    ),
  ).toThrow("already exists");
  expect(
    readFileSync(join(paths.inputRoot, "attempts", attemptId, "repository.bundle"), "utf8"),
  ).toBe("synthetic immutable bundle");
});

test.skipIf(!linux)(
  "check publication rejects credential fields, escapes and unsafe bundle links",
  () => {
    const { root, paths, bundle, input } = fixture();
    expect(() =>
      publishRunnerCheckCommand(paths, { ...input, grant: "synthetic" } as RunnerCheckInput),
    ).toThrow();
    expect(() =>
      publishRunnerCheckCommand(paths, { ...input, cwd: `${input.cwd}/../elsewhere` }),
    ).toThrow("working directory");
    const linked = join(root, "linked.bundle");
    symlinkSync(bundle, linked);
    expect(() =>
      publishRunnerCheckAttempt(
        paths,
        { verificationAttemptId: attemptId, candidateSha },
        { repositoryBundle: linked },
      ),
    ).toThrow();
    rmSync(linked);
    linkSync(bundle, linked);
    expect(() =>
      publishRunnerCheckAttempt(
        paths,
        { verificationAttemptId: attemptId, candidateSha },
        { repositoryBundle: linked },
      ),
    ).toThrow("Unsafe");
    expect(() => runnerCheckWorkspace(paths, "../escape")).toThrow();
  },
);

test.skipIf(!linux)(
  "check inputs reject redirected directories and untrusted result ownership",
  () => {
    const { root, paths, bundle, input } = fixture();
    publishRunnerCheckAttempt(
      paths,
      { verificationAttemptId: attemptId, candidateSha },
      { repositoryBundle: bundle },
    );
    publishRunnerCheckCommand(paths, input);
    mkdirSync(paths.resultRoot, { mode: 0o750 });
    expect(() => readRunnerCheckResult(paths, input)).toThrow("Unsafe");
    const alias = join(root, "input-alias");
    symlinkSync(paths.inputRoot, alias);
    expect(() => publishRunnerCheckCommand({ ...paths, inputRoot: alias }, input)).toThrow();
    chmodSync(join(paths.inputRoot, "commands", executionId, "job.json"), 0o660);
    expect(() => publishRunnerCheckCommand(paths, input)).toThrow("Unsafe");
  },
);

test("check schemas bound argv, environment, wait status and output", () => {
  const input = {
    format: 1,
    executionId,
    verificationAttemptId: attemptId,
    candidateSha,
    argv: ["/usr/bin/true"],
    cwd: "/workspace",
    env: {},
    timeoutMs: 1000,
  };
  for (const change of [
    { argv: [""] },
    { argv: ["bad\0command"] },
    { env: { VALUE: "bad\0value" } },
    { timeoutMs: 900_001 },
    { candidateSha: "a".repeat(64) },
  ])
    expect(RunnerCheckInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  const result = {
    format: 1 as const,
    executionId,
    verificationAttemptId: attemptId,
    candidateSha,
    inputSha256: "b".repeat(64),
    exitCode: 0,
    signal: null,
    timedOut: true,
    stdout: "binary\0output",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 4,
    dirty: false,
    headMoved: false,
  };
  expect(RunnerCheckResultSchema.parse(result)).toEqual(result);
  expect(RunnerCheckResultSchema.safeParse({ ...result, signal: 15 }).success).toBe(false);
  expect(RunnerCheckResultSchema.safeParse({ ...result, exitCode: null }).success).toBe(false);
  expect(
    RunnerCheckResultSchema.safeParse({ ...result, stdout: "x".repeat(1_048_577) }).success,
  ).toBe(false);
});
