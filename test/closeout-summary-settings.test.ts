import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Db } from "../src/db";
import { CLOSEOUT_SUMMARY_PATH, handleCloseoutSummaryRequest } from "../src/settings";
import { seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";

let db: Db;
let close: () => Promise<void>;
let home: string;

const COMMAND = (id: string, extra = "") =>
  `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ["bun", "test"]\n    timeoutSeconds: 60\n${extra}`;

const WITH_RERUN = `specVersion: "0.1"
rerun:
  conflict:
    run: [lint]
    reviews: false
  ci:
    run: failed
items:
${COMMAND("lint", '    ci: "lint"\n')}${COMMAND("test", "    select:\n      runner: bun\n      always: [test/a.test.ts]\n      full_on: [bun.lock]\n      max_selected: 120\n")}`;

const PLAIN = `specVersion: "0.1"\nitems:\n${COMMAND("test", '    since: ["bun", "test", "{since}"]\n')}`;

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function mirror(name: string, policy: string): string {
  const work = mkdtempSync(join(tmpdir(), "paws-summary-work-"));
  git(work, "init", "-q", "-b", "main");
  mkdirSync(join(work, ".agents"));
  writeFileSync(join(work, ".agents", "closeout.yaml"), policy);
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "policy");
  const path = join(home, "repos", `${name}.git`);
  mkdirSync(dirname(path), { recursive: true });
  git(home, "clone", "-q", "--bare", work, path);
  git(path, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
  rmSync(work, { recursive: true, force: true });
  return git(path, "rev-parse", "refs/remotes/origin/main");
}

beforeEach(async () => {
  ({ db, close } = await tempStore());
  home = mkdtempSync(join(tmpdir(), "paws-summary-home-"));
  writeFileSync(join(home, "config.toml"), "");
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 1 }),
  );
  await seed(db, (q) =>
    q.orm.insert(q.t.workspaceRepository).values(
      ["acme/web", "acme/api", "acme/bad", "acme/new"].map((repository) => ({
        workspaceId: "ws",
        repository,
        teamId: "t",
      })),
    ),
  );
});

afterEach(async () => {
  await close();
  rmSync(home, { recursive: true, force: true });
});

function call(role?: string, now = 1000) {
  return handleCloseoutSummaryRequest(new Request(`http://127.0.0.1${CLOSEOUT_SUMMARY_PATH}`), {
    store: db,
    workspaceId: "ws",
    pawsHome: home,
    configPath: join(home, "config.toml"),
    now: () => now,
    ...(role ? { role } : {}),
  }) as Promise<Response>;
}

test("lists each repository's rerun and command checks from its mirror", async () => {
  const api = mirror("acme/api", WITH_RERUN);
  const web = mirror("acme/web", PLAIN);
  const bad = mirror("acme/bad", 'specVersion: "0.1"\nitems: nope\n');
  const response = await call("admin");
  expect(response.status).toBe(200);
  const { repositories } = (await response.json()) as { repositories: Record<string, unknown>[] };
  expect(repositories.map((entry) => entry.repository)).toEqual([
    "acme/api",
    "acme/bad",
    "acme/new",
    "acme/web",
  ]);
  expect(repositories[0]).toEqual({
    repository: "acme/api",
    commit: api,
    readAt: 1000,
    rerun: { conflict: { run: ["lint"], reviews: false }, ci: { run: "failed" } },
    checks: [
      { id: "lint", ci: "lint" },
      {
        id: "test",
        select: {
          runner: "bun",
          always: ["test/a.test.ts"],
          full_on: ["bun.lock"],
          max_selected: 120,
        },
      },
    ],
  });
  expect(repositories[1]).toMatchObject({ repository: "acme/bad", commit: bad, readAt: 1000 });
  expect(repositories[1]!.error).toContain("/items");
  expect(repositories[2]).toEqual({
    repository: "acme/new",
    readAt: 1000,
    error: "Paws hasn't fetched this repository yet",
  });
  expect(repositories[3]).toEqual({
    repository: "acme/web",
    commit: web,
    readAt: 1000,
    rerun: null,
    checks: [{ id: "test", since: ["bun", "test", "{since}"] }],
  });
  const cached = (await (await call("admin", 2000)).json()) as {
    repositories: { readAt: number }[];
  };
  expect(cached.repositories[0]!.readAt).toBe(1000);
  const later = (await (await call("admin", 1000 + 5 * 60_000)).json()) as {
    repositories: { readAt: number }[];
  };
  expect(later.repositories[0]!.readAt).toBe(1000 + 5 * 60_000);
});

test("non-admins get 403", async () => {
  expect((await call("member")).status).toBe(403);
});
