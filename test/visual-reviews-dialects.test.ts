import { afterEach, expect, test } from "bun:test";
import {
  getVisualReviewMarkSteps,
  listVisualReviewMarksSteps,
  listVisualReviewsSteps,
  openVisualReviewFilesSteps,
  saveVisualReviewMarksSteps,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("visual reviews name their approvers and ask only about files not carried over", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const carried = {
      evidenceId: "e2",
      fromEvidenceId: "e0",
      approvalId: "q0",
      approvedBy: "lin-ada",
      approvedAt: 5,
      match: "identical",
    };
    const question = (id: string, status: string) => (q: Q) =>
      q.orm
        .insert(q.t.question)
        .values({ id, itemId: "A", sessionId: `s-${id}`, body: id, status, createdAt: 1 });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workspaceUser).values([
          { id: "u1", linearUserId: "lin-ada", name: "Ada", email: "a@x" },
          { id: "u2", linearUserId: "lin-bo", name: "", email: "b@x" },
        ]),
      question("q2", "open"),
      question("q1", "answered"),
      (q) =>
        q.orm.insert(q.t.visualReview).values([
          {
            questionId: "q2",
            itemId: "A",
            checkId: "ui",
            evidenceIds: json(db, ["e1", "e2"]),
            createdAt: 10,
            carried: json(db, [carried, { ...carried, evidenceId: "e3", approvedBy: "lin-bo" }]),
          },
          {
            questionId: "q1",
            itemId: "A",
            checkId: "ui",
            evidenceIds: json(db, ["e0"]),
            createdAt: 10,
            outcome: "accepted",
            answeredBy: "lin-ada",
            answeredAt: 11,
          },
          {
            questionId: "q3",
            itemId: "A",
            checkId: "ui",
            evidenceIds: json(db, []),
            createdAt: 1,
            kind: "continue",
          },
        ]),
    );
    const base = { checkId: "ui", createdAt: 10, feedback: null, headCommit: null };
    expect(await db.run((q) => listVisualReviewsSteps(q, "A"))).toEqual([
      {
        ...base,
        questionId: "q1",
        evidenceIds: ["e0"],
        outcome: "accepted",
        answeredBy: "Ada",
        answeredAt: 11,
        carried: [],
      },
      {
        ...base,
        questionId: "q2",
        evidenceIds: ["e1", "e2"],
        outcome: null,
        answeredBy: null,
        answeredAt: null,
        carried: [
          { ...carried, approvedBy: "Ada" },
          { ...carried, evidenceId: "e3", approvedBy: "lin-bo" },
        ],
      },
    ]);
    expect(await db.run((q) => openVisualReviewFilesSteps(q, "q2"))).toEqual({
      itemId: "A",
      evidenceIds: ["e1"],
    });
    expect(await db.run((q) => openVisualReviewFilesSteps(q, "q1"))).toBeNull();

    const mark = (id: string, createdAt: number) => ({
      id,
      questionId: "q2",
      evidenceId: "e1",
      sizeBytes: 3,
      sha256: "f".repeat(64),
      createdAt,
    });
    await db.run((q) =>
      saveVisualReviewMarksSteps(q, [mark("m2", 20), mark("m1", 20), mark("m0", 30)]),
    );
    expect(await db.run((q) => listVisualReviewMarksSteps(q, "q2"))).toEqual([
      mark("m1", 20),
      mark("m2", 20),
      mark("m0", 30),
    ]);
    expect(await db.run((q) => getVisualReviewMarkSteps(q, "m1"))).toEqual({
      ...mark("m1", 20),
      itemId: "A",
    });
    expect(await db.run((q) => getVisualReviewMarkSteps(q, "missing"))).toBeNull();
  });
});
