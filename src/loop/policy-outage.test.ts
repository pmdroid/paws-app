import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
  beginImplementRun,
  enterMergeQueue,
  getPolicyOutage,
  getWorkItem,
  insertQueuedItem,
  type Db,
} from "../db";
import { getQuestion } from "../questions";
import {
  holdForPolicyOutage,
  policyLoadFailed,
  policyLoads,
  policyOutageNote,
  type MainPolicyError,
} from "./policy-outage";
import { tempStore } from "../../test/pglite";

const REPOSITORY = "acme/monorepo";
const BROKEN: MainPolicyError = {
  message: ".agents/closeout.yaml: /rules/0 must have required property 'probe'",
  path: ".agents/closeout.yaml",
  main: "a".repeat(40),
  commit: "c0ffee".padEnd(40, "0"),
};

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function queue(...ids: string[]) {
  const { db, close } = await tempStore();
  open.push(close);
  for (const id of ids) {
    await insertQueuedItem(db, { id, sessionKey: `ses-${id}`, now: 0 });
    await beginImplementRun(db, id, 1);
    await enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  }
  return db;
}

async function hold(db: Db, id: string, now = 10, unreadable = BROKEN) {
  return holdForPolicyOutage(db, {
    item: (await getWorkItem(db, id))!,
    repository: REPOSITORY,
    unreadable,
    now,
    publicUrl: "https://paws.example",
  });
}

async function questions(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select()
        .from(q.t.question)
        .where(eq(q.t.question.kind, "policy-outage"))
        .orderBy(asc(q.t.question.createdAt), asc(q.t.question.id)),
    ),
  );
}

describe("an unreadable Closeout policy on main", () => {
  test("two items in one repository ask one question, and both wait in the merge queue", async () => {
    const db = await queue("ENG-1", "ENG-2");
    const first = await hold(db, "ENG-1");
    const second = await hold(db, "ENG-2", 20);
    const asked = await questions(db);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ itemId: "ENG-1", status: "open" });
    expect(asked[0]!.body).toContain(".agents/closeout.yaml");
    expect(asked[0]!.body).toContain(BROKEN.message);
    expect(asked[0]!.body).toContain(BROKEN.commit!);
    const wait = `The Closeout policy on main doesn't load: ${BROKEN.message}. Paws merges again once it's fixed.`;
    expect(first).toBe(wait);
    expect(second).toBe(
      `${wait} [Open question](https://paws.example/dashboard/questions/${asked[0]!.id}).`,
    );
    expect((await getWorkItem(db, "ENG-1"))?.state).toBe("merge_queue");
    expect((await getWorkItem(db, "ENG-2"))?.state).toBe("merge_queue");
  });

  test("main loading again settles the question and ends the outage", async () => {
    const db = await queue("ENG-1");
    await hold(db, "ENG-1");
    const [question] = await questions(db);
    expect(await policyLoads(db, REPOSITORY, 30)).toMatchObject({
      questionId: question!.id,
    });
    expect((await getQuestion(db, question!.id))?.status).toBe("cancelled");
    expect(await getPolicyOutage(db, REPOSITORY)).toBeNull();
    expect(await policyLoads(db, REPOSITORY, 40)).toBeNull();
  });

  test("a different break on main replaces the question", async () => {
    const db = await queue("ENG-1", "ENG-2");
    await hold(db, "ENG-1");
    await hold(db, "ENG-2", 20, { ...BROKEN, message: "another error", commit: "d".repeat(40) });
    const asked = await questions(db);
    expect(
      await Promise.all(
        asked.map(async (question) => (await getQuestion(db, question.id))?.status),
      ),
    ).toEqual(["cancelled", "open"]);
    expect(asked[1]).toMatchObject({ itemId: "ENG-2" });
  });

  test("Closeout's own question names the breaking commit and links the repository question", async () => {
    const db = await queue("ENG-1", "ENG-2");
    await hold(db, "ENG-1");
    const [question] = await questions(db);
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
