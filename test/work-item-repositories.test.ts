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
  migrate,
  openDatabase,
} from "../src/db";
import { answerQuestion, openQuestion } from "../src/questions";

test("repository binding survives restart and rejects a different binding", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-"));
  const filename = join(root, "paws.db");
  const repository = {
    owner: "pmdroid",
    repo: "paws-app",
    remoteUrl: "https://github.com/pmdroid/paws-app.git",
  };
  let db = openDatabase(filename);
  try {
    migrate(db);
    const item = insertQueuedItem(db);
    expect(getWorkItemRepository(db, item.id)).toBeNull();
    expect(bindWorkItemRepository(db, item.id, repository)).toEqual(repository);
    expect(bindWorkItemRepository(db, item.id, repository)).toEqual(repository);
    db.close();
    db = openDatabase(filename);
    migrate(db);
    expect(getWorkItemRepository(db, item.id)).toEqual(repository);
    expect(() => bindWorkItemRepository(db, item.id, { ...repository, repo: "other" })).toThrow(
      "cannot change",
    );
    expect(getWorkItemRepository(db, item.id)).toEqual(repository);
    expect(() => bindWorkItemRepository(db, "missing", repository)).toThrow();
    expect(() => bindWorkItemRepository(db, item.id, { ...repository, owner: ".." })).toThrow(
      "requires",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interpreted offered repository survives restart without changing the answer or binding", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-choice-"));
  const filename = join(root, "paws.db");
  const repositories = ["one", "two"].map((repo) => ({
    owner: "acme",
    repo,
    remoteUrl: `https://github.com/acme/${repo}.git`,
  }));
  let db = openDatabase(filename);
  try {
    migrate(db);
    const item = insertQueuedItem(db);
    const question = openQuestion(db, {
      itemId: item.id,
      sessionId: "session",
      body: "Which repository?",
    });
    saveWorkItemRepositoryQuestion(db, item.id, question.id, repositories);
    expect(rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[1]!)).toBe(
      false,
    );
    answerQuestion(db, question.id, {
      answer: "Use the second repository for this change.",
      answeredBy: "owner",
    });
    expect(() =>
      rememberWorkItemRepositoryChoice(db, item.id, question.id, {
        ...repositories[1]!,
        remoteUrl: "https://github.com/unoffered/elsewhere.git",
      }),
    ).toThrow("not offered");
    expect(rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[1]!)).toBe(true);
    db.close();
    db = openDatabase(filename);
    migrate(db);
    expect(getWorkItemRepositoryChoice(db, item.id)).toEqual(repositories[1]!);
    expect(getWorkItemRepository(db, item.id)).toBeNull();
    expect(getWorkItemRepositoryAnswer(db, item.id)?.answer).toBe(
      "Use the second repository for this change.",
    );
    const replacement = openQuestion(db, {
      itemId: item.id,
      sessionId: "session",
      body: "Choose an accessible repository.",
    });
    saveWorkItemRepositoryQuestion(db, item.id, replacement.id, repositories);
    expect(getWorkItemRepositoryChoice(db, item.id)).toBeNull();
    expect(rememberWorkItemRepositoryChoice(db, item.id, question.id, repositories[0]!)).toBe(
      false,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
