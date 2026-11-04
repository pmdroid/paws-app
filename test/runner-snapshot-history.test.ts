import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
import {
  publishRunnerJob,
  readRunnerJobInputs,
  runnerRepositoryBlobsPath,
  runnerRepositoryBundlePath,
  type RunnerJob,
} from "../src/runner-execution";
import { createRunnerRepositories } from "../src/runner-repositories";
import { executeRunnerCommand } from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

async function fixture(snapshotFilter?: string) {
  const root = mkdtempSync(join(tmpdir(), "paws-snapshot-history-"));
  roots.push(root);
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  mkdirSync(home);
  await git(["init", "-q", "-b", "main", source], { env });
  const big = randomBytes(2_000_000);
  const blob = (content: Buffer | string) => {
    const bytes = Buffer.from(content);
    return Buffer.concat([Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n")]);
  };
  const parts: Buffer[] = [];
  for (let index = 1; index <= 250; index++) {
    parts.push(
      Buffer.from(
        `commit refs/heads/main\ncommitter Fixture <fixture@example.com> ${1_700_000_000 + index} +0000\n`,
      ),
      blob(`commit ${index}`),
    );
    if (index === 1) parts.push(Buffer.from("M 100644 inline big.bin\n"), blob(big));
    else if (index === 2) parts.push(Buffer.from("M 100644 inline big.bin\n"), blob("small\n"));
    else parts.push(Buffer.from("M 100644 inline count.txt\n"), blob(`${index}\n`));
    parts.push(Buffer.from("\n"));
  }
  writeFileSync(join(root, "history.fi"), Buffer.concat(parts));
  const imported = Bun.spawn(["git", "-C", source, "fast-import", "--quiet"], {
    stdin: Bun.file(join(root, "history.fi")),
    env,
  });
  expect(await imported.exited).toBe(0);
  await git(["-C", source, "reset", "-q", "--hard", "main"], { env });
  await git(["clone", "-q", "--bare", source, origin], { env });
  const rev = async (name: string) => (await git(["-C", source, "rev-parse", name])).trim();
  const mainSha = await rev("main");
  const baseSha = await rev("main~1");
  const oldBlob = await rev("main~249:big.bin");
  const runId = "01J0000000000000000000RUN1";
  const command: Extract<RunnerJob["command"], { type: "run" }> = {
    id: "cmd",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId,
    itemId: "item",
    generation: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha,
      mainSha,
    },
    prompt: "Implement",
    checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
  };
  const repositories = createRunnerRepositories({
    root: join(root, "cache"),
    home,
    credential: async (_, access) => `synthetic-${access}`,
    ...(snapshotFilter ? { snapshotFilter } : {}),
    async networkGit(input) {
      if (input.operation === "clone")
        await git(["clone", "-q", "--bare", origin, input.dest!], { env });
      else if (input.operation === "fetch")
        await git(["--git-dir", input.dest!, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*"], {
          env,
        });
      else await git(["--git-dir", input.cwd, "push", "-q", origin, input.refspec!], { env });
    },
  });
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o750);
  async function prepare(executionId: string) {
    const prepared = await repositories.prepare(command);
    const job: RunnerJob = { executionId, command };
    const sizes = {
      bundle: statSync(prepared.bundle).size,
      blobs: prepared.blobs ? statSync(prepared.blobs).size : 0,
    };
    publishRunnerJob(spool, job, {
      repositoryBundle: prepared.bundle,
      ...(prepared.blobs ? { repositoryBlobs: prepared.blobs } : {}),
    });
    rmSync(prepared.bundle, { force: true });
    if (prepared.blobs) rmSync(prepared.blobs, { force: true });
    return {
      job,
      sizes,
      header: readFileSync(runnerRepositoryBundlePath(spool, executionId), "utf8").split("\n")[0],
      repositoryBundle: runnerRepositoryBundlePath(spool, executionId),
      repositoryBlobs: runnerRepositoryBlobsPath(spool, executionId),
    };
  }
  async function execute(
    prepared: Awaited<ReturnType<typeof prepare>>,
    steps: unknown[],
    extra: Partial<Parameters<typeof executeRunnerCommand>[0]> = {},
  ) {
    const output = join(root, "output", prepared.job.executionId);
    mkdirSync(output, { recursive: true });
    const script = join(root, `script-${prepared.job.executionId}.json`);
    writeFileSync(script, JSON.stringify({ model: "fixture-model", sessionId: "session", steps }));
    const result = await executeRunnerCommand({
      job: prepared.job,
      repositoryBundle: prepared.repositoryBundle,
      ...(prepared.repositoryBlobs ? { repositoryBlobs: prepared.repositoryBlobs } : {}),
      inputs: readRunnerJobInputs(spool, prepared.job.executionId),
      outputDirectory: output,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [fakeAgent, join(root, "trace.json"), script] },
      ...extra,
    });
    return { result, output };
  }
  const fullSize = async () => {
    const path = join(root, "full.bundle");
    await git(["--git-dir", origin, "bundle", "create", "-q", path, "main"], { env });
    return statSync(path).size;
  };
  return {
    root,
    origin,
    baseSha,
    mainSha,
    oldBlob,
    command,
    repositories,
    checkout: join(root, "work", runId),
    prepare,
    execute,
    fullSize,
    rev,
  };
}

test.skipIf(!linux)(
  "a run's snapshot carries all history but only recent file contents, and the agent repository never fetches",
  async () => {
    const f = await fixture();
    const prepared = await f.prepare("01J00000000000000000000001");
    expect(prepared.header).toBe("# v3 git bundle");
    expect(prepared.repositoryBlobs).toBeDefined();
    const full = await f.fullSize();
    expect(full).toBeGreaterThan(2_000_000);
    expect(prepared.sizes.bundle + prepared.sizes.blobs).toBeLessThan(full / 10);
    const { result, output } = await f.execute(prepared, [
      { type: "fs_write", path: join(f.checkout, "change.txt"), content: "agent change\n" },
      { type: "end", stopReason: "max_turn_requests" },
    ]);
    const checkout = f.checkout;
    const run = (args: string[]) => git(["-C", checkout, ...args], { env });
    expect((await run(["rev-parse", "refs/remotes/origin/main"])).trim()).toBe(f.mainSha);
    expect(readFileSync(join(checkout, "count.txt"), "utf8")).toBe("249\n");
    expect(readFileSync(join(checkout, "big.bin"), "utf8")).toBe("small\n");
    expect((await run(["for-each-ref", "refs/paws"])).trim()).toBe("");
    expect(await run(["show", "--format=", `${f.baseSha}~150`])).toContain("+99");
    expect((await run(["config", "remote.origin.url"])).trim()).toStartWith("/nonexistent/");
    expect(existsSync((await run(["config", "remote.origin.url"])).trim())).toBe(false);
    const started = Date.now();
    const old = Bun.spawnSync(["git", "-C", checkout, "cat-file", "-p", f.oldBlob], { env });
    expect(old.exitCode).not.toBe(0);
    expect(old.stderr.toString()).toMatch(/could not fetch .* from promisor remote/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const sha = result.candidateSha!;
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(sha).not.toBe(f.baseSha);
    const bundle = Buffer.from(readFileSync(join(output, "candidate.bundle")));
    expect(await f.repositories.publish(f.command, { bundle, sha, branch: "paws/candidate" })).toBe(
      sha,
    );
    expect(
      (await git(["--git-dir", f.origin, "rev-parse", "refs/heads/paws/candidate"])).trim(),
    ).toBe(sha);
  },
  60_000,
);

test.skipIf(!linux)(
  "a checkpoint from a partial agent repository publishes as before",
  async () => {
    const f = await fixture();
    const prepared = await f.prepare("01J00000000000000000000002");
    expect(prepared.repositoryBlobs).toBeDefined();
    const written = join(f.checkout, "draft.txt");
    const { output } = await f.execute(
      prepared,
      [{ type: "fs_write", path: written, content: "draft\n" }, { type: "hang" }],
      {
        checkpointIntervalMs: 3_600_000,
        async checkpoint(sequence, signal) {
          if (sequence > 1)
            await new Promise((_, reject) => signal.addEventListener("abort", reject));
          while (!existsSync(written)) await Bun.sleep(10);
        },
      },
    );
    const events = readFileSync(join(output, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; sha?: string });
    const sha = events.find((event) => event.type === "checkpoint" && event.sha)?.sha;
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const bundle = Buffer.from(readFileSync(join(output, `checkpoint-${sha}.bundle`)));
    expect(
      await f.repositories.publish(f.command, { bundle, sha: sha!, branch: "paws/checkpoint" }),
    ).toBe(sha!);
    const clone = join(f.root, "published");
    await git(["clone", "-q", "--branch", "paws/checkpoint", f.origin, clone], { env });
    expect(readFileSync(join(clone, "draft.txt"), "utf8")).toBe("draft\n");
  },
  60_000,
);

test.skipIf(!linux)(
  "a filtered bundle that fails falls back to the full snapshot, logged once",
  async () => {
    const f = await fixture("not-a-filter");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let prepared: Awaited<ReturnType<typeof f.prepare>>;
    try {
      prepared = await f.prepare("01J00000000000000000000003");
      expect(
        warn.mock.calls.filter(([line]) => String(line).includes("runner_snapshot_filter_failed")),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(prepared.header).toBe("# v2 git bundle");
    expect(prepared.repositoryBlobs).toBeUndefined();
    expect(prepared.sizes.bundle).toBeGreaterThan(2_000_000);
    expect(readdirOutputs(f.root)).toEqual([]);
    await f.execute(prepared, [{ type: "end" }]);
    expect((await git(["-C", f.checkout, "cat-file", "-s", f.oldBlob], { env })).trim()).toBe(
      "2000000",
    );
    expect(
      Bun.spawnSync(["git", "-C", f.checkout, "config", "remote.origin.url"], { env }).exitCode,
    ).not.toBe(0);
  },
  60_000,
);

function readdirOutputs(root: string): string[] {
  return Array.from(new Bun.Glob("cache/{snapshot,blobs}-*").scanSync({ cwd: root }));
}
