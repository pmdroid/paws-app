import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PROBES = join(import.meta.dir, "..", ".agents", "probes");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function write(repo: string, files: Record<string, string | null>): void {
  for (const [path, body] of Object.entries(files)) {
    const file = join(repo, path);
    if (body === null) {
      unlinkSync(file);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

/** A repository whose base commit holds `base` and whose head commit applies `change`. */
function candidate(base: Record<string, string>, change: Record<string, string | null>) {
  const repo = mkdtempSync(join(tmpdir(), "paws-probe-repo-"));
  roots.push(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, base);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  write(repo, change);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "head");
  return { repo, base: baseSha, head: git(repo, "rev-parse", "HEAD") };
}

/** Run a probe the way Closeout does: from outside the checkout, against committed trees. */
function probe(name: string, at: { repo: string; base: string; head: string }) {
  const scratch = mkdtempSync(join(tmpdir(), "paws-probe-run-"));
  roots.push(scratch);
  const ran = spawnSync(
    process.execPath,
    [join(PROBES, `${name}.ts`), "--base", at.base, "--head", at.head, "--repo", at.repo],
    { cwd: scratch, encoding: "utf8" },
  );
  return { exitCode: ran.status, output: `${ran.stdout}${ran.stderr}` };
}

const SHIPPED = "src/db/migrations/20261026T2044_runner_command_handover.ts";
const migration = (id: string, sql = "SELECT 1;") =>
  `import type { Migration } from "../migration";\n\nexport const migration: Migration = {\n  id: "${id}",\n  sql: \`${sql}\`,\n};\n`;
const DB = {
  "src/db/migrations.ts": "export const frozenMigrations = [];\n",
  "src/db/migrations/README.md": "# Migrations\n",
  [SHIPPED]: migration("20261026T2044_runner_command_handover"),
  "src/db/items.ts": "export const items = 1;\n",
};

test("editing a shipped migration file fails migrations-append-only and names the file", () => {
  const ran = probe(
    "migrations-append-only",
    candidate(DB, { [SHIPPED]: migration("20261026T2044_runner_command_handover", "SELECT 2;") }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain(SHIPPED);
});

test("renaming or deleting a shipped migration file fails", () => {
  const renamed = "src/db/migrations/20261026T2045_runner_command_handover.ts";
  const ran = probe(
    "migrations-append-only",
    candidate(DB, {
      [SHIPPED]: null,
      [renamed]: migration("20261026T2045_runner_command_handover"),
    }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain(`${SHIPPED} is a shipped migration and was deleted or renamed`);
});

test("changing the frozen migration list fails", () => {
  const ran = probe(
    "migrations-append-only",
    candidate(DB, { "src/db/migrations.ts": "export const frozenMigrations = [1];\n" }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain("src/db/migrations.ts changed");
});

test("a new, correctly named migration file passes", () => {
  const ran = probe(
    "migrations-append-only",
    candidate(DB, {
      "src/db/migrations/20261027T1150_pull_comment_author.ts": migration(
        "20261027T1150_pull_comment_author",
      ),
      "src/db/items.ts": "export const items = 2;\n",
      "src/db/migrations/README.md": "# Migrations\n\nMore prose.\n",
    }),
  );
  expect(ran.output).toContain("1 new migration file");
  expect(ran.exitCode).toBe(0);
});

test.each([
  ["src/db/migrations/2026-10-27_pull_comment.ts", "is not named"],
  ["src/db/migrations/20261027T1150_PullComment.ts", "is not named"],
  ["src/db/migrations/20261027T1150.ts", "is not named"],
  ["src/db/migrations/20261332T1150_pull_comment.ts", "which is not a UTC time"],
  ["src/db/migrations/20261027T2460_pull_comment.ts", "which is not a UTC time"],
])("a new migration file %s fails", (path, message) => {
  const ran = probe("migrations-append-only", candidate(DB, { [path]: migration("x") }));
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain(path);
  expect(ran.output).toContain(message);
});

test("a new migration file whose exported id differs from its name fails", () => {
  const path = "src/db/migrations/20261027T1150_pull_comment_author.ts";
  const ran = probe(
    "migrations-append-only",
    candidate(DB, { [path]: migration("20261027T1151_pull_comment_author") }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain(`must be "20261027T1150_pull_comment_author"`);
});

const MERGE = {
  "src/merge/advance.ts": [
    'import { applyWorkItemEvent } from "../db";',
    'import type { ask } from "../questions";',
    "",
    "export function advance(db: unknown, id: string) {",
    '  applyWorkItemEvent(db, id, "merge_accepted");',
    "}",
    "",
  ].join("\n"),
  "src/merge/harness.ts": [
    'import { ask as rawAsk } from "../questions";',
    'export const asked = (db: unknown, id: string) => applyWorkItemEvent(db, id, "blocking_question");',
    "",
  ].join("\n"),
  "src/loop/merge.ts": 'export const event = "ejected";\n',
};

test("a fixture that applies ejected from src/merge fails restart-and-ask-from-loop", () => {
  const ran = probe(
    "restart-and-ask-from-loop",
    candidate(MERGE, {
      "src/merge/advance.ts": MERGE["src/merge/advance.ts"].replace(
        '  applyWorkItemEvent(db, id, "merge_accepted");',
        '  applyWorkItemEvent(db, id, "merge_accepted");\n  applyWorkItemEvent(\n    db,\n    id,\n    "ejected",\n  );',
      ),
    }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain('src/merge/advance.ts:9 names the ejected event: "ejected",');
});

test.each([
  ["closeout_rejected", 'export const send = (db: unknown) => apply(db, "closeout_rejected");\n'],
  ["a question opener import", 'import { openQuestion } from "../questions";\n'],
  ["a renamed opener import", 'import { type Asked, ask as askTeam } from "../questions";\n'],
  [
    "a namespaced opener call",
    'import * as questions from "../questions";\nexport const open = () => questions.openLinkAsk();\n',
  ],
])("adding %s outside src/loop fails", (_, body) => {
  const ran = probe(
    "restart-and-ask-from-loop",
    candidate(MERGE, { "src/github/send-back.ts": body }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain("src/github/send-back.ts:");
});

test.each([
  ["a call", "export const again = (db: unknown) => rawAsk(db, owner, input);"],
  ["a value use", "export const deps = { ask: rawAsk };"],
])("%s through an opener import already on the base fails", (_, line) => {
  const harness = MERGE["src/merge/harness.ts"];
  const ran = probe(
    "restart-and-ask-from-loop",
    candidate(MERGE, {
      "src/merge/harness.ts": `${harness}export type Ask = typeof rawAsk;\n${line}\n`,
    }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain(`src/merge/harness.ts:4 uses ask from "../questions": ${line}`);
  expect(ran.output).not.toContain("harness.ts:3");
});

test("src/loop, src/core, tests, type imports and lines already on the base pass", () => {
  const ran = probe(
    "restart-and-ask-from-loop",
    candidate(MERGE, {
      "src/loop/eject.ts": 'import { ask } from "../questions";\nexport const e = "ejected";\n',
      "src/core/events.ts": 'export const events = ["ejected", "closeout_rejected"];\n',
      "src/merge/advance.test.ts": 'apply(db, id, "ejected");\n',
      "src/merge/orders.ts": 'import type { ask } from "../questions";\nexport const o = 1;\n',
      "src/merge/harness.ts": `// Moved below.\n\n${MERGE["src/merge/harness.ts"]}`,
    }),
  );
  expect(ran.output).toContain("none sends work back or opens a question");
  expect(ran.exitCode).toBe(0);
});

test("moving a file out of src/loop with an ejected line fails", () => {
  const ran = probe(
    "restart-and-ask-from-loop",
    candidate(MERGE, {
      "src/loop/merge.ts": null,
      "src/merge/merge.ts": MERGE["src/loop/merge.ts"],
    }),
  );
  expect(ran.exitCode).toBe(1);
  expect(ran.output).toContain("src/merge/merge.ts:1 names the ejected event");
});
