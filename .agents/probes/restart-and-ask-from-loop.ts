/**
 * Closeout rule `restart-and-ask-from-loop`.
 *
 * Only `src/loop` sends an item back to the agent or asks a person, through
 * `restart()` and `ask()`; `src/core` owns the edge table. Outside those two,
 * source must not name the `ejected`, `closeout_rejected` or
 * `blocking_question` events, and must not import or use a question opener
 * from `src/questions`.
 *
 * Only what the branch adds counts: a changed file fails when it has such a
 * line that its base version did not have. Tests are not checked.
 *
 * Runs as `bun restart-and-ask-from-loop.ts --base <sha> --head <sha> --repo <checkout>`
 * and reads only committed trees. Exits 0 when the rule holds and 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const OWNERS = ["src/loop/", "src/core/"];
const SOURCE = /^src\/.+\.[cm]?[jt]sx?$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const EVENTS = /(["'`])(ejected|closeout_rejected|blocking_question)\1/g;
const OPENERS = new Set([
  "ask",
  "openQuestion",
  "insertQuestion",
  "openLinkAsk",
  "openVisualReview",
  "openVisualReviewContinue",
  "insertVisualReview",
]);
const QUESTIONS_MODULE = /(?:^|\/)questions(?:\/[\w.-]+)*$/;
const NAMED_IMPORT = /\b(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\3/g;
const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*(["'])([^"']+)\2/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;

const { base, head, repo } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    repo: { type: "string" },
  },
  strict: true,
}).values;
if (!base || !head || !repo) {
  console.error("usage: restart-and-ask-from-loop.ts --base <sha> --head <sha> --repo <checkout>");
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

/** Each path at head with the path it had on the base, or null when it is new there. */
function changes(): { path: string; from: string | null }[] {
  const fields = git("diff", "--name-status", "-M", "-z", base!, head!).split("\0");
  const listed: { path: string; from: string | null }[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index++]!;
      const path = fields[index++]!;
      listed.push({ path, from: status.startsWith("R") ? from : null });
    } else {
      const path = fields[index++]!;
      if (status !== "D") listed.push({ path, from: status === "A" ? null : path });
    }
  }
  return listed;
}

function checked(path: string): boolean {
  return SOURCE.test(path) && !TEST.test(path) && !OWNERS.some((owner) => path.startsWith(owner));
}

type Hit = { line: number; what: string; text: string };

function lineAt(source: string, offset: number): { line: number; text: string } {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  return {
    line: source.slice(0, offset).split("\n").length,
    text: source.slice(start, end === -1 ? undefined : end).trim(),
  };
}

function hits(source: string): Hit[] {
  const found: Hit[] = [];
  const add = (offset: number, what: string) => found.push({ ...lineAt(source, offset), what });
  for (const match of source.matchAll(EVENTS)) add(match.index, `names the ${match[2]} event`);
  // Each use of an imported opener is a hit too, so a new call through an import the base
  // already had still counts. `typeof` and the import statements themselves are not uses.
  const statements: [number, number][] = [];
  const uses: { local: string; imported: string; module: string }[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    statements.push([match.index, match.index + match[0].length]);
    if (match[1] || !QUESTIONS_MODULE.test(match[4]!)) continue;
    for (const specifier of match[2]!.split(",")) {
      const name = specifier.trim();
      if (name.startsWith("type ")) continue;
      const [imported, local = imported] = name.split(/\s+as\s+/).map((part) => part.trim());
      if (!imported || !OPENERS.has(imported)) continue;
      add(match.index, `imports ${imported} from "${match[4]}"`);
      if (match[0].startsWith("import")) uses.push({ local: local!, imported, module: match[4]! });
    }
  }
  const inStatement = (offset: number) =>
    statements.some(([start, end]) => offset >= start && offset < end);
  for (const { local, imported, module } of uses) {
    const reference = new RegExp(`(?<![\\w$.])${escape(local)}(?![\\w$])`, "g");
    for (const used of source.matchAll(reference))
      if (
        !inStatement(used.index) &&
        !/\btypeof\s+$/.test(source.slice(Math.max(0, used.index - 16), used.index))
      )
        add(used.index, `uses ${imported} from "${module}"`);
  }
  for (const match of source.matchAll(NAMESPACE_IMPORT)) {
    if (!QUESTIONS_MODULE.test(match[3]!)) continue;
    const member = new RegExp(`(?<![\\w$.])${escape(match[1]!)}\\s*\\.\\s*([\\w$]+)`, "g");
    for (const used of source.matchAll(member))
      if (OPENERS.has(used[1]!)) add(used.index, `uses ${used[1]} from "${match[3]}"`);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT))
    if (QUESTIONS_MODULE.test(match[2]!)) add(match.index, `loads "${match[2]}" at run time`);
  return found;
}

function escape(identifier: string): string {
  return identifier.replace(/\$/g, "\\$");
}

function blob(rev: string, path: string): string {
  return git("cat-file", "blob", `${rev}:${path}`);
}

const problems: string[] = [];
let files = 0;
for (const { path, from } of changes()) {
  if (!checked(path)) continue;
  files += 1;
  const before = new Map<string, number>();
  if (from !== null && checked(from))
    for (const hit of hits(blob(base, from))) {
      const key = `${hit.what}\0${hit.text}`;
      before.set(key, (before.get(key) ?? 0) + 1);
    }
  for (const hit of hits(blob(head, path))) {
    const key = `${hit.what}\0${hit.text}`;
    const left = before.get(key) ?? 0;
    if (left > 0) before.set(key, left - 1);
    else problems.push(`${path}:${hit.line} ${hit.what}: ${hit.text}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(
    "Only src/loop sends an item back to the agent or asks a person: call restart() or ask() from src/loop.",
  );
  process.exit(1);
}
console.log(
  `${files} changed source file${files === 1 ? "" : "s"} outside src/loop and src/core; none sends work back or opens a question.`,
);
