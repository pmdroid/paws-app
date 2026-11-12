import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindWorkItemRepository,
  getWorkItemRepository,
  getWorkItemRepositoryAnswer,
  getWorkItemRepositoryChoice,
  rememberWorkItemRepositoryChoice,
  saveWorkItemRepositoryQuestion,
  insertQueuedItem,
  openPawsStore,
} from "../src/db";
import { openQuestion } from "../src/questions";
import { copyMigratedPglite } from "./pglite";
import { answerQuestionPg } from "./questions";

async function openStore(pgliteDir: string) {
  const opened = await openPawsStore({ url: null, pgliteDir });
  return { db: opened.store, close: opened.close };
}

test("repository binding survives restart and rejects a different binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-"));
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  const repository = {
    owner: "pmdroid",
    repo: "paws-app",
    remoteUrl: "https://github.com/pmdroid/paws-app.git",
  };
  let { db, close } = await openStore(pgliteDir);
  try {
    const item = await insertQueuedItem(db);
    expect(await getWorkItemRepository(db, item.id)).toBeNull();
    expect(await bindWorkItemRepository(db, item.id, repository)).toEqual(repository);
    expect(await bindWorkItemRepository(db, item.id, repository)).toEqual(repository);
    await close();
    ({ db, close } = await openStore(pgliteDir));
    expect(await getWorkItemRepository(db, item.id)).toEqual(repository);
    expect(
      async () => await bindWorkItemRepository(db, item.id, { ...repository, repo: "other" }),
    ).toThrow("cannot change");
    expect(await getWorkItemRepository(db, item.id)).toEqual(repository);
    expect(async () => await bindWorkItemRepository(db, "missing", repository)).toThrow();
    expect(
      async () => await bindWorkItemRepository(db, item.id, { ...repository, owner: ".." }),
    ).toThrow("requires");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interpreted offered repository survives restart without changing the answer or binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-choice-"));
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  const repositories = ["one", "two"].map((repo) => ({
    owner: "acme",
    repo,
    remoteUrl: `https://github.com/acme/${repo}.git`,
  }));
  let { db, close } = await openStore(pgliteDir);
  try {
    const item = await insertQueuedItem(db);
    const question = await openQuestion(db, {
      itemId: item.id,
      sessionId: "session",
      body: "Which repository?",
    });
    await saveWorkItemRepositoryQuestion(db, item.id, question.id, repositories);
    expect(await rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[1]!)).toBe(
      false,
    );
    await answerQuestionPg(db, question.id, {
      answer: "Use the second repository for this change.",
      answeredBy: "owner",
    });
    await expect(
      rememberWorkItemRepositoryChoice(db, item.id, question.id, {
        ...repositories[1]!,
        remoteUrl: "https://github.com/unoffered/elsewhere.git",
      }),
    ).rejects.toThrow("not offered");
    expect(await rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[1]!)).toBe(
      true,
    );
    await close();
    ({ db, close } = await openStore(pgliteDir));
    expect(await getWorkItemRepositoryChoice(db, item.id)).toEqual(repositories[1]!);
    expect(await getWorkItemRepository(db, item.id)).toBeNull();
    expect((await getWorkItemRepositoryAnswer(db, item.id))?.answer).toBe(
      "Use the second repository for this change.",
    );
    const replacement = await openQuestion(db, {
      itemId: item.id,
      sessionId: "session",
      body: "Choose an accessible repository.",
    });
    await saveWorkItemRepositoryQuestion(db, item.id, replacement.id, repositories);
    expect(await getWorkItemRepositoryChoice(db, item.id)).toBeNull();
    expect(await rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[0]!)).toBe(
      false,
    );
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
