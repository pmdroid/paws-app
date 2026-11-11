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
import { git } from "../../src/acp";
import { executeRunnerCommand } from "../../src/runner-worker";
import type { RunnerJob } from "../../src/runner-execution";
import { join } from "node:path";
import { type LaunchInput, type Proof } from "./harness";

let QUESTION = "";
const ANSWER = "Added rust to mise.toml; retry.";
const COMMIT = "Count widgets per shelf, empty shelves as 0";

const answered = (launch: LaunchInput) =>
  launch.purpose === "implement" && launch.prompt.includes(ANSWER);

export default {
  covers: [
    "src/acp/ask-team.ts",
    "src/acp/ask-team-mcp.ts",
    "src/core/handoff.ts",
    "src/loop/operations.ts",
    "src/loop/orchestrator.ts",
    "src/loop/question-effects.ts",
    "src/questions/**",
    "src/runner-worker/**",
    "src/runner-backend/**",
    "src/linear/**",
  ],
  summary:
    "The implement turn asks a blocking question; the item waits for input with its slot freed, the answer in Linear resumes the run with the answer in its prompt, and the item merges.",
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : !answered(input)
        ? [{ type: "ask_team", question: QUESTION }]
        : [
            { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n0\n" },
            { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
            {
              type: "terminal",
              command: "git",
              args: [
                "-c",
                "user.name=Acme Agent",
                "-c",
                "user.email=agent@acme.test",
                "commit",
                "-q",
                "-m",
                COMMIT,
              ],
              cwd: input.worktree,
            },
          ],
  async run(proof) {
    const root = mkdtempSync(join(tmpdir(), "acme-toolchain-proof-"));
    const source = join(root, "source");
    const bin = join(root, "bin");
    const home = join(root, "home");
    for (const path of [source, bin, home]) mkdirSync(path);
    await git(["init", "-b", "main", source]);
    writeFileSync(join(source, "Cargo.toml"), '[package]\nname = "acme"\nversion = "0.1.0"\n');
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Acme",
      "-c",
      "user.email=acme@example.test",
      "commit",
      "-m",
      "Seed acme manifest",
    ]);
    const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    const bundle = join(root, "source.bundle");
    const trace = join(root, "agent.json");
    const script = join(root, "script.json");
    writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: [{ type: "end" }] }));
    const job: RunnerJob = {
      executionId: "01J00000000000000000000003",
      command: {
        type: "run",
        id: "acme-command",
        runnerId: "acme-runner",
        workspaceId: "acme-workspace",
        runId: "acme-run",
        itemId: "acme-item",
        generation: 1,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        profile: { agent: "claude", model: "fixture-model" },
        prompt: "Implement acme",
        repository: {
          owner: "acme",
          repo: "widgets",
          remoteUrl: "https://github.com/acme/widgets.git",
          baseSha,
        },
        checkpointBot: { appId: "99", login: "paws-test[bot]", id: 88 },
      },
    };
    const runWorker = async (retry: boolean) => {
      rmSync(bundle, { force: true });
      await git(["-C", source, "bundle", "create", bundle, "--all"]);
      chmodSync(bundle, 0o600);
      const output = join(root, retry ? "retry" : "first");
      mkdirSync(output);
      return executeRunnerCommand({
        job,
        repositoryBundle: bundle,
        outputDirectory: output,
        workRoot: join(root, "work"),
        home,
        resultsGid: process.getgid!(),
        ...(retry ? { mise: { path: join(root, "mise") } } : {}),
        launch: {
          command: process.execPath,
          args: [
            new URL("../../src/acp/testing/fake-agent.ts", import.meta.url).pathname,
            trace,
            script,
          ],
          env: { PATH: bin },
        },
        async answer() {
          if (retry) throw new Error("Configured retry asked again");
          QUESTION = readFileSync(join(output, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .find((event) => event.type === "question").question;
          return { answer: "Question saved; end turn" };
        },
      });
    };
    const blocked = await runWorker(false);
    proof.expect(
      "real worker detects missing cargo and never starts ACP",
      blocked.run.stopReason === "end_turn" &&
        !existsSync(trace) &&
        QUESTION.includes('rust = "stable"'),
      QUESTION,
    );
    // Exercise the remote event replay path with its real runner store and command harness.
    const replay = Bun.spawn(
      ["bun", "test", "test/runner-handover-resume.test.ts", "--test-name-pattern", "replay"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([
      replay.exited,
      new Response(replay.stdout).text(),
      new Response(replay.stderr).text(),
    ]);
    proof.expect(
      "runner question replay asks once and answers every journal sequence in order",
      exit === 0,
      {
        stdout,
        stderr,
      },
    );

    // Relay the worker's actual question through the scripted local tracker fixture.
    await proof.delegate();
    const asked = await proof.waitFor(
      "the question is asked and the item waits for input",
      async () =>
        (await proof.itemState()) === "awaiting_input" && (await proof.heldWork()).activeRuns === 0,
    );
    proof.expect(
      "the implement turn asks the question in Linear",
      proof.linear.questions.some((question) => question.body.includes(QUESTION)),
      proof.linear.questions,
    );
    const held = await proof.heldWork();
    proof.expect(
      "the item goes to awaiting_input and its slot is freed",
      asked && held.activeRuns === 0 && held.reservations === 0 && held.runningJobs === 0,
      { state: await proof.itemState(), held },
    );
    const askingRun = await proof.itemRunId();

    await proof.pushToMain(
      "mise.toml",
      '[tools]\nrust = "stable"\n',
      "Declare the missing Rust toolchain",
    );
    const config = '[tools]\nrust = "stable"\n';
    writeFileSync(join(source, "mise.toml"), config);
    await git(["-C", source, "add", "."]);
    await git([
      "-C",
      source,
      "-c",
      "user.name=Acme",
      "-c",
      "user.email=acme@example.test",
      "commit",
      "-m",
      "Declare rust",
    ]);
    if (job.command.type !== "run") throw new Error("Expected run");
    job.command.repository.mainSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    job.command.runtimes = [{ tool: "rust", version: "stable" }];
    const runtime = join(root, "runtime");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    writeFileSync(join(runtime, "bin", "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(root, "mise"),
      `#!/bin/sh\nif [ "$1" = where ]; then printf '%s' '${runtime}'; fi\n`,
      { mode: 0o755 },
    );
    const retried = await runWorker(true);
    proof.expect(
      "real worker installs the declared tool and starts ACP on retry",
      retried.run.stopReason === "end_turn" &&
        existsSync(trace) &&
        readFileSync(join(root, "work/acme-run/mise.toml"), "utf8") === config,
    );
    rmSync(root, { recursive: true, force: true });
    await proof.answerInLinear(ANSWER);
    const merged = await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    const resumed = turns.filter(answered);
    proof.expect(
      "the answer resumes the same run, and the resumed turn's prompt carries the question and the answer",
      turns.length === 2 &&
        resumed.length === 1 &&
        resumed[0]!.prompt.includes(QUESTION) &&
        askingRun !== null &&
        (await proof.itemRunId()) === askingRun &&
        (await proof.transitions()).some(
          (row) => row.from === "awaiting_input" && row.event === "restart",
        ),
      {
        purposes: proof.launches.map((launch) => launch.purpose),
        resumedWithAnswer: resumed.length,
        runs: { asking: askingRun, final: await proof.itemRunId() },
      },
    );
    proof.expect(
      "the toolchain configuration remains on merged main",
      (await proof.originMainFiles()).includes("mise.toml"),
    );
    const log = await proof.originMainLog();
    proof.expect("the resumed turn's commit is merged into origin main", log.includes(COMMIT), log);
    proof.expect(
      "the item is merged, not failed",
      merged && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
