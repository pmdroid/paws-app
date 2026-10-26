import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntime, pawsPaths } from "../src/config";
import { insertQueuedItem, migrate, openDatabase } from "../src/db";
import { startPaws } from "../src/index";

const homes: string[] = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "paws-linear-only-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Linear config keeps GitHub App auth", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), `[tracker]\nkind = "linear"\n[github]\nauth = "app"\n`);
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toBeNull();
  expect(runtime.trackerKind).toBe("linear");
  expect(runtime.githubAuth).toBe("app");
});

test.each(["oauth", "gh"])("github.auth %s fails at startup", (auth) => {
  const dir = home();
  const config = `[tracker]\nkind = "linear"\n[github]\nauth = "${auth}"\n`;
  writeFileSync(join(dir, "config.toml"), config);
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toContain('github.auth must be "app"');
  expect(() => startPaws({ PAWS_HOME: dir, PAWS_PORT: "0" })).toThrow('github.auth must be "app"');
});

test("historical GitHub work is preserved and never recovered into Linear", () => {
  const dir = home();
  const paths = pawsPaths(dir);
  mkdirSync(paths.secretsDir, { recursive: true });
  const db = openDatabase(paths.db);
  migrate(db);
  const item = insertQueuedItem(db, { id: "historical", now: 1 });
  db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", [
    "github:local/fixture#1",
    item.id,
  ]);
  const before = db.query("SELECT * FROM work_item").all();
  expect(() => startPaws({ PAWS_HOME: dir, PAWS_PORT: "0" })).toThrow("archive");
  expect(db.query("SELECT * FROM work_item").all()).toEqual(before);
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name = 'github_poll_state'").get(),
  ).not.toBeNull();
  db.close();
}, 30_000);
