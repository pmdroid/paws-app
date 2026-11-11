import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCloseoutGate, type CloseoutFocus } from "../src/closeout";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutSessionEvent,
} from "../src/closeout-spec";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  type AgentCloseoutEvent,
  sqliteDb,
} from "../src/db";
import { closeoutPrompt, closeoutChecksPrompt } from "../src/loop/agents";
import { closeoutFocus } from "../src/loop/closeout-focus";
import { createDbCloseoutProgress } from "../src/loop/closeout-progress";
import { turnPasses } from "../src/loop/turn-passes";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policy(root: string): string {
  const mark = (id: string, extra = "") =>
    JSON.stringify(["sh", "-c", `${extra}echo ${id} >> ${path.join(root, "ran")}`]);
  const command = (id: string, paths: string | null, extra = "") => [
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    ...(paths ? [`    paths: ["${paths}"]`] : []),
    `    exec: ${mark(id, extra)}`,
    "    timeoutSeconds: 30",
  ];
  return [
    'specVersion: "0.1"',
    "setup:",
    "  - id: install",
    `    exec: ${mark("install")}`,
    "    timeoutSeconds: 30",
    "items:",
    ...command("lint", null),
    ...command("engine-test", "apps/engine/**", `test -f ${path.join(root, "ok")} && `),
    ...command("web-test", "apps/web/**"),
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
  const root = mkdtempSync(path.join(tmpdir(), "paws-fix-round-"));
  roots.push(root);
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")]);
  await exec("git", ["clone", path.join(root, "origin.git"), dir]);
  await mkdir(path.join(dir, ".agents/skills/review"), { recursive: true });
  await mkdir(path.join(dir, "apps/engine"), { recursive: true });
  await mkdir(path.join(dir, "apps/web"), { recursive: true });
  await writeFile(path.join(dir, ".agents/closeout.yaml"), policy(root));
  await writeFile(path.join(dir, ".agents/skills/review/SKILL.md"), "# Review\n");
  const base = await commit(dir, "init");
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  await writeFile(path.join(dir, "apps/engine/rocket.ts"), "export const acme = 1;\n");
  await writeFile(path.join(dir, "apps/web/anvil.ts"), "export const acme = 2;\n");
  const head = await commit(dir, "acme rocket and anvil");
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "acme-1", now: 1, sessionKey: "acme-session" });
  let reviews = 0;
  const gate = () =>
    ({
      worktree: dir,
      taskId: "ACME-1-task",
      base,
      candidate: { session: "impl", model: "claude", provider: "anthropic" },
      home,
      pawsHome,
      maxFixAttempts: 0,
      progress: createDbCloseoutProgress(sqliteDb(db), "acme-1"),
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
    }) as const;
  return {
    root,
    dir,
    head,
    db,
    gate,
    reviews: () => reviews,
    ran: () => {
      const file = path.join(root, "ran");
      const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
      rmSync(file, { force: true });
      return lines.filter(Boolean);
    },
  };
}

function session(dir: string, focus: CloseoutFocus | undefined) {
  const events: AgentCloseoutEvent[] = [];
  const closeout = createCloseoutSession(dir, {
    policy: async () => workspacePolicyFiles(dir),
    ...(focus ? { focus } : {}),
    onProgress: (progress: CloseoutSessionEvent) =>
      events.push({
        runId: "run",
        itemId: "acme-1",
        sequence: events.length + 1,
        at: 1_700_000_000_000,
        progress,
      }),
  });
  return {
    report: async () =>
      JSON.parse(await closeout.report()) as {
        pending: string[];
        required: { id: string; status: string; note?: string }[];
      },
    run: (id: string) => closeout.run(id),
    passes: () => turnPasses(events),
  };
}

test("a findings round lists only the failed check; Closeout then runs in full on the fix", async () => {
  const repo = await seed();
  const h1 = await runCloseoutGate(repo.gate());
  expect(h1.outcome).not.toBe("accepted");
  expect(repo.ran()).toEqual(["install", "lint", "web-test"]);

  const focus = (await closeoutFocus(sqliteDb(repo.db), "acme-1", "findings"))!;
  expect(focus).toMatchObject({ scope: "failed", head: repo.head });
  expect([...focus.passed].sort()).toEqual(["install", "lint", "web-test"]);

  const turn = session(repo.dir, focus);
  const listed = await turn.report();
  expect(listed.pending).toEqual(["engine-test"]);
  const note = `passed on ${repo.head.slice(0, 12)}; Closeout reruns it at the end`;
  expect(listed.required.find((item) => item.id === "lint")).toMatchObject({
    status: "deferred",
    note,
  });
  expect(listed.required.find((item) => item.id === "review")?.status).toBe("missing");

  await writeFile(path.join(repo.root, "ok"), "");
  await writeFile(path.join(repo.dir, "apps/engine/rocket.ts"), "export const acme = 3;\n");
  const h2 = await commit(repo.dir, "fix acme rocket");
  expect(await turn.run("engine-test")).toContain("passed");
  expect((await turn.report()).pending).toEqual([]);
  expect(repo.ran()).toEqual(["install", "engine-test"]);

  const final = await runCloseoutGate({ ...repo.gate(), fromTurn: turn.passes() });
  expect(final.outcome).toBe("accepted");
  expect(final.head).toBe(h2);
  expect(repo.ran()).toEqual(["install", "lint", "web-test"]);
  expect(repo.reviews()).toBe(2);
  expect(final.decision?.items.map((item) => [item.id, item.state])).toEqual([
    ["install", "passed"],
    ["lint", "passed"],
    ["engine-test", "passed"],
    ["web-test", "passed"],
    ["review", "passed"],
  ]);
}, 60_000);

test("a review round lists only the checks whose paths include the files the fix changed", async () => {
  const repo = await seed();
  await writeFile(path.join(repo.root, "ok"), "");
  expect((await runCloseoutGate(repo.gate())).outcome).toBe("accepted");
  repo.ran();

  const focus = (await closeoutFocus(sqliteDb(repo.db), "acme-1", "review"))!;
  expect(focus.scope).toBe("changed");
  const turn = session(repo.dir, focus);
  expect((await turn.report()).pending).toEqual([]);

  await writeFile(path.join(repo.dir, "apps/engine/rocket.ts"), "export const acme = 4;\n");
  await commit(repo.dir, "answer acme review");
  const listed = await turn.report();
  expect(listed.pending).toEqual(["install", "lint", "engine-test"]);
  expect(listed.required.find((item) => item.id === "web-test")?.status).toBe("deferred");

  for (const id of listed.pending) await turn.run(id);
  expect(repo.ran()).toEqual(["install", "lint", "engine-test"]);
  const final = await runCloseoutGate({ ...repo.gate(), fromTurn: turn.passes() });
  expect(final.outcome).toBe("accepted");
  expect(repo.ran()).toEqual(["install", "web-test"]);
  expect(repo.reviews()).toBe(2);
}, 60_000);

test("a round without a narrower scope keeps every check pending", async () => {
  const repo = await seed();
  await runCloseoutGate(repo.gate());
  repo.ran();
  expect(await closeoutFocus(sqliteDb(repo.db), "acme-1", "ci")).toBeUndefined();
  const head = repo.head;
  const stale = { scope: "failed", head, policyDigest: "sha256:0", passed: ["lint"] } as const;
  expect((await session(repo.dir, stale).report()).pending).toEqual([
    "install",
    "lint",
    "engine-test",
    "web-test",
  ]);
}, 60_000);

test("the turn prompts run only the pending checks and leave the rest to Closeout", () => {
  expect(closeoutPrompt()).toContain(
    "Run only the pending ids listed, in order, with run_closeout, then call get_closeout again. Closeout reruns every check after the turn.",
  );
  expect(closeoutChecksPrompt("a".repeat(40))).toContain(
    "run only the pending ids listed, in order, with run_closeout",
  );
});

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
