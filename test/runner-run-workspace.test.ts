import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-run-workspace-"));
  roots.push(root);
  const source = join(root, "source");
  const home = join(root, "home");
  const workRoot = join(root, "work");
  for (const path of [source, home]) mkdirSync(path, { recursive: true });
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
  const work = {
    id: "cmd",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "01J0000000000000000000RUN1",
    itemId: "item",
    generation: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude" as const, model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha,
    },
    prompt: "Implement the request",
  };
  const run = (
    extra: Partial<Extract<RunnerJob["command"], { type: "run" }>> = {},
  ): RunnerJob["command"] => ({
    ...work,
    type: "run",
    checkpoint: false,
    ...extra,
  });
  const review = (): RunnerJob["command"] => ({ ...work, type: "review" });
  const task = (): RunnerJob["command"] => ({
    ...work,
    type: "task",
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "answer",
    repository: undefined,
  });
  async function execute(
    executionId: string,
    command: RunnerJob["command"],
    script: FakeScript = { steps: [{ type: "end" }] },
  ) {
    writeFileSync(
      join(root, `${executionId}.json`),
      JSON.stringify({ model: "fixture-model", ...script }),
    );
    const result = await executeRunnerCommand({
      job: { executionId, command },
      ...(command.type === "task" ? {} : { repositoryBundle }),
      outputDirectory: join(root, "output", executionId),
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [
          fakeAgent,
          join(root, `${executionId}-trace.json`),
          join(root, `${executionId}.json`),
        ],
      },
    });
    const trace = JSON.parse(
      readFileSync(join(root, `${executionId}-trace.json`), "utf8"),
    ) as FakeResult;
    return { result, trace };
  }
  function output(executionId: string): string {
    const directory = join(root, "output", executionId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }
  return { root, workRoot, run, review, task, execute, output, runId: work.runId };
}

const FIRST = "01J00000000000000000000001";
const SECOND = "01J00000000000000000000002";

test("two run commands of one run use the same cwd and replace the earlier checkout", async () => {
  const { workRoot, run, execute, output, runId } = await fixture();
  const checkout = join(workRoot, runId);
  output(FIRST);
  const first = await execute(FIRST, run(), {
    sessionId: "first-session",
    steps: [
      { type: "fs_write", path: join(checkout, "leftover.txt"), content: "from the first command" },
      { type: "end" },
    ],
  });
  expect(first.result.run.stopReason).toBe("end_turn");
  expect(first.trace.sessionCwd).toBe(checkout);
  expect(readFileSync(join(checkout, "leftover.txt"), "utf8")).toBe("from the first command");
  // A folder the agent left read-only is still removed.
  mkdirSync(join(checkout, "locked", "nested"), { recursive: true });
  writeFileSync(join(checkout, "locked", "nested", "file.txt"), "locked");
  chmodSync(join(checkout, "locked", "nested"), 0o500);
  chmodSync(join(checkout, "locked"), 0o500);

  output(SECOND);
  const second = await execute(SECOND, run({ resumeSessionId: "first-session" }), {
    loadSession: true,
    steps: [{ type: "end" }],
  });
  expect(second.result.run.stopReason).toBe("end_turn");
  expect(second.trace.sessionCwd).toBe(checkout);
  expect((second.trace.loaded as { sessionId: string }).sessionId).toBe("first-session");
  expect(JSON.stringify(second.trace.prompts)).toContain(`in a fresh checkout at ${checkout},`);
  expect(existsSync(join(checkout, "leftover.txt"))).toBe(false);
  expect(existsSync(join(checkout, "locked"))).toBe(false);
  expect(readFileSync(join(checkout, "original.txt"), "utf8")).toBe("original");
  expect(existsSync(join(workRoot, FIRST))).toBe(false);
  expect(existsSync(join(workRoot, SECOND))).toBe(false);
});

test("review and task commands keep their execution checkout paths", async () => {
  const { workRoot, review, task, execute, output } = await fixture();
  output(FIRST);
  const reviewed = await execute(FIRST, review());
  expect(reviewed.trace.sessionCwd).toBe(join(workRoot, FIRST));
  mkdirSync(join(workRoot, SECOND), { mode: 0o700 });
  chmodSync(join(workRoot, SECOND), 0o700);
  output(SECOND);
  const answered = await execute(SECOND, task());
  expect(answered.trace.sessionCwd).toBe(join(workRoot, SECOND));
});

test("a symlinked leftover run checkout is refused before checkout", async () => {
  const { root, workRoot, run, execute, output, runId } = await fixture();
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep.txt"), "keep");
  mkdirSync(workRoot, { mode: 0o700 });
  symlinkSync(elsewhere, join(workRoot, runId));
  output(FIRST);
  await expect(execute(FIRST, run())).rejects.toThrow("Unsafe runner workspace");
  expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
  expect(existsSync(join(root, `${FIRST}-trace.json`))).toBe(false);
});
