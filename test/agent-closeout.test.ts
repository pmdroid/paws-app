import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import {
  beginImplementRun,
  insertQueuedItem,
  insertRun,
  listAgentCloseout,
  recordAgentCloseout,
  releaseRunCapacity,
  setCurrentRun,
} from "../src/db";
import { createLiveStatusProvider } from "../src/web/src/live/provider";
import { parseStatusItemDetail, parseStatusSnapshot } from "../src/web/src/contract";
import { tempDb, tempHome } from "./helpers";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const TOKEN = `ghp_${"x".repeat(36)}`;

test("the agent's get_closeout, failed run_closeout, fix and passing run_closeout reach the status API in order", async () => {
  const home = tempHome();
  homes.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, "src"));
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "user.name", "Test"]);
  mkdirSync(join(workspace, "scripts"));
  writeFileSync(
    join(workspace, "scripts", "verify.js"),
    `const text = require("node:fs").readFileSync("src/main.ts", "utf8");
console.log("checking main.ts ${TOKEN}");
if (!text.includes("fixed")) {
  console.error("expected fixed, received broken");
  process.exit(1);
}
`,
  );
  writeFileSync(
    join(workspace, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "retry:",
      "  maxFailedAttemptsPerItem: 3",
      "  scope: task",
      "setup:",
      "  - id: install",
      `    exec: ["bun", "--version"]`,
      "    timeoutSeconds: 30",
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ["bun", "scripts/verify.js"]`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  writeFileSync(join(workspace, "README.md"), "hello\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "init"]);
  git(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const head = git(workspace, ["rev-parse", "HEAD"]);

  const db = tempDb();
  insertQueuedItem(db, { id: "ENG-7", title: "Escape quotes", now: 1 });
  const { run } = beginImplementRun(db, "ENG-7", 2);
  const main = join(workspace, "src", "main.ts");
  const steps: FakeScript["steps"] = [
    { type: "fs_write", path: main, content: "export const state = 'broken';\n" },
    { type: "get_closeout" },
    { type: "run_closeout", id: "test" },
    { type: "fs_write", path: main, content: "export const state = 'fixed';\n" },
    { type: "run_closeout", id: "test" },
    { type: "get_closeout" },
    { type: "end" },
  ];
  const script = join(home, "script.json");
  const trace = join(home, "trace.json");
  writeFileSync(script, JSON.stringify({ steps }));
  let clock = 1_000;
  await runAgent({
    role: "implementer",
    itemId: "ENG-7",
    runId: run.id,
    prompt: "Fix the quotes.",
    worktreePath: workspace,
    pawsRoot: home,
    home,
    checkpoint: false,
    command: process.execPath,
    args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    postUpdate: { post: async () => ({ posted: true }) },
    closeoutProgress: {
      record(progress) {
        clock += 1_000;
        recordAgentCloseout(db, run.id, "ENG-7", progress, clock);
      },
    },
  });
  const recorded = JSON.parse(readFileSync(trace, "utf8")) as { closeouts: string[] };
  expect(recorded.closeouts).toHaveLength(4);
  expect(recorded.closeouts[1]).toStartWith("test failed (exit 1).");
  expect(recorded.closeouts[2]).toBe("test passed.");
  expect(listAgentCloseout(db, [run.id]).map((event) => event.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);

  const provider = createLiveStatusProvider(db, { now: () => new Date(clock) });
  const list = parseStatusSnapshot(JSON.parse(JSON.stringify(provider.snapshot())));
  if (!list.ok) throw new Error(list.error);
  expect(list.snapshot.agentCloseout?.find((entry) => entry.runId === run.id)).toEqual({
    itemId: "ENG-7",
    runId: run.id,
    decision: "accepted",
    headSha: head,
    blocked: null,
    updatedAt: expect.any(String),
  });
  const body = JSON.stringify(provider.item("ENG-7"));
  expect(body).not.toContain(TOKEN);
  const detail = parseStatusItemDetail(JSON.parse(body));
  if (!detail.ok) throw new Error(detail.error);
  const agent = detail.detail.agentCloseout?.find((entry) => entry.runId === run.id);
  expect(agent).toBeDefined();
  expect(agent!.itemId).toBe("ENG-7");
  expect(agent!.maxAttempts).toBe(3);
  expect(agent!.steps.map((step) => [step.tool, step.checkId, step.state, step.attempt])).toEqual([
    ["get_closeout", null, "reported", null],
    ["run_closeout", "install", "running", 1],
    ["run_closeout", "install", "passed", 1],
    ["run_closeout", "test", "running", 1],
    ["run_closeout", "test", "failed", 1],
    ["run_closeout", "test", "running", 2],
    ["run_closeout", "test", "passed", 2],
    ["get_closeout", null, "reported", null],
  ]);
  expect(agent!.steps.every((step) => step.headSha === head)).toBe(true);

  expect(agent!.attempts.map((attempt) => attempt.decision)).toEqual(["rejected", "accepted"]);
  const [first, second] = agent!.attempts;
  const failed = first!.checks.find((check) => check.id === "test")!;
  expect(failed).toMatchObject({ state: "failed", attempt: 1, exitCode: 1 });
  expect(failed.stdout ?? null).toBeNull();
  expect(failed.stderr ?? null).toBeNull();
  const log = provider.checkLog({
    itemId: "ENG-7",
    attempt: first!.number,
    checkId: "test",
    run: run.id,
  })!;
  expect(log.stderr).toContain("expected fixed, received broken");
  expect(log.stdout).toContain("checking main.ts");
  expect(log.stdout).not.toContain(TOKEN);
  expect(second!.checks.map((check) => [check.id, check.state, check.attempt])).toEqual([
    ["install", "passed", 1],
    ["test", "passed", 2],
  ]);
}, 30_000);

test("a running check reports how long it has run and a later stale report sends it back to pending", () => {
  const db = tempDb();
  insertQueuedItem(db, { id: "ENG-8", title: "Stale", now: 1 });
  const { run } = beginImplementRun(db, "ENG-8", 2);
  const head = "a".repeat(40);
  const attempt = {
    head,
    id: "lint",
    kind: "command",
    command: "bun run lint",
    attempt: 1,
    maxAttempts: null,
  };
  recordAgentCloseout(db, run.id, "ENG-8", { type: "started", ...attempt }, 10_000);
  const running = createLiveStatusProvider(db, { now: () => new Date(25_000) })
    .item("ENG-8")!
    .agentCloseout!.find((entry) => entry.runId === run.id)!;
  expect(running.attempts.at(-1)!.checks[0]).toMatchObject({
    state: "running",
    elapsedMs: 15_000,
    active: true,
  });
  recordAgentCloseout(
    db,
    run.id,
    "ENG-8",
    {
      type: "finished",
      ...attempt,
      state: "passed",
      exitCode: 0,
      timedOut: false,
      durationMs: 900,
      stdout: "x".repeat(70_000),
      stderr: "",
      truncated: false,
    },
    26_000,
  );
  recordAgentCloseout(
    db,
    run.id,
    "ENG-8",
    {
      type: "report",
      head: "b".repeat(40),
      maxAttempts: null,
      checks: [
        {
          id: "lint",
          kind: "command",
          command: "bun run lint",
          status: "stale",
          failedAttempts: 0,
        },
      ],
      blocked: null,
    },
    27_000,
  );
  const stale = createLiveStatusProvider(db)
    .item("ENG-8")!
    .agentCloseout!.find((entry) => entry.runId === run.id)!;
  expect(stale.attempts.at(-1)!.checks[0]!.state).toBe("pending");
  const stored = listAgentCloseout(db, [run.id])[1]!.progress;
  expect(stored.type === "finished" && stored.truncated).toBe(true);
  expect(stored.type === "finished" && Buffer.byteLength(stored.stdout)).toBe(64 * 1024);
});

test("a check still running when its run ended stops at the run's end and points to the task's newer run", () => {
  const db = tempDb();
  insertQueuedItem(db, { id: "ENG-10", title: "Restart", now: 1 });
  const { run } = beginImplementRun(db, "ENG-10", 2);
  recordAgentCloseout(
    db,
    run.id,
    "ENG-10",
    {
      type: "started",
      head: "a".repeat(40),
      id: "test",
      kind: "command",
      command: "bun test",
      attempt: 1,
      maxAttempts: 3,
    },
    10_000,
  );
  releaseRunCapacity(db, run.id, 575_000);
  const next = insertRun(db, { itemId: "ENG-10", now: 600_000 });
  setCurrentRun(db, "ENG-10", next.id);
  recordAgentCloseout(
    db,
    next.id,
    "ENG-10",
    {
      type: "started",
      head: "b".repeat(40),
      id: "lint",
      kind: "command",
      command: "bun run lint",
      attempt: 1,
      maxAttempts: 3,
    },
    610_000,
  );
  const parsed = parseStatusItemDetail(
    JSON.parse(
      JSON.stringify(
        createLiveStatusProvider(db, { now: () => new Date(3_600_000) }).item("ENG-10"),
      ),
    ),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const ended = parsed.detail.agentCloseout!.find((entry) => entry.runId === run.id)!;
  expect(ended.endedAt).toBe(new Date(575_000).toISOString());
  expect(ended.continuesIn).toBe(next.id);
  expect(ended.attempts.at(-1)!.checks[0]).toMatchObject({
    state: "stopped",
    elapsedMs: 565_000,
    active: false,
    detail: "Stopped: the run ended before this check finished.",
  });
  const current = parsed.detail.agentCloseout!.find((entry) => entry.runId === next.id)!;
  expect(current.endedAt).toBeUndefined();
  expect(current.continuesIn).toBeUndefined();
  expect(current.attempts.at(-1)!.checks[0]).toMatchObject({
    state: "running",
    elapsedMs: 2_990_000,
  });
});

test("an evidence check takes its state from the report and lets the round finish", () => {
  const db = tempDb();
  insertQueuedItem(db, { id: "ENG-9", title: "Proof", now: 1 });
  const { run } = beginImplementRun(db, "ENG-9", 2);
  const head = "c".repeat(40);
  const proof = {
    id: "visual-proof",
    kind: "evidence",
    command: "Screenshot each changed screen.",
    failedAttempts: 0,
  };
  const lint = { head, id: "lint", kind: "command", command: "bun run lint", attempt: 1 };
  const report = (lintStatus: string, status: string, at: number) =>
    recordAgentCloseout(
      db,
      run.id,
      "ENG-9",
      {
        type: "report",
        head,
        maxAttempts: null,
        checks: [
          {
            id: "lint",
            kind: "command",
            command: "bun run lint",
            status: lintStatus,
            failedAttempts: 0,
          },
          { ...proof, status },
        ],
        blocked: null,
      },
      at,
    );
  report("missing", "missing", 10_000);
  recordAgentCloseout(db, run.id, "ENG-9", { type: "started", ...lint, maxAttempts: null }, 11_000);
  recordAgentCloseout(
    db,
    run.id,
    "ENG-9",
    {
      type: "finished",
      ...lint,
      maxAttempts: null,
      state: "passed",
      exitCode: 0,
      timedOut: false,
      durationMs: 900,
      stdout: "",
      stderr: "",
      truncated: false,
    },
    12_000,
  );
  const attemptOf = () => {
    const parsed = parseStatusItemDetail(
      JSON.parse(JSON.stringify(createLiveStatusProvider(db).item("ENG-9"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.detail.agentCloseout!.find((entry) => entry.runId === run.id)!.attempts.at(-1)!;
  };
  expect(attemptOf().checks.find((check) => check.id === "visual-proof")).toMatchObject({
    kind: "evidence",
    state: "pending",
  });
  expect(attemptOf().decision).toBe("running");
  report("passed", "passed", 13_000);
  expect(attemptOf().checks.find((check) => check.id === "visual-proof")).toMatchObject({
    kind: "evidence",
    state: "passed",
  });
  expect(attemptOf().decision).toBe("accepted");
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
