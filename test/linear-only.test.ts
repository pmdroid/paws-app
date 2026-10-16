import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntime, pawsPaths } from "../src/config";
import { insertQueuedItem, migrate, openDatabase } from "../src/db";
import { startPaws } from "../src/index";
import { runSetup } from "../src/setup";

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

test.each(["github", "both"])(
  "setup rejects --tracker %s with migration guidance",
  async (kind) => {
    const dir = home();
    const errors: string[] = [];
    expect(
      await runSetup(["--tracker", kind], {
        env: { HOME: dir, PAWS_HOME: dir },
        stderr: (line) => errors.push(line),
        stdout: () => {},
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("--tracker linear");
    expect(errors.join("\n")).toContain("github.auth");
  },
);

test("fresh setup honors environment-inferred App authentication", async () => {
  const dir = home();
  const errors: string[] = [];
  const code = await runSetup(["--yes", "--home", dir], {
    env: {
      HOME: dir,
      PAWS_HOME: dir,
      PATH: process.env.PATH ?? "",
      GITHUB_APP_ID: "99",
      GITHUB_APP_INSTALLATION_ID: "101",
      GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "app.pem"),
      PAWS_GITHUB_CLIENT_ID: "Iv1.local-fixture",
    },
    stdout: () => {},
    stderr: (line) => errors.push(line),
    github: {
      store: {
        backend: "file",
        warning: null,
        load: async () => ({
          accessToken: "fake-token",
          refreshToken: null,
          expiresAtMs: null,
          scope: "repo",
          login: "fixture",
          id: 1,
          invalid: false,
          appId: "different-app",
        }),
        save: async () => {},
        update: async (change) => change(null) !== null,
        markInvalid: async () => {},
        delete: async () => {},
      },
    },
  });
  expect(code).toBe(1);
  expect(errors.join("\n")).toContain("paws login github");
});

test("setup rejects archived GitHub queues before rewriting configuration or contacting providers", async () => {
  const dir = home();
  mkdirSync(pawsPaths(dir).secretsDir, { recursive: true });
  const config = '[tracker]\nkind = "github"\n[github]\nauth = "oauth"\n';
  writeFileSync(join(dir, "config.toml"), config);
  const db = openDatabase(pawsPaths(dir).db);
  migrate(db);
  const item = insertQueuedItem(db, { id: "legacy-setup", now: 1 });
  db.run("UPDATE work_item SET linear_issue_id = ? WHERE id = ?", [
    "github:local/fixture#1",
    item.id,
  ]);
  const before = db.query("SELECT * FROM work_item").all();
  const errors: string[] = [];
  let requests = 0;
  try {
    const code = await runSetup(["--yes", "--home", dir], {
      env: { HOME: dir, PAWS_HOME: dir, PATH: process.env.PATH ?? "" },
      stdout: () => {},
      stderr: (line) => errors.push(line),
      fetch: async () => {
        requests++;
        throw new Error("Unexpected provider request");
      },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("archive");
    expect(requests).toBe(0);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(config);
    expect(db.query("SELECT * FROM work_item").all()).toEqual(before);
  } finally {
    db.close();
  }
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
