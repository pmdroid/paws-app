import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateRef, mirrorPath, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import {
  getRun,
  getWorkItem,
  legacyMigrate,
  migrate,
  openDatabase,
  recordItemCandidate,
} from "../src/db";
import type { Database } from "bun:sqlite";
import { writeStoredToken, type StoredLinearToken } from "../src/linear";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}

// `synchronous=FULL` fsyncs every commit. The first file database on a cold CI
// disk spent longer than bun's 5s test budget inside the ask test (about two
// dozen fsyncs). Pay that once while this module loads; tests use memory.
const template = join(tempHome(), "paws.db");
const warm = openDatabase(template);
try {
  migrate(warm);
} finally {
  warm.close();
}

export function tempDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function legacyTempDb(): Database {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  return db;
}

export function legacyMigratedDatabase(path: string): Database {
  const db = openDatabase(path);
  legacyMigrate(db);
  return db;
}

// Migrating a new file database commits once per migration, about 0.6 s of
// fsyncs alone and many times that on a loaded disk. A test that needs a file
// starts from a copy of the database migrated above instead.
export function migratedDatabase(path: string): Database {
  copyFileSync(template, path);
  const db = openDatabase(path);
  migrate(db);
  return db;
}

/** Drive the queued fix turns that formerly ran inside a single Closeout gate call. */
export async function tickWithRestarts(
  jobs: import("../src/db").JobLoop,
  orchestrator: import("../src/loop").Orchestrator,
  db: Database,
): Promise<import("../src/db").Job | null> {
  const first = await jobs.tick();
  for (let turn = 0; turn < 4; turn++) {
    const next = db
      .query<{ id: number }, []>(
        `SELECT j.id FROM job j JOIN work_item i ON i.id=json_extract(j.payload,'$.itemId')
       WHERE j.queue='run.resume' AND j.status='pending' AND i.state='queued'
       AND json_extract(j.payload,'$.reason') IN ('findings','ci','review','conflict') ORDER BY j.id LIMIT 1`,
      )
      .get();
    if (!next) break;
    orchestrator.reconcileExecution();
    await jobs.tick(["run.resume"]);
    if (first?.queue === "github.merge") await jobs.tick(["github.merge"]);
  }
  return first;
}

/**
 * A runner-backed item's head on the control plane: the bare mirror under `pawsRoot` for the
 * repository, holding `source`'s history, with the item's candidate ref at `source`'s HEAD.
 * `head()` reads the ref, and `adopt()` points it at `source`'s HEAD again.
 */
export function seedCandidate(
  pawsRoot: string,
  itemId: string,
  source: string,
  repository: { owner: string; repo: string } = { owner: "fixture", repo: "repository" },
) {
  const mirror = mirrorPath(pawsRoot, repository.owner, repository.repo);
  const ref = candidateRef(itemId);
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    git(["init", "-q", "--bare", mirror]);
  }
  const adopt = () => git(["--git-dir", mirror, "fetch", "-q", source, `+HEAD:${ref}`]);
  adopt();
  return { mirror, ref, adopt, head: () => git(["--git-dir", mirror, "rev-parse", ref]) };
}

/** Where {@link cloneRunner} checks an item out, as a runner's own checkout. */
export function runnerCheckout(pawsRoot: string, itemId: string): string {
  return join(pawsRoot, "runner-checkouts", itemId);
}

/**
 * Stands in for a remote runner: runs `agent` in its own clone of the item's candidate ref, then
 * imports the clone's HEAD back into the bare mirror, as the candidate import does. The control
 * plane keeps no worktree for a runner-backed item, so a fake runner cannot use one either.
 */
export function cloneRunner(
  repository: { owner: string; repo: string },
  agent: (options: RunAgentOptions) => Promise<RunAgentResult>,
  db?: Database,
) {
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args]);
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  return async (options: RunAgentOptions): Promise<RunAgentResult> => {
    const mirror = mirrorPath(options.pawsRoot, repository.owner, repository.repo);
    const ref = candidateRef(options.itemId);
    // Work with no candidate ref, such as an answer task, keeps the workspace it was given.
    const held = Bun.spawnSync([
      "/usr/bin/git",
      "--git-dir",
      mirror,
      "rev-parse",
      "--verify",
      "-q",
      ref,
    ]);
    if (held.exitCode !== 0) return agent(options);
    const tree = runnerCheckout(options.pawsRoot, options.itemId);
    if (!existsSync(tree)) git(["clone", "-q", "--no-checkout", mirror, tree]);
    git([
      "-C",
      tree,
      "fetch",
      "-q",
      mirror,
      `+${ref}:refs/paws/start`,
      "+refs/remotes/origin/*:refs/remotes/origin/*",
    ]);
    git(["-C", tree, "checkout", "-q", "--detach", "-f", "refs/paws/start"]);
    const result = await agent({ ...options, worktreePath: tree });
    if (options.role === "implementer") {
      git(["--git-dir", mirror, "fetch", "-q", tree, `+HEAD:${ref}`]);
      const item = db && getWorkItem(db, getRun(db, options.runId)?.itemId ?? "");
      if (item)
        recordItemCandidate(db, {
          itemId: item.id,
          sha: git(["--git-dir", mirror, "rev-parse", ref]),
          branch: item.branchName,
          recordedAt: Date.now(),
        });
    }
    return result;
  };
}

export function storeLinearToken(home: string, token: StoredLinearToken): void {
  const path = join(home, "paws.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = existsSync(path) ? openDatabase(path) : migratedDatabase(path);
  try {
    migrate(db);
    writeStoredToken(db, join(home, "secrets"), token);
  } finally {
    db.close();
  }
}
