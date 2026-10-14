import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCloseoutGate } from "../../src/closeout";
import {
  createRemoteCloseoutCommandRunner,
  type RemoteCloseoutExecution,
  type RemoteCloseoutRequest,
} from "../../src/runner-closeout";
import { runnerCheckInputHash, type RunnerCheckInput } from "../../src/runner-check";

export async function probeRunnerCloseout(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = join(root, "source"),
    origin = join(root, "origin.git"),
    sentinel = join(root, "local-execution");
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  mkdirSync(join(source, ".agents"));
  const argv = [
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected')`,
  ];
  writeFileSync(
    join(source, ".agents/closeout.yaml"),
    JSON.stringify({
      specVersion: "0.1",
      setup: [{ id: "prepare", exec: argv, timeoutSeconds: 5 }],
      items: [{ id: "check", kind: "command", gate: "beforePR", exec: argv, timeoutSeconds: 5 }],
    }),
  );
  writeFileSync(join(source, "result.txt"), "base\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Base policy"]);
  const base = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["clone", "--bare", source, origin]);
  await git(["-C", source, "remote", "add", "origin", origin]);
  writeFileSync(join(source, "result.txt"), "candidate\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Candidate"]);
  const head = await git(["-C", source, "rev-parse", "HEAD"]);
  for (const variant of [
    "passed",
    "dirty",
    "headMoved",
    "timedOut",
    "exit",
    "failedSetup",
  ] as const) {
    const calls: RemoteCloseoutRequest[] = [];

    const gate = createCloseoutGate({
      candidate: { session: "candidate-session", model: "candidate-model", provider: "fixture" },
      reviewer: {
        async review() {
          throw new Error("Unexpected review");
        },
      },
      fixer: {
        async applyFix() {
          throw new Error("Unexpected fix");
        },
      },
      maxFixAttempts: 0,
      pawsHome: join(root, variant),
      commandRunner: createRemoteCloseoutCommandRunner({
        checkoutExclusions: ["large"],
        secrets: ["synthetic-closeout-secret"],
        async execute(request) {
          calls.push(request);
          assert.equal(request.candidateSha, head);
          assert.deepEqual(request.checkoutExclusions, ["large"]);
          assert.equal(request.cwd, ".");
          assert.deepEqual(request.argv, argv);
          const input: RunnerCheckInput = {
            format: 1,
            executionId: `01J${String(calls.length).padStart(23, "0")}`,
            verificationAttemptId: "01J00000000000000000000000",
            candidateSha: head,
            checkoutExclusions: request.checkoutExclusions,
            argv: request.argv,
            cwd: "/var/lib/paws-check-attempts/01J00000000000000000000000/workspace",
            env: {
              PATH: "/usr/bin:/bin",
              HOME: "/var/lib/paws-check-attempts/01J00000000000000000000000/home",
            },
            timeoutMs: request.timeoutMs,
          };
          const setup = calls.length === 1;
          return {
            input,
            result: {
              format: 1,
              executionId: input.executionId,
              verificationAttemptId: input.verificationAttemptId,
              candidateSha: head,
              inputSha256: runnerCheckInputHash(input),
              exitCode:
                (variant === "exit" && !setup) || (variant === "failedSetup" && setup) ? 1 : 0,
              signal: null,
              timedOut: variant === "timedOut" && !setup,
              dirty: variant === "dirty" && !setup,
              headMoved: variant === "headMoved" && !setup,
              durationMs: 10,
              stdout: `Scripted ${variant} synthetic-closeout-secret`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          };
        },
      }),
    });
    const verdict = await gate.run({
      taskId: `runner-${variant}`,
      worktree: source,
      baseSha: base,
      headSha: head,
      attempt: 1,
    });
    assert.equal(existsSync(sentinel), false);
    assert(verdict.result?.decision, verdict.summary);
    if (variant === "passed") {
      assert.equal(verdict.decision, "accepted", verdict.summary);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.cwd, calls[1]!.cwd);
    } else {
      assert.notEqual(verdict.decision, "accepted", verdict.summary);
      const failed = verdict.result.decision.items.filter((item) => item.state === "failed");
      assert.equal(failed.length, 1, verdict.summary);
      assert.equal(failed[0]!.id, variant === "failedSetup" ? "prepare" : "check");
      assert.equal(failed[0]!.kind, variant === "failedSetup" ? "setup" : "command");
      assert.equal(
        failed[0]!.message,
        {
          dirty: "command left the worktree dirty",
          headMoved: "command moved HEAD",
          timedOut: "command timed out",
          exit: "command exited 1",
          failedSetup: "command exited 1",
        }[variant],
      );
      assert.equal(calls.length, variant === "failedSetup" ? 1 : 2);
    }
    observe(`native Closeout preserves ${variant} hash-bound remote execution evidence`, true, {
      decision: verdict.decision,
      head: verdict.result.head,
      commands: calls.length,
      localExecutionAbsent: true,
      execution: "scripted trusted runner",
    });
  }
  const input: RunnerCheckInput = {
    format: 1,
    executionId: "01J00000000000000000000001",
    verificationAttemptId: "01J00000000000000000000000",
    candidateSha: head,
    argv,
    cwd: "/var/lib/paws-check-attempts/01J00000000000000000000000/workspace",
    env: { PATH: "/usr/bin:/bin", HOME: "/var/lib/paws-check" },
    timeoutMs: 5_000,
  };
  const evidence: RemoteCloseoutExecution = {
    input,
    result: {
      format: 1,
      executionId: input.executionId,
      verificationAttemptId: input.verificationAttemptId,
      candidateSha: head,
      inputSha256: runnerCheckInputHash(input),
      exitCode: 0,
      signal: null,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 10,
      stdout: "synthetic-closeout-secret",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  };
  const changes: [string, (value: RemoteCloseoutExecution) => void][] = [
    ["candidate", (value) => (value.input.candidateSha = base)],
    ["argv", (value) => (value.input.argv = ["/usr/bin/true"])],
    ["timeout", (value) => (value.input.timeoutMs = 6_000)],
    ["workspace", (value) => (value.input.cwd = "/unrelated/workspace")],
    ["execution", (value) => (value.result.executionId = "01J00000000000000000000002")],
    ["attempt", (value) => (value.result.verificationAttemptId = "01J00000000000000000000002")],
    ["result-candidate", (value) => (value.result.candidateSha = base)],
    ["exclusions", (value) => (value.input.checkoutExclusions = ["untrusted"])],
    ["digest", (value) => (value.result.inputSha256 = "0".repeat(64))],
  ];
  for (const [name, change] of changes) {
    const execution = structuredClone(evidence);
    change(execution);
    if (name !== "digest") execution.result.inputSha256 = runnerCheckInputHash(execution.input);
    let published = 0;
    const logFile = join(root, `${name}.log`);
    const runner = createRemoteCloseoutCommandRunner({
      async execute() {
        return execution;
      },
    });
    await assert.rejects(
      runner.runLogged({
        cwd: source,
        argv,
        timeoutSeconds: 5,
        expectedHead: head,
        logFile,
        artifactPath: `${name}.log`,
        onOutput() {
          published++;
        },
      }),
      /binding changed/,
    );
    assert.equal(published, 0);
    assert.equal(existsSync(logFile), false);
  }
  observe("changed remote command bindings cannot publish Closeout evidence", true, {
    refused: changes.map(([name]) => name),
  });
  const bounded = structuredClone(evidence);
  bounded.result.stdout += "x".repeat(300_000);
  bounded.result.stderr = "synthetic-closeout-secret";
  bounded.result.exitCode = null;
  bounded.result.signal = 9;
  const output: string[] = [];
  const logFile = join(root, "bounded.log");
  const runner = createRemoteCloseoutCommandRunner({
    secrets: ["synthetic-closeout-secret"],
    async execute() {
      return bounded;
    },
  });
  const result = await runner.runLogged({
    cwd: source,
    argv,
    timeoutSeconds: 5,
    expectedHead: head,
    logFile,
    artifactPath: "bounded.log",
    onOutput(_stream, text) {
      output.push(text);
    },
  });
  const bytes = readFileSync(logFile);
  assert.equal(result.exitCode, 137);
  assert.equal(result.truncated, true);
  assert.equal(statSync(logFile).mode & 0o777, 0o600);
  assert.equal(bytes.includes("synthetic-closeout-secret"), false);
  assert.equal(output.join("").includes("synthetic-closeout-secret"), false);
  assert(bytes.length < 262_200);
  assert.equal(result.artifacts[0]!.sha256, createHash("sha256").update(bytes).digest("hex"));
  observe("bounded scrubbed signal evidence has an exact private artifact hash", true, {
    exitCode: result.exitCode,
    truncated: result.truncated,
    logBytes: bytes.length,
    mode: "0600",
  });
  const controller = new AbortController();
  const cancelledLog = join(root, "cancelled.log");
  const cancelled = createRemoteCloseoutCommandRunner({
    signal: controller.signal,
    async execute() {
      controller.abort(new Error("fixture cancelled"));
      return evidence;
    },
  });
  await assert.rejects(
    cancelled.runLogged({
      cwd: source,
      argv,
      timeoutSeconds: 5,
      expectedHead: head,
      logFile: cancelledLog,
      artifactPath: "cancelled.log",
    }),
    /fixture cancelled/,
  );
  assert.equal(existsSync(cancelledLog), false);
  observe("cancellation after remote response prevents evidence publication", true, {});
}
