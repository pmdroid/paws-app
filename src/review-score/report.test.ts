import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  listReviewEscapes,
  migrate,
  openDatabase,
  recordReviewEscape,
  settleReviewEscape,
  type ReviewEscapeTrigger,
} from "../db";
import { formatReviewScore, readReviewEscapesFile, scoreReview } from "./report";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function candidates() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  let key = 0;
  const add = (
    trigger: ReviewEscapeTrigger,
    settled?: { escape: boolean; reason?: "flake" | "tests_docs_format" },
  ) => {
    recordReviewEscape(db, {
      triggerKey: `k-${(key += 1)}`,
      itemId: "eng-1",
      trigger,
      acceptedHead: "h",
      pullNumber: 7,
      detail: {},
      recordedAt: key * 10,
    });
    if (settled)
      settleReviewEscape(db, key, {
        fixHead: "f",
        files: ["src/a.ts"],
        escape: settled.escape,
        notEscapeReason: settled.reason ?? null,
        now: 99,
      });
  };
  return { db, add };
}

describe("the reviewer score report", () => {
  test("lists found after the PR with counts per trigger, beside the escapes after merge", () => {
    const { db, add } = candidates();
    add("ci", { escape: true });
    add("ci", { escape: true });
    add("ci", { escape: false, reason: "flake" });
    add("review", { escape: true });
    add("comment", { escape: false, reason: "tests_docs_format" });
    add("comment");
    // Recording the same trigger key again changes nothing.
    expect(
      recordReviewEscape(db, {
        triggerKey: "k-1",
        itemId: "eng-1",
        trigger: "ci",
        acceptedHead: "h",
        pullNumber: 7,
        detail: {},
        recordedAt: 1,
      }),
    ).toBe(false);

    const score = scoreReview(listReviewEscapes(db), [{ pr: 1 }, { pr: 2 }]);
    expect(score).toEqual({
      afterMerge: 2,
      afterPullRequest: [
        { trigger: "ci", escapes: 2, notEscapes: { flake: 1 }, open: 0 },
        { trigger: "review", escapes: 1, notEscapes: {}, open: 0 },
        { trigger: "comment", escapes: 0, notEscapes: { tests_docs_format: 1 }, open: 1 },
      ],
    });
    expect(formatReviewScore(score)).toBe(
      [
        "Independent review escapes",
        "",
        "Escaped after merge: 2",
        "Found after the PR: 3",
        "  CI failed: 2 (not escapes: 1 also fails on main)",
        "  Changes requested: 1",
        "  PR comment: 0 (not escapes: 1 tests, docs or formatting only; 1 open)",
      ].join("\n"),
    );
    // `since` leaves out the three CI candidates recorded before it.
    expect(scoreReview(listReviewEscapes(db, 40), null).afterPullRequest[0]).toEqual({
      trigger: "ci",
      escapes: 0,
      notEscapes: {},
      open: 0,
    });
  });

  test("reads the escapes after merge from the evals file, and says when it is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paws-score-"));
    dirs.push(dir);
    const file = path.join(dir, "review-escapes.jsonl");
    expect(readReviewEscapesFile(file)).toBeNull();
    writeFileSync(file, '{"pr":1}\n\nnot json\n{"pr":2}\n[]\n');
    expect(readReviewEscapesFile(file)).toEqual([{ pr: 1 }, { pr: 2 }]);
    expect(formatReviewScore(scoreReview([], null))).toContain(
      "Escaped after merge: no evals/review-escapes.jsonl",
    );
  });
});
