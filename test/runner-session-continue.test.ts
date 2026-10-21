import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

test("work stopped at a usage limit loads its agent session, or replays the prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-continue-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
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
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root);
    chmodSync(spool.root, 0o750);
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    const execute = async (name: string, executionId: string, script: FakeScript) => {
      const job: RunnerJob = {
        executionId,
        command: {
          type: "run",
          id: `cmd-${name}`,
          runnerId: "runner",
          workspaceId: "workspace",
          runId: "run",
          itemId: "item",
          generation: 2,
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
          profile: { agent: "claude", model: "fixture-model" },
          repository: {
            owner: "acme",
            repo: "repo",
            remoteUrl: "https://github.com/acme/repo.git",
            baseSha,
          },
          prompt: "Implement the request. Observed prior conversation: EARLIER WORK",
          resumeSessionId: "limited-session",
        },
      };
      publishRunnerJob(spool, job, { repositoryBundle });
      const outputDirectory = join(root, `output-${name}`);
      const workRoot = join(root, `work-${name}`);
      for (const path of [outputDirectory, workRoot]) mkdirSync(path, { recursive: true });
      writeFileSync(
        join(root, `${name}.json`),
        JSON.stringify({ model: "fixture-model", ...script }),
      );
      const result = await executeRunnerCommand({
        job,
        repositoryBundle,
        inputs: readRunnerJobInputs(spool, executionId),
        outputDirectory,
        workRoot,
        home,
        resultsGid: process.getgid!(),
        launch: {
          command: process.execPath,
          args: [fake, join(root, `${name}-trace.json`), join(root, `${name}.json`)],
        },
      });
      return {
        result,
        trace: JSON.parse(readFileSync(join(root, `${name}-trace.json`), "utf8")) as FakeResult,
      };
    };

    const loaded = await execute("loaded", "01J00000000000000000000011", {
      loadSession: true,
      steps: [{ type: "end" }],
    });
    expect(loaded.result.run.stopReason).toBe("end_turn");
    expect(loaded.trace.methods).toContain("session/load");
    expect(loaded.trace.methods).not.toContain("session/new");
    expect((loaded.trace.loaded as { sessionId: string }).sessionId).toBe("limited-session");
    expect(JSON.stringify(loaded.trace.prompts)).toContain("usage limit has reset");
    expect(JSON.stringify(loaded.trace.prompts)).not.toContain("EARLIER WORK");

    const replayed = await execute("replayed", "01J00000000000000000000012", {
      steps: [{ type: "end" }],
    });
    expect(replayed.result.run.stopReason).toBe("end_turn");
    expect(replayed.trace.methods).toContain("session/new");
    expect(JSON.stringify(replayed.trace.prompts)).toContain("EARLIER WORK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
