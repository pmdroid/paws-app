import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

test("a crashed worker resumes its session in the same workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-resume-"));
  try {
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
        profile: { agent: "claude", model: "fixture-model" },
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
    const worktree = join(workRoot, job.executionId);
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    const execute = (name: string, script: FakeScript, resume: boolean) => {
      writeFileSync(
        join(root, `${name}.json`),
        JSON.stringify({ model: "fixture-model", ...script }),
      );
      return executeRunnerCommand({
        job,
        repositoryBundle,
        inputs: readRunnerJobInputs(spool, job.executionId),
        outputDirectory,
        workRoot,
        home,
        resultsGid: process.getgid!(),
        resume,
        launch: {
          command: process.execPath,
          args: [fake, join(root, `${name}-trace.json`), join(root, `${name}.json`)],
        },
      });
    };
    const trace = (name: string) =>
      JSON.parse(readFileSync(join(root, `${name}-trace.json`), "utf8")) as FakeResult;
    const crash = () => {
      rmSync(join(outputDirectory, "result.json"));
      rmSync(join(outputDirectory, "candidate.bundle"), { force: true });
    };
    await execute(
      "first",
      {
        sessionId: "first-session",
        steps: [
          { type: "fs_write", path: join(worktree, "partial.txt"), content: "partial" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "WORKING ON IT" },
            },
          },
          { type: "end" },
        ],
      },
      false,
    );
    crash();

    const loaded = await execute("loaded", { loadSession: true, steps: [{ type: "end" }] }, true);
    expect(loaded.run.stopReason).toBe("end_turn");
    expect(trace("loaded").methods).toContain("session/load");
    expect(trace("loaded").methods).not.toContain("session/new");
    expect((trace("loaded").loaded as { sessionId: string }).sessionId).toBe("first-session");
    expect(JSON.stringify(trace("loaded").prompts)).toContain("stopped unexpectedly");
    expect(JSON.stringify(trace("loaded").prompts)).not.toContain("WORKING ON IT");
    expect(readFileSync(join(worktree, "partial.txt"), "utf8")).toBe("partial");
    const events = readFileSync(join(outputDirectory, "events.jsonl"), "utf8");
    expect(events).toContain("WORKING ON IT");
    expect(events).toContain("The agent restarted after a crash.");
    expect(events).not.toContain("REPLAYED HISTORY");
    expect(existsSync(join(outputDirectory, "result.json"))).toBe(true);
    crash();

    const replayed = await execute("replayed", { steps: [{ type: "end" }] }, true);
    expect(replayed.run.stopReason).toBe("end_turn");
    expect(trace("replayed").methods).toContain("session/new");
    const prompt = JSON.stringify(trace("replayed").prompts);
    expect(prompt).toContain("stopped unexpectedly");
    expect(prompt).toContain("WORKING ON IT");
    expect(prompt).toContain("Implement the original request");
    expect(readFileSync(join(worktree, "partial.txt"), "utf8")).toBe("partial");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
