import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutJournalTime, type RunnerCommand } from "../src/runner-protocol";
import {
  AGENT_BIN_DIR,
  installRuntimes,
  prependRuntimePath,
  RUNNER_BIN_DIR,
  runnerMiseDirectories,
  withAgentBin,
  withoutRunnerBin,
} from "../src/runner-mise";
import { executeRunnerCommand } from "../src/runner-worker";

/**
 * A fake mise. It logs each call with its environment, installs into
 * `$MISE_DATA_DIR/installs/<tool>/<version>` once with a `bin/<tool>` that prints where it
 * lives, and reuses an existing install. `where` prints that install dir.
 * `fail` names a tool whose install fails, `sleep` delays each install.
 */
const FAKE_MISE = `#!/bin/sh
here=$(dirname "$0")
log="$here/mise.log"
fail=$(cat "$here/fail" 2>/dev/null)
pause=$(cat "$here/sleep" 2>/dev/null)
spec="$2"
tool="\${spec%@*}"
version="\${spec#*@}"
target="$MISE_DATA_DIR/installs/$(echo "$tool" | tr ':/' '--')/$version"
if [ "$1" = where ]; then
  echo "where $spec" >> "$log"
  [ -d "$target" ] || { echo "mise ERROR $spec is not installed" >&2; exit 1; }
  echo "$target"
  exit 0
fi
if [ "$1" = bin-paths ]; then
  listed="$here/bin-paths-$(echo "$tool" | tr ':/' '--')"
  [ -f "$listed" ] || { echo "mise ERROR unknown command bin-paths" >&2; exit 2; }
  sed "s#@TARGET@#$target#g" "$listed"
  exit 0
fi
[ "$1" = install ] || { echo "unexpected $*" >&2; exit 2; }
echo "$spec $PATH" >> "$here/path.log"
echo "call $spec cwd=$PWD data=$MISE_DATA_DIR cache=$MISE_CACHE_DIR config=$MISE_CONFIG_DIR trusted=[$MISE_TRUSTED_CONFIG_PATHS]" >> "$log"
if [ "$tool" = "$fail" ]; then echo "mise ERROR no version of $tool matches $version" >&2; exit 1; fi
if [ -d "$target" ]; then echo "reuse $spec" >> "$log"; exit 0; fi
echo "start $spec $(date +%s%N)" >> "$log"
[ -n "$pause" ] && sleep "$pause"
mkdir -p "$target/bin"
printf '#!/bin/sh\\necho %s\\n' "$target/bin/$tool" > "$target/bin/$tool"
chmod 755 "$target/bin/$tool"
echo "end $spec $(date +%s%N)" >> "$log"
`;

const executionId = "0".repeat(26);
let root: string;
let mise: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-runner-mise-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mise = join(bin, "mise");
  writeFileSync(mise, FAKE_MISE);
  chmodSync(mise, 0o755);
  home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = () =>
  existsSync(join(dirname(mise), "mise.log"))
    ? readFileSync(join(dirname(mise), "mise.log"), "utf8")
        .trim()
        .split("\n")
    : [];

function command(
  runtimes: Array<{ tool: string; version: string }>,
): Extract<RunnerCommand, { type: "task" }> {
  return {
    id: "command",
    type: "task",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "artifact",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    prompt: "Check the runtimes",
    runtimes,
  };
}

async function runTask(name: string, runtimes: Array<{ tool: string; version: string }>) {
  const task = join(root, name);
  const workRoot = join(task, "work");
  const worktree = join(workRoot, executionId);
  const outputDirectory = join(task, "output");
  for (const path of [worktree, outputDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(worktree, 0o770);
  const { dataDir } = runnerMiseDirectories(home);
  const script = join(task, "script.json");
  const recorded = join(task, "agent.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      steps: [
        {
          type: "terminal",
          command: "sh",
          args: [
            "-c",
            `if [ -d '${join(dataDir, "installs", "node", "22")}' ]; then printf yes > seen.txt; else printf no > seen.txt; fi`,
          ],
        },
        { type: "end" },
      ],
    }),
  );
  const result = await executeRunnerCommand({
    job: { executionId, command: command(runtimes) },
    outputDirectory,
    workRoot,
    home,
    resultsGid: process.getgid!(),
    mise: { path: mise },
    launch: {
      command: process.execPath,
      args: [
        "--no-env-file",
        fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
        recorded,
        script,
      ],
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    },
    async answer() {
      return { answer: "Yes" };
    },
  });
  const events = readFileSync(join(outputDirectory, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => withoutJournalTime(JSON.parse(line)) as { type: string; text?: string });
  const reportPath = join(outputDirectory, "runtimes.json");
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as unknown)
    : undefined;
  return { result, events, worktree, report, agentStarted: existsSync(recorded) };
}

test("the runner installs a task's runtimes before the agent starts, then reuses them", async () => {
  const runtimes = [
    { tool: "node", version: "22" },
    { tool: "python", version: "3.12" },
  ];
  const first = await runTask("first", runtimes);
  expect(first.result.run.stopReason).toBe("end_turn");
  expect(readFileSync(join(first.worktree, "seen.txt"), "utf8")).toBe("yes");
  expect(first.events.some((event) => event.text?.startsWith("Installed runtimes"))).toBe(false);
  expect(first.report).toEqual([
    { tool: "node", version: "22", status: "installed" },
    { tool: "python", version: "3.12", status: "installed" },
  ]);

  const calls = log().filter((line) => line.startsWith("call "));
  expect(calls).toHaveLength(2);
  const { dataDir, cacheDir } = runnerMiseDirectories(home);
  for (const call of calls) {
    expect(call).toContain(`data=${dataDir} `);
    expect(call).toContain(`cache=${cacheDir} `);
    expect(call).toContain("trusted=[]");
    expect(call).not.toContain(`cwd=${first.worktree}`);
    expect(call).not.toContain(`config=${home}`);
  }

  const second = await runTask("second", runtimes);
  expect(second.result.run.stopReason).toBe("end_turn");
  expect(readFileSync(join(second.worktree, "seen.txt"), "utf8")).toBe("yes");
  expect(log().filter((line) => line.startsWith("start "))).toEqual([
    expect.stringMatching(/^start node@22 /),
    expect.stringMatching(/^start python@3\.12 /),
  ]);
  expect(log().filter((line) => line.startsWith("reuse "))).toEqual([
    "reuse node@22",
    "reuse python@3.12",
  ]);
}, 30_000);

test("a failed install fails the task with one line naming the runtime", async () => {
  writeFileSync(join(dirname(mise), "fail"), "python");
  const failed = await runTask("failed", [
    { tool: "node", version: "22" },
    { tool: "python", version: "3.99" },
  ]);
  expect(failed.agentStarted).toBe(false);
  expect(failed.result.run.stopReason).toBe("error");
  expect(failed.result.run.agentExited).toBe(false);
  expect(failed.result.run.errorMessage).toBe(
    "Paws could not install the runtime python@3.99: mise exited with code 1: mise ERROR no version of python matches 3.99",
  );
  expect(failed.result.run.errorMessage).not.toContain("\n");
  // The runner reports what it has, and the failed install with the same line.
  expect(failed.report).toEqual([
    { tool: "node", version: "22", status: "installed" },
    {
      tool: "python",
      version: "3.99",
      status: "failed",
      error: failed.result.run.errorMessage,
    },
  ]);
  expect(failed.events.some((event) => event.type === "acp")).toBe(false);
}, 30_000);

test("an install past the cap fails with the runtime name", async () => {
  writeFileSync(join(dirname(mise), "sleep"), "5");
  const started = Date.now();
  const result = await installRuntimes({
    runtimes: [{ tool: "go", version: "1.23" }],
    home,
    mise,
    timeoutMs: 300,
  });
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(result).toMatchObject({
    ok: false,
    runtime: { tool: "go", version: "1.23" },
    message: "Paws stopped installing the runtime go@1.23: the install ran for more than 300 ms.",
  });
});

test("concurrent tasks on one runner wait on the data dir lock", async () => {
  writeFileSync(join(dirname(mise), "sleep"), "0.5");
  const notices: string[][] = [[], []];
  const results = await Promise.all(
    [0, 1].map((index) =>
      installRuntimes({
        runtimes: [{ tool: "node", version: "22" }],
        home,
        mise,
        notice: (text) => notices[index]!.push(text),
      }),
    ),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  expect(log().filter((line) => line.startsWith("start "))).toHaveLength(1);
  expect(log().filter((line) => line.startsWith("reuse "))).toEqual(["reuse node@22"]);
  const lines = log();
  const end = lines.findIndex((line) => line.startsWith("end "));
  const reuse = lines.indexOf("reuse node@22");
  expect(reuse).toBeGreaterThan(end);
  expect(notices.flat()).toEqual([
    "Waiting for another task on this runner to finish installing runtimes.",
  ]);
});

/**
 * Run a task whose agent records `PATH`, the `node` it finds and the `bun` it resolves, then
 * runs a Closeout check that records the same. A fake system node sits on both the agent's and
 * the worker's `PATH`. `base` replaces the agent's `PATH` after that node, and `workerExtra`
 * goes in front of the worker's own `PATH`.
 */
async function runPathTask(
  name: string,
  runtimes: Array<{ tool: string; version: string }>,
  paths: { base?: string; workerExtra?: string; resumeSessionId?: string; workTurn?: boolean } = {},
) {
  const task = join(root, name);
  const workRoot = join(task, "work");
  const worktree = join(workRoot, executionId);
  const outputDirectory = join(task, paths.resumeSessionId ? "resumed-output" : "output");
  const system = join(task, "system");
  for (const path of [worktree, outputDirectory, system])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(worktree, 0o770);
  writeFileSync(join(system, "node"), `#!/bin/sh\necho ${join(system, "node")}\n`);
  chmodSync(join(system, "node"), 0o755);
  const git = (...args: string[]) => {
    const done = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    if (done.status !== 0) throw new Error(done.stderr);
  };
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.email=t@example.test",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(worktree, ".agents"), { recursive: true });
  writeFileSync(
    join(worktree, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: which-node",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ["sh", "-c", "printf '%s\\\\n' \\"$PATH\\" > closeout-path.txt; node > closeout-node.txt; command -v bun > closeout-bun.txt || true"]`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  const bundle = join(task, "repository.bundle");
  let workCommand: Extract<RunnerCommand, { type: "run" }> | undefined;
  if (paths.workTurn) {
    git("add", ".agents/closeout.yaml");
    git(
      "-c",
      "user.email=t@example.test",
      "-c",
      "user.name=T",
      "commit",
      "--allow-empty",
      "-qm",
      "check",
    );
    git("bundle", "create", bundle, "--all");
    const {
      purpose: _purpose,
      sessionId: _session,
      sessionGeneration: _generation,
      taskModeGeneration: _mode,
      ...base
    } = command(runtimes);
    workCommand = {
      ...base,
      type: "run",
      checkpoint: false,
      repository: {
        owner: "fixture",
        repo: "repo",
        remoteUrl: "https://github.com/fixture/repo.git",
        baseSha: spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim(),
      },
      ...(paths.resumeSessionId ? { resumeSessionId: paths.resumeSessionId } : {}),
    };
  }
  const script = join(task, "script.json");
  const recorded = join(task, "agent.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      loadSession: true,
      steps: [
        {
          type: "terminal",
          command: "sh",
          args: [
            "-c",
            `printf '%s\\n' "$PATH" > agent-path.txt; node > agent-node.txt; command -v bun > agent-bun.txt || true`,
          ],
        },
        { type: "run_closeout", id: "which-node" },
        { type: "end" },
      ],
    }),
  );
  const agentPath = `${system}:${paths.base ?? `${dirname(process.execPath)}:/usr/bin:/bin`}`;
  const workerPath = process.env.PATH;
  // A runner host already has the agent tools folder on PATH; the expectations add it themselves.
  const inherited = (workerPath ?? "")
    .split(":")
    .filter((entry) => entry.replace(/\/+$/, "") !== AGENT_BIN_DIR)
    .join(":");
  process.env.PATH = [system, paths.workerExtra, inherited].filter(Boolean).join(":");
  try {
    const result = await executeRunnerCommand({
      job: { executionId, command: workCommand ?? command(runtimes) },
      ...(workCommand ? { repositoryBundle: bundle } : {}),
      outputDirectory,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      mise: { path: mise },
      launch: {
        command: process.execPath,
        args: [
          "--no-env-file",
          fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
          recorded,
          script,
        ],
        env: { PATH: agentPath },
      },
      ...(workCommand
        ? {}
        : {
            async answer() {
              return { answer: "Yes" };
            },
          }),
    });
    const read = (file: string) =>
      readFileSync(join(paths.workTurn ? join(workRoot, "run") : worktree, file), "utf8").trim();
    const trace = JSON.parse(readFileSync(recorded, "utf8")) as {
      closeouts?: string[];
      loaded?: { sessionId: string };
    };
    if (paths.resumeSessionId) expect(trace.loaded?.sessionId).toBe(paths.resumeSessionId);
    return {
      result,
      closeouts: trace.closeouts ?? [],
      agentPath,
      workerPath: process.env.PATH,
      system: join(system, "node"),
      agent: { path: read("agent-path.txt"), node: read("agent-node.txt") },
      closeout: { path: read("closeout-path.txt"), node: read("closeout-node.txt") },
      bun: { agent: read("agent-bun.txt"), closeout: read("closeout-bun.txt") },
    };
  } finally {
    if (workerPath === undefined) delete process.env.PATH;
    else process.env.PATH = workerPath;
  }
}

test("the agent and a Closeout check find the task's node before the system one", async () => {
  const run = await runPathTask("node", [{ tool: "node", version: "22" }]);
  expect(run.result.run.stopReason).toBe("end_turn");
  expect(run.closeouts).toEqual(["which-node passed."]);
  const bin = join(runnerMiseDirectories(home).dataDir, "installs", "node", "22", "bin");
  expect(run.agent.node).toBe(join(bin, "node"));
  expect(run.agent.path).toBe(`${bin}:${run.agentPath}:${AGENT_BIN_DIR}`);
  expect(run.closeout.node).toBe(join(bin, "node"));
  expect(run.closeout.path).toBe(`${bin}:${withAgentBin(withoutRunnerBin(run.agentPath))}`);
  expect(log()).toContain("where node@22");
}, 30_000);

test("with no runtimes, the agent's and a Closeout check's PATH gain only the agent tools folder", async () => {
  // This run has no GitHub read token: the folder is there anyway, and its gh is not signed in.
  const run = await runPathTask("none", []);
  expect(run.result.run.stopReason).toBe("end_turn");
  expect(run.closeouts).toEqual(["which-node passed."]);
  expect(run.agent).toEqual({ path: `${run.agentPath}:${AGENT_BIN_DIR}`, node: run.system });
  expect(run.closeout).toEqual({
    path: withAgentBin(withoutRunnerBin(run.agentPath)),
    node: run.system,
  });
  expect(log()).toEqual([]);
}, 30_000);

test("the agent's and a Closeout check's PATH never have the runner's bin folder", async () => {
  const run = await runPathTask("runner-bin", [{ tool: "node", version: "22" }], {
    base: `${RUNNER_BIN_DIR}:/usr/bin:/bin`,
    workerExtra: RUNNER_BIN_DIR,
  });
  expect(run.result.run.stopReason).toBe("end_turn");
  expect(run.closeouts).toEqual(["which-node passed."]);
  for (const path of [run.agent.path, run.closeout.path]) {
    expect(path.split(":")).not.toContain(RUNNER_BIN_DIR);
    expect(path.split(":").at(-1)).toBe(AGENT_BIN_DIR);
  }
  expect(run.workerPath!.split(":")).toContain(RUNNER_BIN_DIR);
}, 30_000);

test("bun resolves for the agent and a Closeout check only when the job's runtimes include it", async () => {
  // No Bun on this PATH but the runner's own, which tasks must not see.
  const base = `${RUNNER_BIN_DIR}:/usr/bin:/bin`;
  const without = await runPathTask("no-bun", [{ tool: "node", version: "22" }], {
    base,
    workerExtra: RUNNER_BIN_DIR,
  });
  for (const found of [without.bun.agent, without.bun.closeout])
    expect(found.startsWith(`${RUNNER_BIN_DIR}/`)).toBe(false);
  const runtime = join(runnerMiseDirectories(home).dataDir, "installs", "bun", "1.4.2", "bin");
  const withBun = await runPathTask("bun", [{ tool: "bun", version: "1.4.2" }], {
    base,
    workerExtra: RUNNER_BIN_DIR,
  });
  expect(withBun.result.run.stopReason).toBe("end_turn");
  expect(withBun.bun).toEqual({ agent: join(runtime, "bun"), closeout: join(runtime, "bun") });
}, 60_000);

// Question answers and start_work both launch work commands with resumeSessionId.
// Change the worker environment between turns to catch accidental runtime inheritance.
for (const reason of ["question answer", "start_work"]) {
  test(`Closeout PATH matches a fresh turn after ${reason} resumes the session`, async () => {
    const runtimes = [{ tool: "bun", version: "1.4.2" }];
    const paths = { base: "/usr/bin:/bin", workTurn: true };
    const fresh = await runPathTask(reason, runtimes, paths);
    const resumed = await runPathTask(reason, runtimes, {
      ...paths,
      resumeSessionId: fresh.result.run.sessionId!,
      workerExtra: "/accidental/node/bin",
    });
    expect(fresh.result.run.stopReason).toBe("end_turn");
    expect(resumed.result.run.stopReason).toBe("end_turn");
    expect(resumed.closeouts).toEqual(["which-node passed."]);
    expect(resumed.closeout.path).toBe(fresh.closeout.path);
    expect(resumed.closeout.path).toBe(resumed.agent.path);
    expect(resumed.closeout.path).not.toContain("/accidental/node/bin");
  }, 60_000);
}

test("withAgentBin puts the agent tools folder last, once", () => {
  expect(withAgentBin(`/runtime/bin:${AGENT_BIN_DIR}/:/usr/bin`)).toBe(
    `/runtime/bin:/usr/bin:${AGENT_BIN_DIR}`,
  );
  expect(withAgentBin(undefined)).toBe(AGENT_BIN_DIR);
});

test("withoutRunnerBin drops only the runner's bin folder", () => {
  expect(withoutRunnerBin(`/a:${RUNNER_BIN_DIR}:/b:${RUNNER_BIN_DIR}/:/opt/paws-runner/bin2`)).toBe(
    "/a:/b:/opt/paws-runner/bin2",
  );
  expect(withoutRunnerBin(undefined)).toBe("");
});

test("installRuntimes returns each runtime's pinned bin dir in order", async () => {
  const result = await installRuntimes({
    runtimes: [
      { tool: "python", version: "3.12" },
      { tool: "node", version: "22" },
    ],
    home,
    mise,
  });
  const installs = join(runnerMiseDirectories(home).dataDir, "installs");
  expect(result).toMatchObject({
    ok: true,
    binPaths: [join(installs, "python", "3.12", "bin"), join(installs, "node", "22", "bin")],
  });
  expect(prependRuntimePath([], "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  expect(prependRuntimePath(["/a/bin", "/b/bin"], "/usr/bin")).toBe("/a/bin:/b/bin:/usr/bin");
});

test("a later install finds the runtimes installed before it on PATH", async () => {
  const result = await installRuntimes({
    runtimes: [
      { tool: "node", version: "22" },
      { tool: "npm:prettier", version: "3" },
    ],
    home,
    mise,
  });
  expect(result.ok).toBe(true);
  const node = join(runnerMiseDirectories(home).dataDir, "installs", "node", "22", "bin");
  const paths = readFileSync(join(dirname(mise), "path.log"), "utf8")
    .trim()
    .split("\n");
  expect(paths).toEqual([
    "node@22 /opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
    `npm:prettier@3 ${node}:/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin`,
  ]);
});

test("a runtime mise cannot locate fails the install with its name", async () => {
  writeFileSync(
    mise,
    FAKE_MISE.replace(
      'if [ "$1" = where ]; then',
      'if [ "$1" = where ]; then echo "lost" >&2; exit 3; fi\nif false; then',
    ),
  );
  const result = await installRuntimes({ runtimes: [{ tool: "node", version: "22" }], home, mise });
  expect(result).toMatchObject({
    ok: false,
    runtime: { tool: "node", version: "22" },
    message: "Paws could not find the installed runtime node@22: mise exited with code 3: lost",
  });
});

function binPathsFor(tool: string, lines: string) {
  writeFileSync(join(dirname(mise), `bin-paths-${tool}`), lines);
}

test("a tool whose binary sits in a nested folder gets the folder mise reports", async () => {
  binPathsFor("golangci-lint", "@TARGET@/golangci-lint-2.11.4-linux-amd64\n");
  const result = await installRuntimes({
    runtimes: [{ tool: "golangci-lint", version: "2.11.4" }],
    home,
    mise,
  });
  const install = join(runnerMiseDirectories(home).dataDir, "installs", "golangci-lint", "2.11.4");
  expect(result).toMatchObject({
    ok: true,
    binPaths: [join(install, "golangci-lint-2.11.4-linux-amd64")],
  });
});

test("a core tool keeps its bin folder and runtime order still decides precedence", async () => {
  binPathsFor("node", "@TARGET@/bin\n");
  binPathsFor("golangci-lint", "@TARGET@/golangci-lint-2.11.4-linux-amd64\n");
  const result = await installRuntimes({
    runtimes: [
      { tool: "node", version: "22" },
      { tool: "golangci-lint", version: "2.11.4" },
    ],
    home,
    mise,
  });
  const installs = join(runnerMiseDirectories(home).dataDir, "installs");
  expect(result).toMatchObject({
    ok: true,
    binPaths: [
      join(installs, "node", "22", "bin"),
      join(installs, "golangci-lint", "2.11.4", "golangci-lint-2.11.4-linux-amd64"),
    ],
  });
});

test("a tool with two bin folders keeps both in mise's order", async () => {
  binPathsFor("acme-tool", "@TARGET@/bin\n@TARGET@/libexec/bin\n");
  const result = await installRuntimes({
    runtimes: [{ tool: "acme-tool", version: "1.0.0" }],
    home,
    mise,
  });
  const install = join(runnerMiseDirectories(home).dataDir, "installs", "acme-tool", "1.0.0");
  expect(result).toMatchObject({
    ok: true,
    binPaths: [join(install, "bin"), join(install, "libexec", "bin")],
  });
});

test("when mise bin-paths fails the install falls back to the bin folder under mise where", async () => {
  const result = await installRuntimes({
    runtimes: [{ tool: "acme-tool", version: "1.0.0" }],
    home,
    mise,
  });
  const install = join(runnerMiseDirectories(home).dataDir, "installs", "acme-tool", "1.0.0");
  expect(result).toMatchObject({ ok: true, binPaths: [join(install, "bin")] });
});

test("a relative bin path or one with a path delimiter fails the install", async () => {
  binPathsFor("acme-tool", "relative/bin\n");
  const relative = await installRuntimes({
    runtimes: [{ tool: "acme-tool", version: "1.0.0" }],
    home,
    mise,
  });
  expect(relative).toMatchObject({ ok: false, runtime: { tool: "acme-tool", version: "1.0.0" } });
  binPathsFor("acme-tool", "@TARGET@/a:@TARGET@/b\n");
  const joined = await installRuntimes({
    runtimes: [{ tool: "acme-tool", version: "1.0.0" }],
    home,
    mise,
  });
  expect(joined).toMatchObject({ ok: false, runtime: { tool: "acme-tool", version: "1.0.0" } });
});
