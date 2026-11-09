import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TOOLCHAIN_PREFLIGHT_RUNNER_VERSION } from "../src/runner-protocol";
import { git } from "../src/acp";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

for (const [manifest, installed, blocked] of [
  ["Cargo.toml", false, true],
  ["Cargo.toml", true, false],
  ["apps/acme/go.mod", false, true],
  ["a/b/go.mod", false, false],
  ["", false, false],
] as const)
  test(`toolchain preflight: ${manifest || "no manifests"}, installed=${installed}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-start-phases-"));

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
      if (manifest) {
        mkdirSync(dirname(join(source, manifest)), { recursive: true });
        writeFileSync(join(source, manifest), "");
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      if (installed) {
        writeFileSync(join(bin, "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
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
      let question = "";
      const result = await executeRunnerCommand({
        job,
        repositoryBundle,
        inputs: readRunnerJobInputs(spool, job.executionId),
        outputDirectory,
        workRoot,
        home: join(root, "home"),
        resultsGid: process.getgid!(),
        launch: {
          command: process.execPath,
          args: [fake, join(root, "trace.json"), script],
          env: { PATH: bin },
        },
        async answer() {
          const events = readFileSync(join(outputDirectory, "events.jsonl"), "utf8");
          question =
            events
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .find((event) => event.type === "question")?.question ?? "";
          return { answer: "The question is saved; end this turn." };
        },
      });
      expect(TOOLCHAIN_PREFLIGHT_RUNNER_VERSION).toEqual([0, 1, 74]);
      expect(result.run.stopReason).toBe("end_turn");
      expect(existsSync(join(root, "trace.json"))).toBe(!blocked);
      expect(Boolean(question)).toBe(blocked);
      if (blocked) {
        expect(question).toContain(manifest);
        expect(question).toContain(
          manifest.endsWith("go.mod") ? 'go = "latest"' : 'rust = "stable"',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
