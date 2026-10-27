/**
 * Closeout rule `migrations-append-only`.
 *
 * `src/db/migrations.ts` is frozen at `155_pull_comment`, and a migration file
 * under `src/db/migrations/` never changes once it is on main. A new file is
 * named for a UTC time to the minute and what it does, and exports `migration`
 * with that id: `20261026T0512_pull_comment_author.ts`.
 *
 * Runs as `bun migrations-append-only.ts --base <sha> --head <sha> --repo <checkout>`
 * and reads only committed trees. Exits 0 when the rule holds and 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const FROZEN = "src/db/migrations.ts";
const DIRECTORY = "src/db/migrations/";
const FILE_NAME = /^((\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*)\.ts$/;
const EXAMPLE = "20261026T0512_pull_comment_author.ts";

const { base, head, repo } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    repo: { type: "string" },
  },
  strict: true,
}).values;
if (!base || !head || !repo) {
  console.error("usage: migrations-append-only.ts --base <sha> --head <sha> --repo <checkout>");
  process.exit(2);
}

function git(...args: string[]): string {
  const ran = spawnSync("git", ["-C", repo!, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.trim()}`);
  return ran.stdout;
}

/** `[status, path]` pairs. Renames are a deletion and an addition. */
function changes(): [string, string][] {
  const fields = git(
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    base!,
    head!,
    "--",
    FROZEN,
    DIRECTORY,
  ).split("\0");
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < fields.length; index += 2)
    pairs.push([fields[index]!, fields[index + 1]!]);
  return pairs;
}

const STATUS: Record<string, string> = {
  M: "was edited",
  D: "was deleted or renamed",
  T: "changed type",
};

function isUtcMinute(year: string, month: string, day: string, hour: string, minute: string) {
  const at = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute));
  return (
    at.getUTCFullYear() === +year &&
    at.getUTCMonth() === +month - 1 &&
    at.getUTCDate() === +day &&
    at.getUTCHours() === +hour &&
    at.getUTCMinutes() === +minute
  );
}

/** Problems with a migration file added on the branch. */
function checkNewFile(path: string): string[] {
  const name = path.slice(DIRECTORY.length);
  const match = FILE_NAME.exec(name);
  if (!match)
    return [
      `${path} is not named <yyyymmdd>T<hhmm>_<name>.ts with a UTC time and a lowercase snake_case name, for example ${EXAMPLE}.`,
    ];
  const [, id, year, month, day, hour, minute] = match as unknown as string[];
  if (!isUtcMinute(year!, month!, day!, hour!, minute!))
    return [
      `${path} is named for ${year}-${month}-${day} ${hour}:${minute}, which is not a UTC time.`,
    ];
  const source = git("cat-file", "blob", `${head}:${path}`);
  const exported = /export\s+const\s+migration\b[\s\S]*?\bid\s*:\s*(["'`])([^"'`]+)\1/.exec(source);
  if (!exported) return [`${path} does not export \`migration\` with a literal id "${id}".`];
  if (exported[2] !== id) return [`${path} exports id "${exported[2]}"; its id must be "${id}".`];
  return [];
}

const problems: string[] = [];
let added = 0;
for (const [status, path] of changes()) {
  if (path === FROZEN) {
    problems.push(
      `${FROZEN} changed. The list is frozen at 155_pull_comment: add a migration file under ${DIRECTORY} instead.`,
    );
    continue;
  }
  const name = path.slice(DIRECTORY.length);
  // The loader reads only `.ts` files directly in the directory; the README is not a migration.
  if (!path.startsWith(DIRECTORY) || name.includes("/") || !name.endsWith(".ts")) continue;
  if (status === "A") {
    added += 1;
    problems.push(...checkNewFile(path));
    continue;
  }
  problems.push(
    `${path} is a shipped migration and ${STATUS[status] ?? `changed (${status})`}. Shipped migration files never change: add a new file under ${DIRECTORY}.`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  process.exit(1);
}
console.log(
  added === 0
    ? "No migration changed."
    : `${added} new migration file${added === 1 ? "" : "s"}, each named for a UTC time and exporting its id.`,
);
