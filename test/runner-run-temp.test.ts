import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ownedByAgent = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), "paws-run-temp-probe-"));
    const path = join(probe, "runs", "id", "tmp");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const owned = statSync(path).uid === process.getuid?.();
    rmSync(probe, { recursive: true, force: true });
    return owned;
  } catch {
    return false;
  }
})();

async function runWithFakeAgent(steps: unknown[], signal?: AbortSignal) {
  const root = mkdtempSync(join(tmpdir(), "paws-run-temp-"));
  roots.push(root);
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
    executionId: "01J00000000000000000000007",
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
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps }));
  const trace = join(root, "trace.json");
  const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
  const runTemp = join(workRoot, ".paws", "runs", job.executionId, "tmp");
  const finished = executeRunnerCommand({
    job,
    repositoryBundle,
    inputs: readRunnerJobInputs(spool, job.executionId),
    outputDirectory,
    workRoot,
    home: join(root, "home"),
    resultsGid: process.getgid!(),
    launch: { command: process.execPath, args: [fake, trace, script] },
    ...(signal ? { signal } : {}),
  });
  return { finished, runTemp, trace: () => JSON.parse(readFileSync(trace, "utf8")) };
}

test.skipIf(!ownedByAgent)(
  "an agent run writes temporary files to its own run folder, removed when it ends",
  async () => {
    const name = `paws-run-temp-${process.pid}-${Date.now()}`;
    const run = await runWithFakeAgent([
      { type: "write_file", path: `$TMPDIR/${name}`, content: "scratch" },
      { type: "end", stopReason: "end_turn" },
    ]);
    await run.finished;
    expect(run.trace().temp).toEqual([run.runTemp, run.runTemp, run.runTemp]);
    expect(existsSync(run.runTemp)).toBe(false);
    expect(existsSync(join("/tmp", name))).toBe(false);
    expect(existsSync(join(tmpdir(), name))).toBe(false);
  },
  30_000,
);

test.skipIf(!ownedByAgent)(
  "a cancelled run's temporary folder is removed",
  async () => {
    const name = `paws-run-temp-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    const run = await runWithFakeAgent(
      [{ type: "write_file", path: `$TMPDIR/${name}`, content: "scratch" }, { type: "hang" }],
      controller.signal,
    );
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(run.runTemp, name)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readFileSync(join(run.runTemp, name), "utf8")).toBe("scratch");
    controller.abort();
    await run.finished;
    expect(existsSync(run.runTemp)).toBe(false);
    expect(existsSync(join("/tmp", name))).toBe(false);
  },
  30_000,
);
