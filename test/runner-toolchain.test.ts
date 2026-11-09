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
import { parseRuntimeFiles } from "../src/runtimes";
import { git } from "../src/acp";
import { publishRunnerJob, readRunnerJobInputs, type RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

for (const [
  manifest,
  installed,
  blocked,
  retry = false,
  existing = false,
  preserve = false,
  checkpoint = false,
] of [
  ["Cargo.toml", false, true],
  ["Cargo.toml", false, true, false, false, false, true],
  ["Cargo.toml", true, false],
  [".acme/Cargo.toml", false, true],
  ["many/Cargo.toml", false, true],
  ["apps/acme/go.mod", false, true],
  ["a/b/go.mod", false, false],
  ["", false, false],
  ["Cargo.toml", false, true, true],
  ["Cargo.toml", false, true, false, true],
  ["Cargo.toml", false, true, true, false, true],
] as const)
  test(`toolchain preflight: ${manifest || "no manifests"}, installed=${installed}, retry=${retry}, existing=${existing}, preserve=${preserve}, checkpoint=${checkpoint}`, async () => {
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
      if (manifest === "many/Cargo.toml") {
        for (let index = 0; index < 200; index++) {
          const directory = join(source, `acme-${index}-${"x".repeat(180)}`);
          mkdirSync(directory);
          writeFileSync(join(directory, "Cargo.toml"), "");
        }
      }
      if (existing) writeFileSync(join(source, "mise.toml"), '[tools]\nnode = "lts"\n');
      const bin = join(root, "bin");
      mkdirSync(bin);
      if (installed) {
        writeFileSync(join(bin, "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      await git(["-C", source, "add", "."]);
      await git(["-C", source, "commit", "-m", "initial"], { env });
      const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
      let checkpointSha: string | undefined;
      if (checkpoint) {
        writeFileSync(join(source, "original.txt"), "restored acme work");
        writeFileSync(join(source, "acme.txt"), "checkpoint only");
        await git(["-C", source, "add", "."]);
        await git(["-C", source, "commit", "-m", "Save acme checkpoint"], { env });
        checkpointSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
      }
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
          ...(checkpointSha
            ? { restoreCheckpoint: { sha: checkpointSha, branch: "paws/acme" } }
            : {}),
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
      const execute = () =>
        executeRunnerCommand({
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
      const result = await execute();
      expect(TOOLCHAIN_PREFLIGHT_RUNNER_VERSION).toEqual([0, 1, 74]);
      expect(result.run.stopReason).toBe("end_turn");
      expect(existsSync(join(root, "trace.json"))).toBe(!blocked);
      expect(Boolean(question)).toBe(blocked);
      if (checkpoint) {
        expect(result.candidateSha).not.toBe(baseSha);
        const clone = join(root, "published");
        await git(["clone", repositoryBundle, clone]);
        await git(["-C", clone, "fetch", join(outputDirectory, "candidate.bundle"), "HEAD"]);
        await git(["-C", clone, "checkout", "--detach", result.candidateSha!]);
        expect(readFileSync(join(clone, "original.txt"), "utf8")).toBe("restored acme work");
        expect(readFileSync(join(clone, "acme.txt"), "utf8")).toBe("checkpoint only");
      }
      if (blocked) {
        if (manifest === "many/Cargo.toml") {
          expect(question.length).toBeLessThanOrEqual(16_384);
          expect(question).toContain("200 other manifests");
        } else expect(question).toContain(manifest);
        expect(question).toContain(
          manifest.endsWith("go.mod") ? 'go = "latest"' : 'rust = "stable"',
        );
        expect(question).toContain("existing [tools] table");
        expect(question).toContain("do not add a second [tools] header");
      }
      if (retry && job.command.type === "run") {
        const config = '[tools]\nrust = "stable"\n';
        writeFileSync(join(source, "mise.toml"), config);
        await git(["-C", source, "add", "mise.toml"]);
        await git(["-C", source, "commit", "-m", "Declare rust"], { env });
        job.command.repository.mainSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
        const localConfig = '[tools]\nrust = "stable"\n# candidate edits\n';
        if (preserve) {
          await git(["-C", source, "checkout", "-b", "acme-candidate", baseSha]);
          writeFileSync(join(source, "mise.toml"), localConfig);
          writeFileSync(join(source, "original.txt"), "candidate work");
          await git(["-C", source, "add", "."]);
          await git(["-C", source, "commit", "-m", "Keep candidate work"], { env });
          job.command.repository.baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
        }
        rmSync(repositoryBundle);
        await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
        chmodSync(repositoryBundle, 0o600);
        job.command.generation++;
        job.command.runtimes = parseRuntimeFiles(
          new Map([["mise.toml", new TextEncoder().encode(config)]]),
        ).runtimes;
        const runtime = join(root, "runtime");
        mkdirSync(join(runtime, "bin"), { recursive: true });
        writeFileSync(join(runtime, "bin", "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const mise = join(root, "mise");
        writeFileSync(mise, `#!/bin/sh\nif [ "$1" = where ]; then printf '%s' '${runtime}'; fi\n`, {
          mode: 0o755,
        });
        // Keep the original base: the retry must carry main's declaration into that checkout.
        question = "";
        const retryOutput = join(root, "retry-output");
        mkdirSync(retryOutput);
        const retried = await executeRunnerCommand({
          job,
          repositoryBundle,
          outputDirectory: retryOutput,
          workRoot,
          home: join(root, "home"),
          resultsGid: process.getgid!(),
          mise: { path: mise },
          launch: {
            command: process.execPath,
            args: [fake, join(root, "trace.json"), script],
            env: { PATH: bin },
          },
          async answer() {
            throw new Error("The retry must not ask again");
          },
        });
        expect(retried.run.stopReason).toBe("end_turn");
        expect(existsSync(join(root, "trace.json"))).toBe(true);
        expect(readFileSync(join(workRoot, "run", "mise.toml"), "utf8")).toBe(
          preserve ? localConfig : config,
        );
        if (preserve)
          expect(readFileSync(join(workRoot, "run", "original.txt"), "utf8")).toBe(
            "candidate work",
          );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
