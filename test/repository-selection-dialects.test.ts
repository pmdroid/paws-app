import { expect, test } from "bun:test";
import {
  bindWorkItemRepositorySteps,
  getWorkItemRepositoryAnswerSteps,
  getWorkItemRepositoryChoiceSteps,
  insertQuestionRowSteps,
  listRepositoryCandidatesSteps,
  rememberWorkItemRepositoryChoiceSteps,
} from "../src/db";
import { forEachDialect, insertLinearSession, insertWorkItem, jsonValue, seed } from "./dialects";

const paws = { owner: "acme", repo: "paws", remoteUrl: "https://github.com/acme/paws.git" };
const docs = { owner: "acme", repo: "docs", remoteUrl: "https://github.com/acme/docs.git" };

forEachDialect((open) => {
  test("an answered repository question is read back, remembered and bound once", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insertLinearSession(db, "session");
      await db.run(function* (q) {
        yield* insertQuestionRowSteps(q, {
          id: "question",
          itemId: "item",
          runId: null,
          sessionId: "session",
          kind: "repository",
          reason: "repository",
          body: "Which repository?",
          context: null,
          options: null,
          status: "open",
          createdAt: 1,
        });
        yield* q.exec(
          q.orm.insert(q.t.workItemRepositoryQuestion).values({
            itemId: "item",
            questionId: "question",
            candidates: jsonValue(q, [paws, docs]),
          }),
        );
      });
      await seed(db, (q) => q.orm.update(q.t.question).set({ status: "answered", answer: "docs" }));
      expect(
        (await db.run((q) => getWorkItemRepositoryAnswerSteps(q, "item")))?.candidates,
      ).toEqual([paws, docs]);
      await db.transaction((q) =>
        rememberWorkItemRepositoryChoiceSteps(q, "item", "question", docs),
      );
      expect(await db.run((q) => getWorkItemRepositoryChoiceSteps(q, "item"))).toEqual(docs);
      await db.transaction((q) => bindWorkItemRepositorySteps(q, "item", docs));
      await expect(
        db.transaction((q) => bindWorkItemRepositorySteps(q, "item", paws)),
      ).rejects.toThrow("cannot change");
    } finally {
      await close();
    }
  });

  test("a session's repository candidates narrow to its team's links", async () => {
    const { db, close } = await open();
    try {
      await seed(
        db,
        (q) =>
          q.orm.insert(q.t.workspace).values({
            id: "workspace",
            linearOrganizationId: "org",
            name: "Acme",
            createdAt: 1,
          }),
        (q) =>
          q.orm
            .insert(q.t.linearSession)
            .values({ sessionId: "team", organizationId: "org", teamId: "t1", createdAt: 1 }),
        (q) =>
          q.orm
            .insert(q.t.workspaceRepository)
            .values({ workspaceId: "workspace", repository: "Acme/Paws", teamId: "t1" }),
      );
      expect(await db.run((q) => listRepositoryCandidatesSteps(q, "team", [docs]))).toEqual([
        { owner: "acme", repo: "paws", remoteUrl: "https://github.com/acme/paws.git" },
      ]);
    } finally {
      await close();
    }
  });
});
