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
import type { RunnerCommand } from "../src/runner-protocol";
import { installRuntimes, prependRuntimePath, runnerMiseDirectories } from "../src/runner-mise";
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
target="$MISE_DATA_DIR/installs/$tool/$version"
if [ "$1" = where ]; then
  echo "where $spec" >> "$log"
  [ -d "$target" ] || { echo "mise ERROR $spec is not installed" >&2; exit 1; }
  echo "$target"
  exit 0
fi
[ "$1" = install ] || { echo "unexpected $*" >&2; exit 2; }
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
    .map((line) => JSON.parse(line) as { type: string; text?: string });
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
  const installed = first.events.findIndex(
    (event) =>
      event.type === "progress" &&
      event.text?.startsWith("Installed runtimes node@22, python@3.12 in "),
  );
  expect(installed).toBeGreaterThanOrEqual(0);
  expect(first.events.findIndex((event) => event.type === "acp")).toBeGreaterThan(installed);
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
 * Run a task whose agent records `PATH` and the `node` it finds, then runs a Closeout check
 * that records the same. A fake system node sits on both the agent's and the worker's `PATH`.
 */
async function runPathTask(name: string, runtimes: Array<{ tool: string; version: string }>) {
  const task = join(root, name);
  const workRoot = join(task, "work");
  const worktree = join(workRoot, executionId);
  const outputDirectory = join(task, "output");
  const system = join(task, "system");
  for (const path of [worktree, outputDirectory, system])
    mkdirSync(path, { recursive: true, mode: 0o700 });
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
  mkdirSync(join(worktree, ".agents"));
  writeFileSync(
    join(worktree, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: which-node",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ["sh", "-c", "printf '%s\\\\n' \\"$PATH\\" > closeout-path.txt; node > closeout-node.txt"]`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
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
          args: ["-c", `printf '%s\\n' "$PATH" > agent-path.txt; node > agent-node.txt`],
        },
        { type: "run_closeout", id: "which-node" },
        { type: "end" },
      ],
    }),
  );
  const agentPath = `${system}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const workerPath = process.env.PATH;
  process.env.PATH = `${system}:${workerPath ?? ""}`;
  try {
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
        env: { PATH: agentPath },
      },
      async answer() {
        return { answer: "Yes" };
      },
    });
    const read = (file: string) => readFileSync(join(worktree, file), "utf8").trim();
    const trace = JSON.parse(readFileSync(recorded, "utf8")) as { closeouts?: string[] };
    return {
      result,
      closeouts: trace.closeouts ?? [],
      agentPath,
      workerPath: process.env.PATH,
      system: join(system, "node"),
      agent: { path: read("agent-path.txt"), node: read("agent-node.txt") },
      closeout: { path: read("closeout-path.txt"), node: read("closeout-node.txt") },
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
  expect(run.agent.path).toBe(`${bin}:${run.agentPath}`);
  expect(run.closeout.node).toBe(join(bin, "node"));
  expect(run.closeout.path).toBe(`${bin}:${run.workerPath}`);
  expect(log()).toContain("where node@22");
}, 30_000);

test("with no runtimes, the agent's and a Closeout check's PATH are unchanged", async () => {
  const run = await runPathTask("none", []);
  expect(run.result.run.stopReason).toBe("end_turn");
  expect(run.closeouts).toEqual(["which-node passed."]);
  expect(run.agent).toEqual({ path: run.agentPath, node: run.system });
  expect(run.closeout).toEqual({ path: run.workerPath!, node: run.system });
  expect(log()).toEqual([]);
}, 30_000);

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
