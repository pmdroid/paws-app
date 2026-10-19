import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

test("a remote run that stops early still reports its work as a WIP candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-remote-wip-"));
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
      executionId: "01J00000000000000000000002",
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
    const checkout = join(workRoot, job.executionId);
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_write", path: join(checkout, "partial.txt"), content: "half done\n" },
          { type: "end", stopReason: "max_turn_requests" },
        ],
      }),
    );
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    const result = await executeRunnerCommand({
      job,
      repositoryBundle,
      inputs: readRunnerJobInputs(spool, job.executionId),
      outputDirectory,
      workRoot,
      home: join(root, "home"),
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
    });
    expect(result.run.stopReason).toBe("max_turn_requests");
    expect(result.candidateSha).toBeDefined();
    expect(result.candidateSha).not.toBe(baseSha);
    expect(
      (
        await git(["-C", checkout, "show", "--name-only", "--format=", result.candidateSha!])
      ).trim(),
    ).toBe("partial.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
