import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, SHELL_RESTART_NOTICE } from "../src/acp";
import type { FakeResult, FakeStep } from "../src/acp/testing/script";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const command = (id: string, rawOutput: unknown): FakeStep[] => [
  {
    type: "update",
    update: { sessionUpdate: "tool_call", toolCallId: id, title: "echo hello", kind: "execute" },
  },
  {
    type: "update",
    update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", rawOutput },
  },
];
const broken = (prefix: string) =>
  [1, 2, 3].flatMap((index) =>
    command(`${prefix}-${index}`, { exit_code: -1, stdout: "", stderr: "" }),
  );

async function runWithSessions(sessions: FakeStep[][]) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-shell-"));
  const source = join(root, "source");
  const home = join(root, "home");
  const workRoot = join(root, "work");
  const outputDirectory = join(root, "output");
  for (const path of [source, home, workRoot, outputDirectory])
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
    executionId: "01J00000000000000000000001",
    command: {
      type: "run",
      id: "cmd",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      profile: { agent: "grok", model: "fixture-model" },
      repository: {
        owner: "acme",
        repo: "repo",
        remoteUrl: "https://github.com/acme/repo.git",
        baseSha,
      },
      prompt: "Implement the original request",
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
  const worktree = join(workRoot, "run");
  const script = join(root, "script.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      authMethods: [{ id: "cached_token", name: "Grok login" }],
      steps: [],
      sessions: sessions.map((steps) =>
        steps.map((step) =>
          step.type === "fs_write" ? { ...step, path: join(worktree, step.path) } : step,
        ),
      ),
    }),
  );
  const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
  const questions: string[] = [];
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => logged.push(line);
  try {
    const result = await executeRunnerCommand({
      job,
      repositoryBundle,
      inputs: readRunnerJobInputs(spool, job.executionId),
      outputDirectory,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [fake, join(root, "trace.json"), script],
      },
      async answer(requestId) {
        const journal = readFileSync(join(outputDirectory, "events.jsonl"), "utf8");
        const asked = journal
          .split("\n")
          .filter(Boolean)
          .map(
            (line) => JSON.parse(line) as { type: string; requestId?: string; question?: string },
          )
          .find((event) => event.type === "question" && event.requestId === requestId);
        if (!asked?.question) throw new Error("unexpected answer request");
        questions.push(asked.question);
        return { answer: "Keep going and run the tests." };
      },
    });
    return {
      result,
      questions,
      logged,
      spawns: Number(readFileSync(`${script}.spawns`, "utf8")),
      events: readFileSync(join(outputDirectory, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      trace: JSON.parse(readFileSync(join(root, "trace.json"), "utf8")) as FakeResult,
      worktree,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } finally {
    console.warn = warn;
  }
}

test("a broken shell restarts the agent session once and the task continues", async () => {
  const run = await runWithSessions([
    [...broken("first"), { type: "hang" }],
    [
      ...command("failing", { exit_code: 1, stdout: "", stderr: "expected 2, got 3" }),
      ...command("failing-2", { exit_code: 1, stdout: "FAIL a.test.ts", stderr: "" }),
      ...command("failing-3", { exit_code: 2, output: "error TS2322" }),
      { type: "fs_write", path: "done.txt", content: "done" },
      { type: "end" },
    ],
  ]);
  try {
    expect(run.result.run.stopReason).toBe("end_turn");
    expect(run.spawns).toBe(2);
    expect(run.questions).toEqual([]);
    expect(readFileSync(join(run.worktree, "done.txt"), "utf8")).toBe("done");
    expect(run.events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", text: SHELL_RESTART_NOTICE, notice: true },
    ]);
    const prompt = JSON.stringify(run.trace.prompts);
    expect(prompt).toContain("stopped running commands");
    expect(prompt).toContain("Implement the original request");
    expect(run.logged).toHaveLength(1);
    expect(JSON.parse(run.logged[0]!)).toMatchObject({
      event: "agent_shell_broken",
      count: 1,
      agent: "grok",
      agentName: "fake-acp",
      agentVersion: "0.0.0",
    });
  } finally {
    run.cleanup();
  }
}, 60_000);

test("a second broken shell in the same task asks the team instead of restarting", async () => {
  const run = await runWithSessions([
    [...broken("first"), { type: "hang" }],
    [...broken("second"), { type: "hang" }],
    [{ type: "end" }],
  ]);
  try {
    expect(run.result.run.stopReason).toBe("end_turn");
    expect(run.spawns).toBe(3);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0]).toContain("stopped running commands again");
    expect(
      run.events.filter((event) => event.type === "progress" && event.notice === true),
    ).toHaveLength(1);
    expect(JSON.stringify(run.trace.prompts)).toContain("Keep going and run the tests.");
    expect(run.logged.map((line) => JSON.parse(line).count)).toEqual([1, 2]);
  } finally {
    run.cleanup();
  }
}, 60_000);
