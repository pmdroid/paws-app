import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCloseoutGate, type TurnPass } from "../src/closeout";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutSessionEvent,
} from "../src/closeout-spec";
import type { AgentCloseoutEvent } from "../src/db";
import { turnPasses } from "../src/loop/turn-passes";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policy(root: string): string {
  const mark = (id: string, extra = "") =>
    JSON.stringify(["sh", "-c", `${extra}echo ${id} >> ${path.join(root, "ran")}`]);
  return [
    'specVersion: "0.1"',
    "setup:",
    "  - id: install",
    `    exec: ${mark("install")}`,
    "    timeoutSeconds: 30",
    "items:",
    "  - id: lint",
    "    kind: command",
    "    gate: beforePR",
    `    exec: ${mark("lint")}`,
    "    timeoutSeconds: 30",
    "  - id: test",
    "    kind: command",
    "    gate: beforePR",
    `    exec: ${mark("test", `test -f ${path.join(root, "ok")} && `)}`,
    "    timeoutSeconds: 30",
    "  - id: review",
    "    kind: review",
    "    gate: beforePR",
    "    skill: .agents/skills/review/SKILL.md",
    "    independence:",
    "      differentSession: true",
    "      differentModel: true",
    "    failOn: P1",
    "",
  ].join("\n");
}

async function seed() {
  const root = mkdtempSync(path.join(tmpdir(), "paws-from-turn-"));
  roots.push(root);
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")]);
  await exec("git", ["clone", path.join(root, "origin.git"), dir]);
  await mkdir(path.join(dir, ".agents/skills/review"), { recursive: true });
  await writeFile(path.join(dir, ".agents/closeout.yaml"), policy(root));
  await writeFile(path.join(dir, ".agents/skills/review/SKILL.md"), "# Review\n");
  const base = await commit(dir, "init");
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  await writeFile(path.join(dir, "change.txt"), "acme widget\n");
  const head = await commit(dir, "change");
  let reviews = 0;
  const input = {
    worktree: dir,
    taskId: "ACME-1-task",
    base,
    candidate: { session: "impl", model: "claude", provider: "anthropic" },
    home,
    pawsHome,
    maxFixAttempts: 0,
    reviewer: {
      async review() {
        reviews += 1;
        return { session: "codex", model: "codex", provider: "openai", findings: [] };
      },
    },
    fixer: {
      async applyFix(): Promise<never> {
        throw new Error("no fixes");
      },
    },
  };
  return {
    root,
    dir,
    head,
    input,
    reviews: () => reviews,
    ran: () => {
      const file = path.join(root, "ran");
      const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
      rmSync(file, { force: true });
      return lines.filter(Boolean);
    },
  };
}

async function turn(dir: string, ids: string[]): Promise<TurnPass[]> {
  const events: AgentCloseoutEvent[] = [];
  const session = createCloseoutSession(dir, {
    policy: async () => workspacePolicyFiles(dir),
    onProgress: (progress: CloseoutSessionEvent) =>
      events.push({
        runId: "run",
        itemId: "item",
        sequence: events.length + 1,
        at: 1_700_000_000_000,
        progress,
      }),
  });
  await session.report();
  for (const id of ids) await session.run(id);
  return turnPasses(events);
}

const REUSED = "passed in the agent's turn at 2023-11-14T22:13:20.000Z";

test("checks the agent passed on the clean head are reused; only the review runs", async () => {
  const repo = await seed();
  await writeFile(path.join(repo.root, "ok"), "");
  const passes = await turn(repo.dir, ["lint", "test"]);
  expect(repo.ran()).toEqual(["install", "lint", "test"]);
  expect(passes.map((pass) => pass.id).sort()).toEqual(["install", "lint", "test"]);

  const result = await runCloseoutGate({ ...repo.input, fromTurn: passes });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran()).toEqual([]);
  expect(repo.reviews()).toBe(1);
  expect(result.decision?.items.filter((item) => item.kind === "command")).toEqual([
    { id: "lint", kind: "command", state: "passed", attempt: 1, message: REUSED },
    { id: "test", kind: "command", state: "passed", attempt: 1, message: REUSED },
  ]);
}, 60_000);

test("a commit after the checks runs everything again", async () => {
  const repo = await seed();
  await writeFile(path.join(repo.root, "ok"), "");
  const passes = await turn(repo.dir, ["lint", "test"]);
  repo.ran();
  await writeFile(path.join(repo.dir, "later.txt"), "acme later\n");
  await commit(repo.dir, "later");

  const result = await runCloseoutGate({ ...repo.input, fromTurn: passes });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran()).toEqual(["install", "lint", "test"]);
}, 60_000);

test("a changed policy digest or base runs everything again", async () => {
  const repo = await seed();
  await writeFile(path.join(repo.root, "ok"), "");
  const passes = await turn(repo.dir, ["lint", "test"]);
  repo.ran();
  for (const changed of [
    passes.map((pass) => ({ ...pass, policyDigest: `sha256:${"0".repeat(64)}` })),
    passes.map((pass) => ({ ...pass, base: "0".repeat(40) })),
  ]) {
    await runCloseoutGate({ ...repo.input, fromTurn: changed });
    expect(repo.ran()).toEqual(["install", "lint", "test"]);
  }
}, 60_000);

test("a check that failed in the turn, or never ran, runs with its setup", async () => {
  const repo = await seed();
  const passes = await turn(repo.dir, ["test"]);
  expect(repo.ran()).toEqual(["install"]);
  expect(passes.map((pass) => pass.id)).toEqual(["install"]);
  await writeFile(path.join(repo.root, "ok"), "");

  const result = await runCloseoutGate({ ...repo.input, fromTurn: passes });
  expect(result.outcome).toBe("accepted");
  expect(repo.ran()).toEqual(["install", "lint", "test"]);
}, 60_000);

test("a pass on an uncommitted change is not kept", async () => {
  const repo = await seed();
  await writeFile(path.join(repo.root, "ok"), "");
  await writeFile(path.join(repo.dir, "draft.txt"), "acme draft\n");
  expect(await turn(repo.dir, ["lint"])).toEqual([]);
}, 60_000);

async function commit(dir: string, message: string): Promise<string> {
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [
    "-C",
    dir,
    "-c",
    "user.name=Acme",
    "-c",
    "user.email=dev@acme.test",
    "commit",
    "-qm",
    message,
  ]);
  return (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}
