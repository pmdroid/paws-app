import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const finding = {
  severity: "P1",
  location: "app.txt:1",
  explanation: "wrong constant: the head changed the value.",
  evidence: "app.txt reads two.",
};

/**
 * A review command on the runner: base and head commits in a bundle, and a fake CLI that
 * records its argv, cwd, HEAD and home, then prints the given JSON Lines events.
 */
async function reviewOnRunner(input: {
  agent: "codex" | "claude";
  events: unknown[];
  base?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-review-"));
  roots.push(root);
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
  writeFileSync(join(source, "app.txt"), "one\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "base"], { env });
  const base = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  writeFileSync(join(source, "app.txt"), "two\n");
  await git(["-C", source, "commit", "-am", "head"], { env });
  const head = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  const repositoryBundle = join(root, "source.bundle");
  await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
  chmodSync(repositoryBundle, 0o600);
  const record = join(root, "record.json");
  const cli = join(root, input.agent);
  writeFileSync(
    cli,
    `#!${process.execPath}\n` +
      `const { execSync } = require("node:child_process");\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({\n` +
      `  argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,\n` +
      `  codexHome: process.env.CODEX_HOME,\n` +
      `  head: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),\n` +
      `}));\n` +
      `for (const event of ${JSON.stringify(input.events)}) console.log(JSON.stringify(event));\n`,
  );
  chmodSync(cli, 0o755);
  const job: RunnerJob = {
    executionId: "01J00000000000000000000009",
    command: {
      type: "review",
      id: "review-cmd",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      profile: { agent: input.agent, model: "review-model" },
      repository: {
        owner: "acme",
        repo: "repo",
        remoteUrl: "https://github.com/acme/repo.git",
        baseSha: head,
      },
      prompt: "Review the change with the agent's review command.",
      reviewCommand: { base: input.base ?? base },
    },
  };
  const result = await executeRunnerCommand({
    job,
    repositoryBundle,
    outputDirectory,
    workRoot,
    home,
    resultsGid: process.getgid!(),
    launch: { command: "/forbidden-acp-agent" },
    providerCli: () => cli,
  });
  const ran = (() => {
    try {
      return JSON.parse(readFileSync(record, "utf8")) as {
        argv: string[];
        cwd: string;
        home: string;
        codexHome: string;
        head: string;
      };
    } catch {
      return undefined;
    }
  })();
  return { result, ran, base, head, home, worktree: join(workRoot, job.executionId) };
}

test("a Codex review command runs codex exec review --base in the run's checkout at head", async () => {
  const { result, ran, base, head, home, worktree } = await reviewOnRunner({
    agent: "codex",
    events: [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify([finding]) } },
    ],
  });
  expect(ran?.argv.slice(0, 6)).toEqual([
    "exec",
    "review",
    "--base",
    base,
    "--model",
    "review-model",
  ]);
  expect(ran?.argv).toContain("--output-schema");
  expect(ran?.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(ran?.cwd).toBe(worktree);
  expect(ran?.head).toBe(head);
  // The runner's own login, not the host's.
  expect(ran?.home).toBe(home);
  expect(ran?.codexHome).toBe(join(home, ".codex"));
  expect(result.run).toMatchObject({
    role: "reviewer",
    stopReason: "end_turn",
    sessionId: "thread-1",
    identity: { session: "thread-1", model: "review-model", provider: "openai" },
  });
  expect(JSON.parse(result.reviewText!)).toEqual([finding]);
  expect(result.candidateSha).toBeUndefined();
}, 20_000);

test("a Claude review command runs /code-review base..head in plan mode", async () => {
  const { result, ran, base, head } = await reviewOnRunner({
    agent: "claude",
    events: [
      { type: "system", subtype: "init", session_id: "session-1", model: "claude-review" },
      { type: "result", session_id: "session-1", structured_output: [] },
    ],
  });
  expect(ran?.argv.slice(0, 2)).toEqual(["-p", "--permission-mode"]);
  expect(ran?.argv[2]).toBe("plan");
  expect(ran?.argv.at(-1)).toBe(`/code-review ${base}..${head}`);
  expect(result.run).toMatchObject({
    stopReason: "end_turn",
    identity: { session: "session-1", model: "claude-review", provider: "anthropic" },
  });
  expect(result.reviewText).toBe("[]");
}, 20_000);

test("a review command whose final message never parses fails the review with the reason", async () => {
  const { result } = await reviewOnRunner({
    agent: "codex",
    events: [{ type: "item.completed", item: { type: "agent_message", text: "Looks good." } }],
  });
  expect(result.run.stopReason).toBe("error");
  expect(result.run.errorMessage).toContain("no session to re-ask");
  expect(result.reviewText).toBeUndefined();
}, 20_000);

test("a review base missing from the checkout fails before the CLI starts", async () => {
  const { result, ran } = await reviewOnRunner({
    agent: "codex",
    events: [],
    base: "f".repeat(40),
  });
  expect(ran).toBeUndefined();
  expect(result.run.stopReason).toBe("error");
  expect(result.run.errorMessage).toBe(
    `The review base ${"f".repeat(40)} is not in the run's checkout`,
  );
}, 20_000);
