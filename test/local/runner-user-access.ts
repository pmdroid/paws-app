import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeRunnerCommand } from "../../src/runner-worker";
import { RunnerJobSchema } from "../../src/runner-execution";

export async function probeRunnerUserAccess(root: string) {
  assert(process.getuid!() > 0);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = join(root, "source");
  const home = join(root, "member-home");
  const cache = join(home, ".cache");
  const workRoot = join(root, "tasks");
  for (const directory of [source, home, cache, workRoot]) mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(home, ".codex"), { mode: 0o700 });
  writeFileSync(join(home, ".codex", "existing-login"), "synthetic-preserved-login");
  writeFileSync(join(source, "tracked"), "source-original");
  chmodSync(join(source, "tracked"), 0o440);
  chmodSync(source, 0o550);
  const prepared: Promise<unknown>[] = [];
  const workspaces: string[] = [];
  for (const index of [1, 2]) {
    const executionId = "01J0000000000000000000000" + index;
    const workspace = join(workRoot, executionId);
    const outputDirectory = join(root, "output-" + index);
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(outputDirectory, { mode: 0o750 });
    const external = join(cache, "host-file-" + index);
    writeFileSync(external, "host-readable");
    const trace = join(root, "agent-" + index + ".json");
    const script = join(root, "script-" + index + ".json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          {
            type: "permission",
            toolCall: {
              toolCallId: "host-cache",
              kind: "execute",
              title: "ls " + cache,
              rawInput: { command: "ls " + cache },
            },
          },
          { type: "fs_read", path: external },
          { type: "fs_write", path: external, content: "host-write-" + index },
          {
            type: "fs_write",
            path: join(workspace, "repository", "tracked"),
            content: "private-copy-" + index,
          },
          {
            type: "terminal",
            command: "sh",
            args: [
              "-c",
              'touch "started-$1"; for attempt in 1 2 3 4 5 6 7 8 9 10; do test -f "started-$2" && break; sleep 0.1; done; test -f "started-$2" && printf host-terminal > terminal-result',
              "proof",
              String(index),
              String(3 - index),
            ],
            cwd: cache,
          },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done " + index },
            },
            delayMs: 100,
          },
          { type: "end" },
        ],
      }),
    );
    const now = Date.now();
    const job = RunnerJobSchema.parse({
      executionId,
      command: {
        id: "command-" + index,
        type: "task",
        runnerId: "runner",
        workspaceId: "workspace",
        runId: "run-" + index,
        itemId: "item-" + index,
        generation: 1,
        sessionId: "session-" + index,
        sessionGeneration: 1,
        taskModeGeneration: 1,
        purpose: "artifact",
        issuedAt: now,
        expiresAt: now + 60_000,
        profile: { agent: "claude", model: "fixture-model" },
        prompt: "Create the requested artifact.",
        repository: {
          owner: "fixture",
          repo: "source",
          remoteUrl: "https://github.com/fixture/source.git",
          baseSha: "a".repeat(40),
        },
      },
    });
    prepared.push(
      executeRunnerCommand({
        job,
        repositorySnapshot: source,
        outputDirectory,
        workRoot,
        home,
        resultsGid: process.getgid!(),
        launch: {
          command: process.execPath,
          args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), trace, script],
        },
        async answer() {
          throw new Error("Unexpected question");
        },
      }).then((result) => {
        assert.equal(result.run.stopReason, "end_turn");
        const observed = JSON.parse(readFileSync(trace, "utf8"));
        assert.equal(observed.permissions[0].outcome.outcome.optionId, "allow");
        assert(observed.fs.every((entry: { ok: boolean }) => entry.ok));
        assert(
          observed.terminals.every(
            (entry: { ok: boolean; exitCode: number }) => entry.ok && entry.exitCode === 0,
          ),
        );
        assert.equal(readFileSync(external, "utf8"), "host-write-" + index);
        assert.equal(
          readFileSync(join(workspace, "repository", "tracked"), "utf8"),
          "private-copy-" + index,
        );
        return result;
      }),
    );
    workspaces.push(workspace);
  }
  await Promise.all(prepared);
  chmodSync(source, 0o700);
  assert.equal(readFileSync(join(source, "tracked"), "utf8"), "source-original");
  assert.equal(readFileSync(join(cache, "terminal-result"), "utf8"), "host-terminal");
  assert.equal(
    readFileSync(join(home, ".codex", "existing-login"), "utf8"),
    "synthetic-preserved-login",
  );
  for (const provider of [".codex", ".claude"])
    assert.equal(statSync(join(home, provider)).mode & 0o777, 0o700);
  const result = {
    passed: true,
    nonRootUid: process.getuid!(),
    hostFileReadWrite: true,
    hostTerminal: true,
    parallelAgentBarrierPassed: true,
    existingProviderLoginPreserved: true,
    independentRepositoryCopies: 2,
    workspaces,
    sourceUnchanged: true,
  };
  writeFileSync(join(root, "observations.json"), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.main) console.log(await probeRunnerUserAccess(process.argv[2]!));
