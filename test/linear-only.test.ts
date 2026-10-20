import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test.each(["github", "both"])("legacy %s tracker fails before startup writes", (kind) => {
  const dir = home();
  const config = `[tracker]\nkind = "${kind}"\n[github]\nauth = "oauth"\n`;
  writeFileSync(join(dir, "config.toml"), config);
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toContain('kind = "linear"');
  expect(runtime.configError).toContain("archive");
  expect(() => startPaws({ PAWS_HOME: dir, PAWS_PORT: "0" })).toThrow("Linear");
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(config);
});

test("tracker.github without an explicit Linear kind fails closed", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), '[tracker.github]\nrepos = ["local/fixture"]\n');
  expect(loadRuntime({ PAWS_HOME: dir }).configError).toContain("Linear");
});

test.each([
  '[tracker]\nkind = "linear"\n[tracker.github]\nrepos = ["local/fixture"]\n',
  '[tracker.github]\nrepos = ["local/fixture"]\n[tracker]\nkind = "linear"\n',
])("retired tracker configuration rejects even with an explicit Linear kind", (config) => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), config);
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toContain("remove [tracker.github]");
  expect(() => startPaws({ PAWS_HOME: dir, PAWS_PORT: "0" })).toThrow("Linear");
  expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(config);
});

test.each(["oauth", "app", "gh"])(
  "retired tracker rejection preserves independent %s repository authentication",
  (auth) => {
    const dir = home();
    const config = `[github]\nauth = "${auth}"\nrepo = "local/fixture"\nrepos = ["local/fixture", "local/second"]\n[tracker]\nkind = "linear"\n[tracker.github]\nrepos = ["retired/issues"]\n`;
    writeFileSync(join(dir, "config.toml"), config);
    const runtime = loadRuntime({ PAWS_HOME: dir });
    expect(runtime.configError).toContain("remove [tracker.github]");
    expect(runtime.githubAuth).toBe(auth);
    expect(runtime.repo).toBe("local/fixture");
    expect(runtime.file.githubRepos).toEqual(["local/fixture", "local/second"]);
    expect(() => startPaws({ PAWS_HOME: dir, PAWS_PORT: "0" })).toThrow("Linear");
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(config);
  },
);

test.each(["oauth", "app", "gh"])("Linear config preserves independent %s GitHub auth", (auth) => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `[tracker]\nkind = "linear"\n[github]\nauth = "${auth}"\n`,
  );
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toBeNull();
  expect(runtime.trackerKind).toBe("linear");
  expect(runtime.githubAuth).toBe(auth);
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
