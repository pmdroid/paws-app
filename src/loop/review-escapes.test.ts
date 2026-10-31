import { restart } from "./operations";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../acp";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  listReviewEscapes,
  markCloseoutAccepted,
  migrate,
  openDatabase,
} from "../db";
import { returnToAgent, type FailedCiCheck } from "../merge";
import {
  classifyReviewEscape,
  readFixDiff,
  settleReviewEscapes,
  testOrDocPath,
} from "./review-escapes";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const run = (worktree: string, ...args: string[]) =>
  git(["-C", worktree, ...args]).then((out) => out.trim());

/** A worktree whose branch adds `src/rank.ts` on top of main, accepted by Closeout. */
async function accepted() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-escapes-"));
  roots.push(root);
  await run(root, "init", "-q", "-b", "main");
  await run(root, "config", "user.email", "paws@example.com");
  await run(root, "config", "user.name", "Paws");
  await writeFile(path.join(root, "README.md"), "demo\n");
  await run(root, "add", ".");
  await run(root, "commit", "-qm", "init");
  const base = await run(root, "rev-parse", "HEAD");
  await run(root, "checkout", "-qb", "paws/eng-1");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/rank.ts"), "export const rank = (a: number) => a;\n");
  await run(root, "add", ".");
  await run(root, "commit", "-qm", "rank");
  const head = await run(root, "rev-parse", "HEAD");

  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: base, wipCommit: head });
  markCloseoutAccepted(db, "eng-1", head);

  const ciFailed = (checks: FailedCiCheck[]) =>
    returnToAgent(db, {
      restart,
      itemId: "eng-1",
      reason: "ci-failed",
      admit: (returns) => returns < 3,
      handoff: "CI failed.",
      now: 2,
      record: () => {},
      announce: () => {},
      failedChecks: checks,
      pullNumber: 7,
    });
  const commit = async (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files))
      await writeFile(path.join(root, file), content);
    await run(root, "add", ".");
    await run(root, "commit", "-qm", "fix");
    return run(root, "rev-parse", "HEAD");
  };
  const settle = (fixHead: string) =>
    settleReviewEscapes(db, {
      itemId: "eng-1",
      fixHead,
      base,
      now: 3,
      read: readFixDiff((args) => git(args), root),
    });
  return { db, root, base, head, ciFailed, commit, settle };
}

describe("review escapes found after the pull request", () => {
  test("a CI fix after an accepted head records one candidate, and a docs-only fix is not an escape", async () => {
    const { db, head, ciFailed, commit, settle } = await accepted();
    expect(ciFailed([{ name: "test", url: null }])).toMatchObject({ kind: "restarted" });
    // The item is back with the agent; the same failure read again starts no second round.
    expect(ciFailed([{ name: "test", url: null }])).toMatchObject({ kind: "skipped" });
    const [candidate, ...rest] = listReviewEscapes(db);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      itemId: "eng-1",
      trigger: "ci",
      acceptedHead: head,
      pullNumber: 7,
      detail: { checks: [{ name: "test", failsOnBase: false }] },
      fixHead: null,
      escape: null,
    });

    const fix = await commit({ "README.md": "demo\n\nHow to rank.\n" });
    expect(await settle(fix)).toBe(1);
    expect(listReviewEscapes(db)).toEqual([
      expect.objectContaining({
        fixHead: fix,
        files: ["README.md"],
        escape: false,
        notEscapeReason: "tests_docs_format",
      }),
    ]);
    // Settled once; a later acceptance leaves it alone.
    expect(await settle(fix)).toBe(0);
  });

  test("a code fix is an escape with the files it changed", async () => {
    const { db, ciFailed, commit, settle } = await accepted();
    ciFailed([{ name: "test", url: null }]);
    const fix = await commit({
      "src/rank.ts": "export const rank = (a: number) => -a;\n",
      "src/rank.test.ts": "// covers rank\n",
    });
    await settle(fix);
    expect(listReviewEscapes(db)[0]).toMatchObject({
      fixHead: fix,
      files: ["src/rank.test.ts", "src/rank.ts"],
      escape: true,
      notEscapeReason: null,
    });
  });

  test("a whitespace-only fix and a check that also fails on main are not escapes", async () => {
    const formatted = await accepted();
    formatted.ciFailed([{ name: "fmt", url: null }]);
    await formatted.settle(
      await formatted.commit({ "src/rank.ts": "export const rank  = (a: number) => a;\n\n" }),
    );
    expect(listReviewEscapes(formatted.db)[0]).toMatchObject({
      files: ["src/rank.ts"],
      escape: false,
      notEscapeReason: "tests_docs_format",
    });

    const flaky = await accepted();
    flaky.ciFailed([{ name: "e2e", url: null, failsOnBase: true }]);
    await flaky.settle(
      await flaky.commit({ "src/rank.ts": "export const rank = (a: number) => a + 0;\n" }),
    );
    expect(listReviewEscapes(flaky.db)[0]).toMatchObject({
      escape: false,
      notEscapeReason: "flake",
    });
  });

  test("no candidate when Closeout has not accepted a head", async () => {
    const { db, ciFailed } = await accepted();
    db.run("UPDATE work_item SET accepted_head = NULL");
    expect(ciFailed([{ name: "test", url: null }])).toMatchObject({ kind: "restarted" });
    expect(listReviewEscapes(db)).toEqual([]);
  });
});

describe("classifyReviewEscape", () => {
  const diff = (files: string[], reviewed = ["src/rank.ts"]) => ({
    files,
    substantive: files,
    reviewed,
  });

  test("a review or comment fix counts only inside the files the review saw", () => {
    expect(classifyReviewEscape({ trigger: "review", detail: {} }, diff(["src/rank.ts"]))).toEqual({
      escape: true,
    });
    expect(
      classifyReviewEscape({ trigger: "comment", detail: {} }, diff(["src/other.ts"])),
    ).toEqual({ escape: false, reason: "unreviewed" });
    expect(classifyReviewEscape({ trigger: "ci", detail: {} }, diff(["src/other.ts"]))).toEqual({
      escape: true,
    });
    expect(classifyReviewEscape({ trigger: "review", detail: {} }, diff([]))).toEqual({
      escape: false,
      reason: "no_change",
    });
  });

  test("only every failed check failing on main is a flake", () => {
    const checks = [
      { name: "e2e", failsOnBase: true },
      { name: "test", failsOnBase: false },
    ];
    expect(classifyReviewEscape({ trigger: "ci", detail: { checks } }, diff(["src/a.ts"]))).toEqual(
      { escape: true },
    );
  });

  test("test and doc paths", () => {
    for (const file of [
      "test/boundaries.test.ts",
      "src/loop/pull-reviews.test.ts",
      "src/web/__snapshots__/a.snap",
      "docs/smoke-test.md",
      "README.md",
      "CHANGELOG.md",
      "pkg/rank_test.go",
    ])
      expect(testOrDocPath(file)).toBe(true);
    for (const file of ["src/loop/orchestrator.ts", "src/testing.ts", "package.json"])
      expect(testOrDocPath(file)).toBe(false);
  });
});
