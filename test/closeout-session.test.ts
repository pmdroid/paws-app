import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { closeoutPrompt, fixPrompt, implementPrompt } from "../src/loop/agents";

const roots: string[] = [];

const local = (root: string) => ({ policy: async () => workspacePolicyFiles(root) });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("implement and fix prompts tell the agent to call get_closeout", () => {
  const text = closeoutPrompt();
  expect(text).toContain("get_closeout");
  expect(text).toContain("run_closeout");
  expect(text).toContain("pending");
  expect(implementPrompt({ identifier: "ENG-1", title: "Add the tool" })).toContain(text);
  expect(
    fixPrompt({
      taskId: "t",
      worktree: "/tmp",
      fixAttempt: 1,
      maxFixAttempts: 3,
      base: "abc",
      head: "def",
      items: [],
      reviewFindings: [],
      summary: "no",
    }),
  ).toContain(text);
});

test("a preview check is pending human acceptance and is never run as a command", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    "  - id: live-preview",
    "    type: preview",
    "    approval: human",
  ]);
  writeFileSync(join(root, "src", "ui.ts"), "export const title = 'Fixture';\n");
  const session = createCloseoutSession(root, local(root));
  const report = JSON.parse(await session.report());
  expect(report.required).toMatchObject([
    { id: "live-preview", kind: "preview", status: "pending" },
  ]);
  expect(report.pending).not.toContain("live-preview");
  expect(await session.run("live-preview")).toContain("Call show_preview");
});

test("get_closeout reports path matches and run_closeout runs the pending id", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "setup:",
    "  - id: prepare",
    '    exec: ["true"]',
    "    timeoutSeconds: 30",
    "items:",
    command("engine", ["true"], "src/**"),
    command("docs", ["true"], "docs/**"),
    review("src/**"),
  ]);
  const session = createCloseoutSession(root, local(root));
  expect(JSON.parse(await session.report())).toEqual({
    required: [],
    pending: [],
    blocked: null,
    bypassed: false,
  });

  writeFileSync(join(root, "docs", "note.md"), "note\n");
  const docs = JSON.parse(await session.report()) as Report;
  expect(docs.pending).toEqual(["prepare", "docs"]);
  expect(docs.required.map((item) => item.id)).toEqual(["prepare", "docs"]);
  expect(docs.blocked).toBeNull();

  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const src = JSON.parse(await session.report()) as Report;
  expect(src.pending).toEqual(["prepare", "engine", "docs"]);
  expect(src.required.map((item) => item.id)).toEqual(["prepare", "engine", "docs", "review"]);
  const engine = src.required.find((item) => item.id === "engine");
  const reviewed = src.required.find((item) => item.id === "review");
  expect(engine).toMatchObject({
    kind: "command",
    hint: "Run true",
    matched_paths: ["src/main.ts"],
    status: "missing",
    failed_attempts: 0,
    remaining_attempts: 3,
    retry_scope: null,
    different_model: false,
  });
  expect(reviewed).toMatchObject({
    kind: "review",
    hint: "Review using .agents/skills/review/SKILL.md",
    matched_paths: ["src/main.ts"],
    status: "missing",
    different_model: true,
  });
  expect(src.pending).not.toContain("review");

  expect(await session.run("engine")).toBe("engine passed.");
  expect(await session.run("review")).toContain("independent reviewer");
  const passed = JSON.parse(await session.report()) as Report;
  expect(passed.pending).toEqual(["docs"]);
  expect(passed.required.find((item) => item.id === "prepare")?.status).toBe("passed");
  expect(passed.required.find((item) => item.id === "engine")?.status).toBe("passed");
  expect(passed.required.find((item) => item.id === "review")?.status).toBe("missing");

  writeFileSync(join(root, "src", "main.ts"), "export const value = 2;\n");
  const stale = JSON.parse(await session.report()) as Report;
  expect(stale.required.find((item) => item.id === "engine")?.status).toBe("stale");
  expect(stale.required.find((item) => item.id === "prepare")?.status).toBe("passed");
  expect(stale.pending).toEqual(["engine", "docs"]);
});

test("review reports expose both configured limits rather than an ordinary remaining scalar", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "retry:",
    "  maxFailedAttemptsPerItem: 3",
    "  scope: task",
    "  maxFailedReviewAttempts: 12",
    "items:",
    review("src/**"),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "changed\n");
  const report = JSON.parse(await createCloseoutSession(root, local(root)).report());
  expect(report.required[0]).toMatchObject({
    remaining_attempts: null,
    retry_limits: { max_failed_attempts_per_key: 3, max_failed_review_attempts: 12 },
  });
});

test("a path miss is not required and is not run", async () => {
  const root = initRepo();
  const mark = join(root, "ran.txt");
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command(
      "engine",
      [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(mark)}, "x")`],
      "src/**",
    ),
  ]);
  writeFileSync(join(root, "docs", "note.md"), "note\n");
  const session = createCloseoutSession(root, local(root));
  const report = JSON.parse(await session.report()) as Report;
  expect(report.required).toEqual([]);
  expect(await session.run("engine")).toBe("Check engine is not required for the current changes.");
  expect(() => readFileSync(mark, "utf8")).toThrow();
});

test("exhausted retries block another run", async () => {
  const root = initRepo();
  const mark = join(root, "runs.txt");
  writePolicy(root, [
    'specVersion: "0.1"',
    "retry:",
    "  maxFailedAttemptsPerItem: 2",
    "  scope: candidate",
    "items:",
    command("failing", [
      process.execPath,
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(mark)}, "x"); process.exit(1)`,
    ]),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const session = createCloseoutSession(root, local(root));
  expect(await session.run("failing")).toContain("failing failed");
  const once = JSON.parse(await session.report()) as Report;
  expect(once.required[0]).toMatchObject({
    status: "failed",
    failed_attempts: 1,
    remaining_attempts: 1,
    retry_scope: "candidate",
  });
  expect(once.blocked).toBeNull();
  expect(await session.run("failing")).toContain("failing failed");
  const twice = JSON.parse(await session.report()) as Report;
  expect(twice.required[0]?.status).toBe("exhausted");
  expect(twice.pending).toEqual([]);
  expect(twice.blocked).toContain("Check failing is exhausted");
  expect(await session.run("failing")).toContain("exhausted");
  expect(readFileSync(mark, "utf8")).toBe("xx");
});

test("a failed check keeps its full output in an ignored log without staling other checks", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command("quick", ["true"]),
    command("noisy", [
      process.execPath,
      "-e",
      'console.log("expected 1, received 2"); console.log("ok\\n".repeat(20000)); process.exit(1)',
    ]),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const session = createCloseoutSession(root, local(root));
  expect(await session.run("quick")).toBe("quick passed.");
  const failed = await session.run("noisy");
  expect(failed).not.toContain("expected 1, received 2");
  expect(failed).toContain("Full output: .paws-closeout/noisy.log");
  expect(readFileSync(join(root, ".paws-closeout", "noisy.log"), "utf8")).toStartWith(
    "expected 1, received 2\n",
  );
  const report = JSON.parse(await session.report()) as Report;
  expect(report.required.find((item) => item.id === "quick")?.status).toBe("passed");
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  expect(status.stdout).not.toContain(".paws-closeout");
});

test("a denied command does not spawn and does not count as a failure", async () => {
  const root = initRepo();
  const mark = join(root, "ran.txt");
  let allow = false;
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command("failing", [
      process.execPath,
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(mark)}, "x"); process.exit(1)`,
    ]),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const session = createCloseoutSession(root, {
    ...local(root),
    allowCommand() {
      if (!allow) throw new Error("path is under ~/.ssh");
    },
  });
  expect(await session.run("failing")).toBe("path is under ~/.ssh");
  expect(() => readFileSync(mark, "utf8")).toThrow();
  const denied = JSON.parse(await session.report()) as Report;
  expect(denied.required[0]).toMatchObject({ status: "missing", failed_attempts: 0 });
  allow = true;
  expect(await session.run("failing")).toContain("failing failed");
  const failed = JSON.parse(await session.report()) as Report;
  expect(failed.required[0]).toMatchObject({ status: "failed", failed_attempts: 1 });
  expect(readFileSync(mark, "utf8")).toBe("x");
});

test("abort kills the closeout process group without counting a failure", async () => {
  const root = initRepo();
  const mark = join(root, "pid.txt");
  const script = [
    'const {spawn}=require("child_process");',
    'const fs=require("fs");',
    'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});',
    `fs.writeFileSync(${JSON.stringify(mark)}, process.pid+"\\n"+child.pid);`,
    "setInterval(()=>{},1000);",
  ].join("");
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command("hang", [process.execPath, "-e", script]),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const controller = new AbortController();
  const session = createCloseoutSession(root, { ...local(root), signal: controller.signal });
  try {
    const pending = session.run("hang");
    const recorded = await waitForText(mark);
    const ids = recorded
      .trim()
      .split("\n")
      .map((value) => Number(value));
    const leader = ids[0] ?? 0;
    const grandchild = ids[1] ?? 0;
    expect(leader).toBeGreaterThan(0);
    expect(grandchild).toBeGreaterThan(0);
    controller.abort();
    expect(await pending).toBe("hang was cancelled.");
    await waitFor(() => !alive(leader) && !alive(grandchild));
    const report = JSON.parse(await session.report()) as Report;
    expect(report.required[0]).toMatchObject({ status: "missing", failed_attempts: 0 });
  } finally {
    controller.abort();
  }
});

test("committed changes since origin/main stay required", async () => {
  const root = initRepo();
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  git(root, ["add", "src/main.ts"]);
  git(root, ["commit", "-m", "engine"]);
  writePolicy(root, ['specVersion: "0.1"', "items:", command("engine", ["true"], "src/**")]);
  const report = JSON.parse(await createCloseoutSession(root, local(root)).report()) as Report;
  expect(report.pending).toEqual(["engine"]);
  expect(report.required[0]?.matched_paths).toEqual(["src/main.ts"]);
  expect(report.blocked).toBeNull();
});

test("a missing merge base blocks the report", async () => {
  const root = initRepo();
  git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  writePolicy(root, ['specVersion: "0.1"', "items:", command("engine", ["true"])]);
  const session = createCloseoutSession(root, local(root));
  const report = JSON.parse(await session.report()) as Report;
  expect(report.required).toEqual([]);
  expect(report.pending).toEqual([]);
  expect(report.blocked).toBe("changed paths are unavailable");
  expect(await session.run("engine")).toBe("changed paths are unavailable");
});

test("an exhausted setup step is not spawned for a later command", async () => {
  const root = initRepo();
  const mark = join(root, "setup-runs.txt");
  writePolicy(root, [
    'specVersion: "0.1"',
    "retry:",
    "  maxFailedAttemptsPerItem: 1",
    "  scope: candidate",
    "setup:",
    "  - id: prepare",
    `    exec: ${JSON.stringify([
      process.execPath,
      "-e",
      `require("fs").appendFileSync(${JSON.stringify(mark)}, "s"); process.exit(1)`,
    ])}`,
    "    timeoutSeconds: 30",
    "items:",
    command("engine", ["true"]),
  ]);
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  const session = createCloseoutSession(root, local(root));
  expect(await session.run("engine")).toContain("prepare failed");
  expect(readFileSync(mark, "utf8")).toBe("s");
  expect(await session.run("engine")).toContain("prepare failed");
  expect(readFileSync(mark, "utf8")).toBe("ss");
  const blocked = JSON.parse(await session.report()) as Report;
  expect(blocked.required.find((item) => item.id === "prepare")?.status).toBe("exhausted");
  expect(blocked.pending).not.toContain("prepare");
  expect(await session.run("engine")).toContain("Check prepare is exhausted");
  expect(readFileSync(mark, "utf8")).toBe("ss");
});

test("a broken policy blocks the report", async () => {
  const root = initRepo();
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", "closeout.yaml"), 'specVersion: "0.1"\nitems: {}\n');
  const report = JSON.parse(await createCloseoutSession(root, local(root)).report()) as Report;
  expect(report.required).toEqual([]);
  expect(report.pending).toEqual([]);
  expect(report.blocked).toEqual(expect.any(String));
});

type Report = {
  required: Array<{
    id: string;
    kind: string;
    hint: string;
    matched_paths: string[];
    status: string;
    failed_attempts: number;
    remaining_attempts: number | null;
    retry_scope: string | null;
    different_model: boolean;
  }>;
  pending: string[];
  blocked: string | null;
  bypassed: boolean;
};

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-session-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

function writePolicy(root: string, lines: string[]): void {
  mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "# Review\n");
  writeFileSync(join(root, ".agents", "closeout.yaml"), `${lines.join("\n")}\n`);
}

function command(id: string, exec: string[], pattern?: string): string {
  const paths = pattern === undefined ? "" : `    paths: [${JSON.stringify(pattern)}]\n`;
  return `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ${JSON.stringify(exec)}\n    timeoutSeconds: 30\n${paths}`.trimEnd();
}

function review(pattern: string): string {
  return [
    "  - id: review",
    "    kind: review",
    "    gate: beforePR",
    "    skill: .agents/skills/review/SKILL.md",
    "    independence:",
    "      differentSession: true",
    "      differentModel: true",
    "    failOn: P0",
    `    paths: [${JSON.stringify(pattern)}]`,
  ].join("\n");
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z";
  } catch {
    return false;
  }
}

async function waitForText(path: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const text = readProcessIds(path);
    if (text !== undefined) return text;
    if (Date.now() - started > 5_000) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readProcessIds(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    if (text.includes("\n") && !text.endsWith("undefined")) return text;
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (ready()) return;
    if (Date.now() - started > 2_000) throw new Error("timed out waiting for the process group");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("session report transports real command streams, duration and timeout for the checked commit", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command("output", [
      process.execPath,
      "-e",
      'console.log("real stdout"); console.error("real stderr"); await Bun.sleep(25)',
    ]),
  ]);
  const session = createCloseoutSession(root, local(root));
  await session.run("output");
  const report = JSON.parse(await session.report());
  expect(report.required[0].result).toMatchObject({
    argv: [
      process.execPath,
      "-e",
      'console.log("real stdout"); console.error("real stderr"); await Bun.sleep(25)',
    ],
    head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    exitCode: 0,
    timeoutSeconds: 30,
    stdout: "real stdout\n",
    stderr: "real stderr\n",
    timedOut: false,
    truncated: false,
  });
  expect(report.required[0].result.durationMs).toBeGreaterThanOrEqual(25);
  writeFileSync(join(root, "README.md"), "changed");
  expect(JSON.parse(await session.report()).required[0].result).toBeUndefined();
});

test("large session output stays within the remote report budget and marks truncation", async () => {
  const root = initRepo();
  writePolicy(root, [
    'specVersion: "0.1"',
    "items:",
    command("output", [
      process.execPath,
      "-e",
      'console.log("多".repeat(100000)); console.error("末尾")',
    ]),
  ]);
  const session = createCloseoutSession(root, local(root));
  await session.run("output");
  const text = await session.report();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60000);
  const result = JSON.parse(text).required[0].result;
  expect(result.truncated).toBe(true);
  expect(result.stderr).toContain("末尾");
});
