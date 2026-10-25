import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations, openDatabase } from "../src/db";
import { migrateDryRun } from "../scripts/migrate-dry-run";

const dropped = ["linear_github_auth", "linear_github_task_account"] as const;

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
}

function applied(db: Database): boolean {
  return (
    db.query("SELECT 1 FROM schema_migration WHERE id='135_drop_github_sign_in'").get() !== null
  );
}

/**
 * A database at the production tip before 135 with one item that went through the old GitHub
 * sign-in and one held by the installation check.
 */
function productionTip(signIn: "verified" | "pending", path = ":memory:"): Database {
  const db = openDatabase(path);
  migrate(db, { until: "134_runner_enrollment" });
  const item = (id: string, state: string, position: number) =>
    db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
       VALUES(?,?,?,?,'Task',?,?,?,?)`,
      [id, `del-${id}`, `lin-${id}`, id.toUpperCase(), state, `paws/${id}`, position, position],
    );
  item("signed", signIn === "verified" ? "running" : "awaiting_input", 0);
  item("held", "awaiting_input", 1);
  const question = (id: string, itemId: string, status: string) =>
    db.run(
      `INSERT INTO question(id,item_id,session_id,kind,body,status,created_at)
       VALUES(?,?,?,'github-auth','Body',?,1)`,
      [id, itemId, `session-${itemId}`, status],
    );
  question("sign-in", "signed", signIn === "verified" ? "answered" : "open");
  question("wait", "held", "open");
  db.run(
    `INSERT INTO linear_github_auth(question_id,item_id,actor_id,github_account_id,phase,expires_at,status)
     VALUES('sign-in','signed','owner',7,'initial',1,?)`,
    [signIn],
  );
  db.run(
    "INSERT INTO linear_github_task_account(item_id,account_id,login,verified_at) VALUES('signed',7,'owner',1)",
  );
  db.run(
    `INSERT INTO github_integration_hold(question_id,item_id,phase,item_version,session_generation,current_run_id,checkpoint,authority)
     VALUES('wait','held','initial',1,0,NULL,'null','workspace')`,
  );
  return db;
}

test("135 drops the GitHub sign-in tables and keeps questions and installation holds", () => {
  const db = productionTip("verified");
  try {
    migrate(db);
    expect(applied(db)).toBe(true);
    for (const name of dropped) expect(tables(db), name).not.toContain(name);
    expect(db.query("SELECT id, kind FROM question ORDER BY id").all()).toEqual([
      { id: "sign-in", kind: "github-auth" },
      { id: "wait", kind: "github-auth" },
    ]);
    expect(db.query("SELECT question_id, status FROM github_integration_hold").all()).toEqual([
      { question_id: "wait", status: "pending" },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("an open legacy sign-in stops 135 with its item until it is cancelled", () => {
  const db = productionTip("pending");
  try {
    expect(() => migrate(db)).toThrow(/Work item signed \(SIGNED\) is waiting on a GitHub sign-in/);
    expect(applied(db)).toBe(false);
    for (const name of dropped) expect(tables(db), name).toContain(name);

    db.run("UPDATE work_item SET state='cancelled', cancel_requested=1 WHERE id='signed'");
    migrate(db);
    expect(applied(db)).toBe(true);
    for (const name of dropped) expect(tables(db), name).not.toContain(name);
  } finally {
    db.close();
  }
});

test("a dry run applies 135 to a copy of the production tip", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-dry-run-"));
  const path = join(dir, "paws.db");
  try {
    productionTip("verified", path).close();
    const ids = migrations.map((migration) => migration.id);
    expect(migrateDryRun(path).applied).toEqual(ids.slice(ids.indexOf("135_drop_github_sign_in")));
    const db = openDatabase(path);
    try {
      expect(applied(db)).toBe(false);
      expect(tables(db)).toContain("linear_github_auth");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
