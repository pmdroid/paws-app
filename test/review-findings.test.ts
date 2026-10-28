import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { PAWS_CLOSEOUT_NAME, PAWS_CLOSEOUT_VERSION } from "../src/closeout-spec/evaluate";
import { reviewFindingKey } from "../src/core";
import {
  bindWorkItemRepository,
  finishCloseoutProgress,
  insertQueuedItem,
  listReviewFindings,
  markReviewFindingFiled,
  reviewFindingItems,
  setReviewFindingStatus,
  upsertCloseoutStep,
} from "../src/db";
import { backfillReviewFindings, recordAcceptedFindings, type TaskReviewReader } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const BASE = "b".repeat(40);
const DIGEST = `sha256:${"ef".repeat(32)}`;
const REPOSITORY = {
  owner: "acme",
  repo: "platform",
  remoteUrl: "https://github.com/acme/platform",
};

type Raw = { severity: "P0" | "P1" | "P2" | "P3"; location: string; explanation: string };

/**
 * One accepted Closeout run of `itemId` at `head`: an `independent-review` record with `findings`
 * in the task's evidence, its step marked with `failOn` and the pre-existing indexes.
 */
function accept(
  db: Database,
  home: string,
  input: {
    itemId: string;
    head: string;
    at: number;
    findings: Raw[];
    failOn?: "P0" | "P1" | "P2" | "P3" | null;
    preExisting?: number[];
    review?: string;
  },
): void {
  const review = input.review ?? "independent-review";
  const evidencePath = `evidence/policy/${input.head}/${review}/1.json`;
  const file = join(home, "closeout", "evidence", input.itemId, evidencePath);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      specVersion: "0.1",
      recordType: "review",
      task: input.itemId,
      itemId: review,
      base: BASE,
      head: input.head,
      policyDigest: DIGEST,
      attempt: 1,
      evaluator: { name: PAWS_CLOSEOUT_NAME, version: PAWS_CLOSEOUT_VERSION },
      producer: { session: "reviewer", model: "model-b", provider: "other" },
      findings: input.findings.map((finding) => ({ ...finding, evidence: "e" })),
      artifacts: [],
    }),
  );
  const identity = {
    taskId: input.itemId,
    base: BASE,
    head: input.head,
    policyDigest: DIGEST,
    policyPath: null,
  };
  upsertCloseoutStep(
    db,
    input.itemId,
    identity,
    {
      id: review,
      kind: "review",
      state: "passed",
      command: "",
      detail: null,
      attempt: 1,
      timeoutSeconds: null,
      startedAt: input.at,
      finishedAt: input.at,
      exitCode: null,
      timedOut: false,
      timeoutReason: null,
      truncated: false,
      logPath: null,
      evidencePath,
      findings: null,
      ordinal: 0,
      failOn: input.failOn === undefined ? "P1" : input.failOn,
      preExisting: input.preExisting ?? [],
    },
    input.at,
  );
  finishCloseoutProgress(db, input.itemId, identity, "accepted", input.at);
}

function item(db: Database, id: string): void {
  insertQueuedItem(db, { id, sessionKey: `session-${id}`, now: 1 });
  bindWorkItemRepository(db, id, REPOSITORY);
}

const STALE: Raw = {
  severity: "P1",
  location: "src/legacy.ts:4",
  explanation: "unchecked null: the handler reads the user before the check.",
};
const MINOR: Raw = {
  severity: "P2",
  location: "src/new.ts:10-12",
  explanation: "Naming: the flag reads backwards.",
};
const BLOCKING: Raw = {
  severity: "P1",
  location: "src/new.ts:20",
  explanation: "race: two writers commit the same row.",
};

test("an accepted head stores its two non-blocking findings and not the waived blocking one", async () => {
  const db = tempDb();
  const home = tempHome();
  try {
    item(db, "item-a");
    accept(db, home, {
      itemId: "item-a",
      head: "a".repeat(40),
      at: 100,
      findings: [STALE, MINOR, BLOCKING],
      preExisting: [0],
    });
    const result = await recordAcceptedFindings(db, {
      itemId: "item-a",
      head: "a".repeat(40),
      pawsRoot: home,
      now: 1000,
    });
    expect(result).toEqual({ recorded: 2, gone: 0 });
    const rows = listReviewFindings(db);
    expect(rows.map((row) => [row.path, row.lines, row.severity, row.why, row.bugClass])).toEqual([
      ["src/new.ts", "10-12", "P2", "below failOn", "naming"],
      ["src/legacy.ts", "4", "P1", "pre-existing", "unchecked null"],
    ]);
    expect(rows.every((row) => row.status === "open" && row.itemCount === 1)).toBe(true);
    expect(rows[0]).toMatchObject({
      repository: "acme/platform",
      review: "independent-review",
      first: { itemId: "item-a", head: "a".repeat(40), at: 1000 },
      last: { itemId: "item-a", head: "a".repeat(40), at: 1000 },
    });
    expect(rows.some((row) => row.text.startsWith("race"))).toBe(false);
  } finally {
    db.close();
  }
});

test("the same finding on another item updates its count and last seen instead of adding a row", async () => {
  const db = tempDb();
  const home = tempHome();
  try {
    item(db, "item-a");
    item(db, "item-b");
    accept(db, home, {
      itemId: "item-a",
      head: "a".repeat(40),
      at: 100,
      findings: [STALE],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-a",
      head: "a".repeat(40),
      pawsRoot: home,
      now: 1000,
    });
    // Reworded only in case, spacing and the final period: the same finding.
    const again = {
      ...STALE,
      explanation: "Unchecked null:  the handler reads the user before the check",
    };
    accept(db, home, {
      itemId: "item-b",
      head: "c".repeat(40),
      at: 200,
      findings: [again],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-b",
      head: "c".repeat(40),
      pawsRoot: home,
      now: 2000,
    });
    // Item b's next accepted head reports it once more; it is still two items.
    accept(db, home, {
      itemId: "item-b",
      head: "d".repeat(40),
      at: 300,
      findings: [again],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-b",
      head: "d".repeat(40),
      pawsRoot: home,
      now: 3000,
    });
    const rows = listReviewFindings(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemCount: 2,
      first: { itemId: "item-a", head: "a".repeat(40), at: 1000 },
      last: { itemId: "item-b", head: "d".repeat(40), at: 3000 },
    });
    expect(
      reviewFindingItems(db, [rows[0]!.id])
        .get(rows[0]!.id)!
        .map((entry) => entry.itemId),
    ).toEqual(["item-b", "item-a"]);
  } finally {
    db.close();
  }
});

test("a finding a later accepted review of its path no longer reports is gone, and returns when seen again", async () => {
  const db = tempDb();
  const home = tempHome();
  try {
    item(db, "item-a");
    item(db, "item-b");
    accept(db, home, {
      itemId: "item-a",
      head: "a".repeat(40),
      at: 100,
      findings: [STALE],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-a",
      head: "a".repeat(40),
      pawsRoot: home,
      now: 1000,
    });
    accept(db, home, { itemId: "item-b", head: "c".repeat(40), at: 200, findings: [] });
    // Another review's silence and an untouched path say nothing about it.
    await recordAcceptedFindings(db, {
      itemId: "item-b",
      head: "c".repeat(40),
      pawsRoot: home,
      now: 2000,
      changedPaths: ["src/other.ts"],
    });
    expect(listReviewFindings(db)[0]!.status).toBe("open");
    await recordAcceptedFindings(db, {
      itemId: "item-b",
      head: "c".repeat(40),
      pawsRoot: home,
      now: 2500,
      changedPaths: ["src/legacy.ts"],
    });
    expect(listReviewFindings(db)[0]).toMatchObject({
      status: "gone",
      statusBy: null,
      statusAt: 2500,
    });
    accept(db, home, {
      itemId: "item-b",
      head: "d".repeat(40),
      at: 300,
      findings: [STALE],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-b",
      head: "d".repeat(40),
      pawsRoot: home,
      now: 3000,
    });
    expect(listReviewFindings(db)[0]).toMatchObject({ status: "open", itemCount: 2 });
  } finally {
    db.close();
  }
});

test("dismiss, reopen and filed set the status with who changed it and when", async () => {
  const db = tempDb();
  const home = tempHome();
  try {
    item(db, "item-a");
    accept(db, home, {
      itemId: "item-a",
      head: "a".repeat(40),
      at: 100,
      findings: [STALE],
      preExisting: [0],
    });
    await recordAcceptedFindings(db, {
      itemId: "item-a",
      head: "a".repeat(40),
      pawsRoot: home,
      now: 1000,
    });
    const [row] = listReviewFindings(db);
    expect(
      setReviewFindingStatus(db, { id: row!.id, status: "open", by: "Aisha", now: 1500 }),
    ).toBeNull();
    expect(
      setReviewFindingStatus(db, {
        id: row!.id,
        status: "dismissed",
        reason: "Legacy module, removed next quarter.",
        by: "Aisha",
        now: 2000,
      }),
    ).toMatchObject({
      status: "dismissed",
      statusBy: "Aisha",
      statusAt: 2000,
      statusReason: "Legacy module, removed next quarter.",
    });
    expect(listReviewFindings(db, { status: "open" })).toEqual([]);
    // A dismissed finding reported again keeps its status.
    await recordAcceptedFindings(db, {
      itemId: "item-a",
      head: "a".repeat(40),
      pawsRoot: home,
      now: 2500,
    });
    expect(listReviewFindings(db)[0]!.status).toBe("dismissed");
    expect(
      setReviewFindingStatus(db, { id: row!.id, status: "open", by: "Ben", now: 3000 }),
    ).toMatchObject({
      status: "open",
      statusBy: "Ben",
      statusAt: 3000,
      statusReason: null,
    });
    const key = reviewFindingKey({
      repository: "Acme/Platform",
      location: "./src/legacy.ts:4:7",
      text: STALE.explanation.toUpperCase(),
    });
    expect(key).toBe(row!.key);
    expect(
      markReviewFindingFiled(db, { key, issue: "PAS-900", by: "Ben", now: 4000 }),
    ).toMatchObject({
      status: "filed",
      filedIssue: "PAS-900",
      statusBy: "Ben",
      statusAt: 4000,
    });
    expect(
      markReviewFindingFiled(db, { key: "missing", issue: "PAS-901", by: null, now: 4000 }),
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("the backfill reads each task's evidence once and running it again changes nothing", async () => {
  const db = tempDb();
  const home = tempHome();
  try {
    item(db, "item-a");
    item(db, "item-b");
    accept(db, home, {
      itemId: "item-a",
      head: "a".repeat(40),
      at: 100,
      findings: [STALE, MINOR],
      preExisting: [0],
    });
    accept(db, home, {
      itemId: "item-a",
      head: "e".repeat(40),
      at: 150,
      findings: [STALE, MINOR],
      preExisting: [0],
    });
    accept(db, home, {
      itemId: "item-b",
      head: "c".repeat(40),
      at: 200,
      findings: [STALE, BLOCKING],
      preExisting: [0],
      failOn: "P2",
    });
    const reads: string[] = [];
    const { taskReviewRecords } = await import("../src/closeout");
    const read: TaskReviewReader = (taskId) => {
      reads.push(taskId);
      return taskReviewRecords(taskId, home);
    };
    expect(await backfillReviewFindings({ db, pawsRoot: home, read })).toEqual({
      runs: 3,
      recorded: 5,
      // Item b's review reported a blocking finding in src/new.ts and not item a's P2 there.
      gone: 1,
    });
    expect(reads).toEqual(["item-a", "item-b"]);
    const once = listReviewFindings(db);
    expect(
      once.map((row) => [row.path, row.status, row.itemCount, row.first.at, row.last.at]),
    ).toEqual([
      ["src/legacy.ts", "open", 2, 100, 200],
      ["src/new.ts", "gone", 1, 100, 150],
    ]);
    await backfillReviewFindings({ db, pawsRoot: home });
    expect(listReviewFindings(db)).toEqual(once);
  } finally {
    db.close();
  }
});

test("the migration enqueues the backfill job only where Closeout accepted something", () => {
  const db = tempDb();
  try {
    expect(
      db.query("SELECT COUNT(*) AS n FROM job WHERE queue = 'review-findings.backfill'").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
