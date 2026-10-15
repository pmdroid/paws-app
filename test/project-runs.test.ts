import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createProjectRun,
  getProjectRun,
  listTaskBlockers,
  migrate,
  openDatabase,
  saveTaskBlocks,
} from "../src/db";
import { tempHome } from "./helpers";

function openTemp() {
  const db = openDatabase(join(tempHome(), "paws.db"));
  migrate(db);
  return db;
}

describe("project runs", () => {
  test("a project run records where it came from", () => {
    const db = openTemp();
    const id = createProjectRun(db, { source: "project", linearId: "project-1", now: 10 });
    expect(getProjectRun(db, id)).toEqual({
      id,
      source: "project",
      linearId: "project-1",
      createdAt: 10,
    });
    expect(getProjectRun(db, "missing")).toBeNull();
    db.close();
  });

  test("a project run comes from a Linear project or a parent issue", () => {
    const db = openTemp();
    expect(() =>
      createProjectRun(db, { source: "epic" as "project", linearId: "x", now: 1 }),
    ).toThrow();
    db.close();
  });

  test("work items can belong to a project run", () => {
    const db = openTemp();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(work_item)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("project_run_id");
    db.close();
  });
});

describe("task blocks", () => {
  test("blocks are global and replaced per blocked issue", () => {
    const db = openTemp();
    saveTaskBlocks(
      db,
      ["b", "c"],
      [
        { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
        { blockerLinearIssueId: "a", blockedLinearIssueId: "c" },
        { blockerLinearIssueId: "b", blockedLinearIssueId: "c" },
      ],
    );
    expect(listTaskBlockers(db, "c")).toEqual(["a", "b"]);

    saveTaskBlocks(db, ["c"], [{ blockerLinearIssueId: "b", blockedLinearIssueId: "c" }]);
    expect(listTaskBlockers(db, "c")).toEqual(["b"]);
    expect(listTaskBlockers(db, "b")).toEqual(["a"]);
    db.close();
  });

  test("an edge must point at an issue in the saved set", () => {
    const db = openTemp();
    expect(() =>
      saveTaskBlocks(db, ["b"], [{ blockerLinearIssueId: "a", blockedLinearIssueId: "z" }]),
    ).toThrow();
    expect(listTaskBlockers(db, "z")).toEqual([]);
    db.close();
  });

  test("an issue cannot block itself", () => {
    const db = openTemp();
    expect(() =>
      saveTaskBlocks(db, ["a"], [{ blockerLinearIssueId: "a", blockedLinearIssueId: "a" }]),
    ).toThrow();
    db.close();
  });
});
