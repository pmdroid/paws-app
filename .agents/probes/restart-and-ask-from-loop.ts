/**
 * Closeout rule `restart-and-ask-from-loop`.
 *
 * Only `src/loop` sends an item back to the agent or asks a person, through
 * `restart()` and `ask()`; `src/core` owns the edge table. Outside those two,
 * source must not name the `ejected`, `closeout_rejected` or
 * `blocking_question` events, and must not import or use a question opener
 * from `src/questions`: directly, renamed, through a namespace or dynamic
 * import, destructured, or through a `const` alias of any of those.
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
const EXPORT_ALL = /\bexport\s+\*(?:\s+as\s+[\w$]+)?\s+from\s*(["'])([^"']+)\1/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;
const LOAD = String.raw`(?:await\s+)?(?:import|require)\s*\(\s*(["'\x60])([^"'\x60]+)\2\s*\)`;
/** `const questions = await import("../questions")`. */
const BOUND_MODULE = new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*${LOAD}`, "g");
/** `const send = ask` or `const send = questions.ask`. Groups: alias, target, member. */
const ALIAS =
  /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?=\s*([\w$]+)(?:\s*(?:\?\.|\.)\s*([\w$]+))?\s*(?=[;,)\n]|$)/gm;
/** `const { ask } = questions` or `= await import("../questions")`. Groups: names, source, module. */
const DESTRUCTURE = new RegExp(
  String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:(?!await\b)([\w$]+)\b(?!\s*\()|${LOAD.replace("\\2", "\\3")})`,
  "g",
);

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
  // Every use of a binding that holds an opener or the questions module is a hit, so a new
  // call through a binding the base already had still counts. A binding's own statement and
  // `typeof` are not uses.
  const statements: [number, number][] = [];
  const statement = (match: RegExpMatchArray) =>
    statements.push([match.index!, match.index! + match[0].length]);
  const openers: { local: string; imported: string; module: string }[] = [];
  const namespaces: { local: string; module: string }[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    statement(match);
    if (match[1] || !QUESTIONS_MODULE.test(match[4]!)) continue;
    for (const specifier of match[2]!.split(",")) {
      const name = specifier.trim();
      if (name.startsWith("type ")) continue;
      const [imported, local = imported] = name.split(/\s+as\s+/).map((part) => part.trim());
      if (!imported || !OPENERS.has(imported)) continue;
      add(match.index, `imports ${imported} from "${match[4]}"`);
      if (match[0].startsWith("import"))
        openers.push({ local: local!, imported, module: match[4]! });
    }
  }
  for (const match of source.matchAll(NAMESPACE_IMPORT)) {
    statement(match);
    if (QUESTIONS_MODULE.test(match[3]!)) namespaces.push({ local: match[1]!, module: match[3]! });
  }
  for (const match of source.matchAll(EXPORT_ALL))
    if (QUESTIONS_MODULE.test(match[2]!)) add(match.index, `re-exports "${match[2]}"`);
  for (const match of source.matchAll(DYNAMIC_IMPORT))
    if (QUESTIONS_MODULE.test(match[2]!)) add(match.index, `loads "${match[2]}" at run time`);
  for (const match of source.matchAll(BOUND_MODULE))
    if (QUESTIONS_MODULE.test(match[3]!)) {
      statement(match);
      namespaces.push({ local: match[1]!, module: match[3]! });
    }
  // `const { ask, ...rest } = questions` (or `= await import(...)`) binds openers and namespaces.
  for (const match of source.matchAll(DESTRUCTURE)) {
    const module = match[4] ?? namespaces.find((namespace) => namespace.local === match[2])?.module;
    if (module === undefined || !QUESTIONS_MODULE.test(module)) continue;
    statement(match);
    for (const specifier of match[1]!.split(",")) {
      const rest = /^\.\.\.\s*([\w$]+)$/.exec(specifier.trim());
      if (rest) namespaces.push({ local: rest[1]!, module });
      const [imported, local = imported] = specifier
        .split("=")[0]!
        .split(":")
        .map((part) => part.trim());
      if (!imported || !OPENERS.has(imported)) continue;
      add(match.index!, `binds ${imported} from "${module}"`);
      openers.push({ local: local!, imported, module });
    }
  }
  // `const send = ask` and `const send = questions.ask` alias a binding; follow them to a fixpoint.
  for (let grew = true; grew;) {
    grew = false;
    for (const match of source.matchAll(ALIAS)) {
      const [, local, target, member] = match as unknown as [string, string, string, string?];
      if (openers.some((o) => o.local === local) || namespaces.some((n) => n.local === local))
        continue;
      const opener = member === undefined && openers.find((o) => o.local === target);
      const namespace = namespaces.find((n) => n.local === target);
      if (opener) openers.push({ ...opener, local });
      else if (namespace && member === undefined) namespaces.push({ ...namespace, local });
      else if (namespace && OPENERS.has(member!))
        openers.push({ local, imported: member!, module: namespace.module });
      else continue;
      grew = true;
    }
  }
  const use = (offset: number) =>
    !statements.some(([start, end]) => offset >= start && offset < end) &&
    !/\btypeof\s+$/.test(source.slice(Math.max(0, offset - 16), offset));
  for (const { local, imported, module } of openers)
    for (const used of source.matchAll(reference(local)))
      if (use(used.index)) add(used.index, `uses ${imported} from "${module}"`);
  // A namespace used other than through a member that is not an opener may reach one.
  for (const { local, module } of namespaces)
    for (const used of source.matchAll(reference(local))) {
      if (!use(used.index)) continue;
      const after = source.slice(used.index + used[0].length);
      const member = /^\s*(?:\?\.|\.)\s*([\w$]+)/.exec(after)?.[1];
      if (member !== undefined && !OPENERS.has(member)) continue;
      add(used.index, member ? `uses ${member} from "${module}"` : `uses "${module}" as ${local}`);
    }
  return found;
}

function reference(identifier: string): RegExp {
  return new RegExp(`(?<![\\w$./"'\x60-])${identifier.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
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
  for (const problem of new Set(problems)) console.log(problem);
  console.log(
    "Only src/loop sends an item back to the agent or asks a person: call restart() or ask() from src/loop.",
  );
  process.exit(1);
}
console.log(
  `${files} changed source file${files === 1 ? "" : "s"} outside src/loop and src/core; none sends work back or opens a question.`,
);
