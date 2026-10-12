import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindWorkItemRepository,
  getWorkItemRepository,
  insertQueuedItem,
  migrate,
  openDatabase,
} from "../src/db";

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
