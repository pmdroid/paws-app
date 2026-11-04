import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { setJournalSink, startPhaseClock } from "../src/journal";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

test("each start phase writes one line with the time since the phase before it", () => {
  const lines: string[] = [];
  let clock = 1_000;
  const phase = startPhaseClock({
    ids: { item: "item-1", run: "run-1" },
    startedAt: 400,
    now: () => clock,
    write: (line) => lines.push(line),
  });
  phase("placement");
  clock = 4_000;
  phase("prompt");
  clock = 9_000;
  phase("prompt");
  phase("issue");
  expect(lines).toEqual([
    "start item=item-1 run=run-1 phase=placement durationMs=600",
    "start item=item-1 run=run-1 phase=prompt durationMs=3000",
    "start item=item-1 run=run-1 phase=issue durationMs=5000",
  ]);
});

test("a runner run journals each start phase once, through the first tool call", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-start-phases-"));
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    const source = join(root, "source");
    const workRoot = join(root, "work");
    const outputDirectory = join(root, "output");
    for (const path of [source, join(root, "home"), workRoot, outputDirectory])
      mkdirSync(path, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "original.txt"), "original");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "commit", "-m", "initial"], { env });
    const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    const repositoryBundle = join(root, "source.bundle");
    await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
    chmodSync(repositoryBundle, 0o600);
    const job: RunnerJob = {
      executionId: "01J00000000000000000000003",
      command: {
        type: "run",
        id: "cmd",
        runnerId: "runner",
        workspaceId: "workspace",
        runId: "run",
        itemId: "item",
        generation: 1,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        profile: { agent: "claude", model: "fixture-model" },
        repository: {
          owner: "acme",
          repo: "repo",
          remoteUrl: "https://github.com/acme/repo.git",
          baseSha,
        },
        prompt: "Implement",
        checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
      },
    };
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root);
    chmodSync(spool.root, 0o750);
    publishRunnerJob(spool, job, { repositoryBundle });
    const toolCall = (toolCallId: string) => ({
      type: "update",
      update: { sessionUpdate: "tool_call", toolCallId, title: "Read", status: "completed" },
    });
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [toolCall("one"), toolCall("two"), { type: "end", stopReason: "end_turn" }],
      }),
    );
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    await executeRunnerCommand({
      job,
      repositoryBundle,
      inputs: readRunnerJobInputs(spool, job.executionId),
      outputDirectory,
      workRoot,
      home: join(root, "home"),
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
    });
    const phases = lines
      .filter((line) => line.startsWith("start "))
      .map((line) => {
        const match = /^start item=item run=run execution=(\S+) phase=(\S+) durationMs=(\d+)$/.exec(
          line,
        );
        expect(match?.[1]).toBe(job.executionId);
        return match![2];
      });
    expect(phases).toEqual(["worker", "checkout", "mise", "agent_session", "first_tool_call"]);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
