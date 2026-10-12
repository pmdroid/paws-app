import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCloseoutGate } from "../../src/closeout";
import type { LoggedCommandRequest } from "../../src/closeout-spec";

export async function probeCloseoutCommandRunner(
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
    const calls: LoggedCommandRequest[] = [];
    const logBytes = Buffer.from(`STDOUT\nScripted ${variant}\nSTDERR\n`);
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
      commandRunner: {
        async runLogged(request) {
          calls.push(request);
          assert.equal(request.expectedHead, head);
          assert.notEqual(request.cwd, source);
          assert.equal(await git(["-C", request.cwd, "rev-parse", "HEAD"]), head);
          assert.deepEqual(request.argv, argv);
          mkdirSync(dirname(request.logFile), { recursive: true });
          writeFileSync(request.logFile, logBytes);
          request.onOutput?.("stdout", `Scripted ${variant}`, false);
          const setup = calls.length === 1;
          return {
            argv: request.argv,
            exitCode:
              (variant === "exit" && !setup) || (variant === "failedSetup" && setup) ? 1 : 0,
            timedOut: variant === "timedOut" && !setup,
            dirty: variant === "dirty" && !setup,
            headMoved: variant === "headMoved" && !setup,
            durationMs: 10,
            truncated: false,
            artifacts: [
              {
                path: request.artifactPath,
                sha256: createHash("sha256").update(logBytes).digest("hex"),
              },
            ],
          };
        },
      },
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
      for (const call of calls) assert.deepEqual(readFileSync(call.logFile), logBytes);
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
    observe(`native Closeout preserves ${variant} injected execution evidence`, true, {
      decision: verdict.decision,
      head: verdict.result.head,
      commands: calls.length,
      localExecutionAbsent: true,
      execution: "scripted trusted runner",
    });
  }
}
