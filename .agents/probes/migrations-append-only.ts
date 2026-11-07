import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const DRIZZLE = "src/db/drizzle/";
const JOURNAL = `${DRIZZLE}meta/_journal.json`;
const LEGACY = ["src/db/migrations.ts", "src/db/migrations/"];

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

function git(...args: string[]): { ok: boolean; out: string; err: string } {
  const ran = spawnSync("git", ["-C", repo!, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: ran.status === 0, out: ran.stdout, err: ran.stderr };
}

/** `[status, path]` pairs. Renames are a deletion and an addition. */
function changes(): [string, string][] {
  const ran = git(
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    base!,
    head!,
    "--",
    DRIZZLE,
    ...LEGACY,
  );
  if (!ran.ok) throw new Error(`git diff failed: ${ran.err.trim()}`);
  const fields = ran.out.split("\0");
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < fields.length; index += 2)
    pairs.push([fields[index]!, fields[index + 1]!]);
  return pairs;
}

type Entry = { idx: number; when: number; tag: string };

function journal(sha: string): Entry[] {
  const ran = git("cat-file", "blob", `${sha}:${JOURNAL}`);
  if (!ran.ok) return [];
  return (JSON.parse(ran.out) as { entries: Entry[] }).entries;
}

const problems: string[] = [];
const added = new Set<string>();
for (const [status, path] of changes()) {
  if (!path.startsWith(DRIZZLE)) {
    if (status !== "D")
      problems.push(
        `${path} is a legacy migration path. The legacy migrations are frozen: generate a drizzle-kit migration under ${DRIZZLE} instead.`,
      );
    continue;
  }
  if (status === "A") added.add(path);
  else if (path !== JOURNAL)
    problems.push(
      `${path} is a shipped drizzle-kit migration and ${status === "M" ? "was edited" : status === "D" ? "was deleted or renamed" : `changed (${status})`}. Shipped migrations never change: generate a new one.`,
    );
}

const before = journal(base);
const after = journal(head);
before.forEach((entry, index) => {
  if (JSON.stringify(after[index]) !== JSON.stringify(entry))
    problems.push(
      `${JOURNAL} changed the shipped entry ${entry.tag}. The journal only gains entries at its end.`,
    );
});
const fresh = after.slice(before.length);
fresh.forEach((entry, offset) => {
  const index = before.length + offset;
  const previous = after[index - 1];
  if (entry.idx !== index)
    problems.push(`${JOURNAL} entry ${entry.tag} has idx ${entry.idx}; it must be ${index}.`);
  if (previous !== undefined && !(entry.when > previous.when))
    problems.push(
      `${JOURNAL} entry ${entry.tag} is not later than ${previous.tag}, so drizzle-kit would skip it on a database that has ${previous.tag}. Generate it again on top of main.`,
    );
  if (!added.has(`${DRIZZLE}${entry.tag}.sql`))
    problems.push(`${JOURNAL} entry ${entry.tag} has no new ${DRIZZLE}${entry.tag}.sql.`);
});
for (const path of added) {
  const tag = /^src\/db\/drizzle\/([^/]+)\.sql$/.exec(path)?.[1];
  if (tag !== undefined && !fresh.some((entry) => entry.tag === tag))
    problems.push(`${path} has no new entry in ${JOURNAL}, so drizzle-kit never applies it.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  process.exit(1);
}
console.log(
  fresh.length === 0
    ? "No migration changed."
    : `${fresh.length} new drizzle-kit migration${fresh.length === 1 ? "" : "s"}, appended to the journal.`,
);
