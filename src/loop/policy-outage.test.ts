import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  enterMergeQueue,
  getPolicyOutage,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
} from "../db";
import { getQuestion } from "../questions";
import {
  holdForPolicyOutage,
  policyLoadFailed,
  policyLoads,
  policyOutageNote,
  type MainPolicyError,
} from "./policy-outage";

const REPOSITORY = "acme/monorepo";
const BROKEN: MainPolicyError = {
  message: ".agents/closeout.yaml: /rules/0 must have required property 'probe'",
  path: ".agents/closeout.yaml",
  main: "a".repeat(40),
  commit: "c0ffee".padEnd(40, "0"),
};

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function queue(...ids: string[]) {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  for (const id of ids) {
    insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now: 0 });
    beginImplementRun(db, id, 1);
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  }
  return db;
}

function hold(db: Database, id: string, now = 10, unreadable = BROKEN) {
  return holdForPolicyOutage(db, {
    item: getWorkItem(db, id)!,
    repository: REPOSITORY,
    unreadable,
    now,
    publicUrl: "https://paws.example",
  });
}

function questions(db: Database) {
  return db
    .query<{ id: string; item_id: string; body: string; status: string }, []>(
      "SELECT id, item_id, body, status FROM question WHERE kind = 'policy-outage' ORDER BY rowid",
    )
    .all();
}

describe("an unreadable Closeout policy on main", () => {
  test("two items in one repository ask one question, and both wait in the merge queue", () => {
    const db = queue("ENG-1", "ENG-2");
    const first = hold(db, "ENG-1");
    const second = hold(db, "ENG-2", 20);
    const asked = questions(db);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ item_id: "ENG-1", status: "open" });
    expect(asked[0]!.body).toContain(".agents/closeout.yaml");
    expect(asked[0]!.body).toContain(BROKEN.message);
    expect(asked[0]!.body).toContain(BROKEN.commit!);
    const wait = `The Closeout policy on main doesn't load: ${BROKEN.message}. Paws merges again once it's fixed.`;
    expect(first).toBe(wait);
    expect(second).toBe(
      `${wait} [Open question](https://paws.example/dashboard/questions/${asked[0]!.id}).`,
    );
    expect(getWorkItem(db, "ENG-1")?.state).toBe("merge_queue");
    expect(getWorkItem(db, "ENG-2")?.state).toBe("merge_queue");
  });

  test("main loading again settles the question and ends the outage", () => {
    const db = queue("ENG-1");
    hold(db, "ENG-1");
    const [question] = questions(db);
    expect(policyLoads(db, REPOSITORY, 30)).toMatchObject({ questionId: question!.id });
    expect(getQuestion(db, question!.id)?.status).toBe("cancelled");
    expect(getPolicyOutage(db, REPOSITORY)).toBeNull();
    expect(policyLoads(db, REPOSITORY, 40)).toBeNull();
  });

  test("a different break on main replaces the question", () => {
    const db = queue("ENG-1", "ENG-2");
    hold(db, "ENG-1");
    hold(db, "ENG-2", 20, { ...BROKEN, message: "another error", commit: "d".repeat(40) });
    const asked = questions(db);
    expect(asked.map((question) => getQuestion(db, question.id)?.status)).toEqual([
      "cancelled",
      "open",
    ]);
    expect(asked[1]).toMatchObject({ item_id: "ENG-2" });
  });

  test("Closeout's own question names the breaking commit and links the repository question", async () => {
    const db = queue("ENG-1", "ENG-2");
    hold(db, "ENG-1");
    const [question] = questions(db);
    const note = await policyOutageNote(db, REPOSITORY, "ENG-2", "https://paws.example");
    expect(note).toContain(BROKEN.commit!);
    expect(note).toContain(`https://paws.example/dashboard/questions/${question!.id}`);
    expect(
      policyLoadFailed({
        decision: "blocked",
        message: BROKEN.message,
        policy: { path: null, digest: null, absent: false },
        items: [],
      } as never),
    ).toBe(true);
    expect(
      policyLoadFailed({
        decision: "blocked",
        message: "origin/main is unavailable",
        policy: { path: null, digest: null, absent: false },
        items: [],
      } as never),
    ).toBe(false);
  });
});
