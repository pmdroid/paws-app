/**
 * List candidate bugs that got past Closeout review.
 *
 * Takes the pull requests Paws merged in the window (author: the Paws GitHub
 * App) and every pull request merged after each one. For the lines a later
 * pull request removes or changes, `git blame` on its parent names the commit
 * that last wrote them. When that commit is a Paws squash, the later pull
 * request is a candidate fix of the Paws one.
 *
 * Pull requests come from `gh pr list` by default. `--source git` reads the
 * squash and merge commits on the local branch instead, for a machine without
 * `gh`. Blame always runs on the local clone, so fetch `main` first.
 *
 * Confirmed cases live in evals/review-escapes.jsonl; see docs/closeout.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MergedPull = {
  number: number;
  title: string;
  body: string;
  author: string;
  mergedAt: string;
  mergeCommit: string;
  baseRefOid?: string;
  headRefOid?: string;
};

export type BlamedLine = {
  commit: string;
  file: string;
  line: number;
  content: string;
};

export type CandidateLine = {
  file: string;
  line: number;
  content: string;
};

export type FixKind = "revert" | "fix" | "change";

export type Candidate = {
  original: {
    pr: number;
    title: string;
    base: string;
    head: string;
    mergeCommit: string;
  };
  fix: { pr: number; title: string; mergeCommit: string; mergedAt: string };
  kind: FixKind;
  bug: string;
  lines: CandidateLine[];
};

export type ReviewEscape = {
  id: string;
  original: {
    pr: number;
    title: string;
    base: string;
    head: string;
    mergeCommit: string;
  };
  fix: { pr: number; title: string; mergeCommit: string };
  file: string;
  line: number;
  bug: string;
  confirmedBy: string;
  confirmedAt: string;
};

export type Git = (args: readonly string[]) => string;

export type Options = {
  repo: string;
  app: string;
  days: number;
  branch: string;
  source: "gh" | "git";
  now: Date;
  known: ReadonlySet<string>;
};

const SHA = /^[0-9a-f]{40}$/;
const SKIPPED_FILES = [/(^|\/)bun\.lockb?$/, /(^|\/)package-lock\.json$/, /\.snap$/];

export function gitIn(cwd: string): Git {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
}

/** True when a pull request author is the Paws GitHub App, as `gh` or git names it. */
export function isAppAuthor(author: string, app: string): boolean {
  return author === app || author === `app/${app}` || author === `${app}[bot]`;
}

/** Reads the PR number from a squash subject `Title (#12)` or `Merge pull request #12 from`. */
export function pullNumberFromSubject(subject: string): number | null {
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+) /.exec(subject);
  return merge ? Number(merge[1]) : null;
}

/** Base and Head from the Closeout trailer Paws writes into its squash message. */
export function closeoutTrailer(body: string): { base?: string; head?: string } {
  const base = /^Base: ([0-9a-f]{40})$/m.exec(body)?.[1];
  const head = /^Head: ([0-9a-f]{40})$/m.exec(body)?.[1];
  return { base, head };
}

export function fixKind(pull: Pick<MergedPull, "title" | "body">): FixKind {
  if (/^revert\b/i.test(pull.title) || /^This reverts commit /m.test(pull.body)) return "revert";
  // Only the title: Paws bodies start with "Fixes PAS-123" for every issue.
  return /\b(fix(es|ed)?|bug|regress\w*|broken|crash\w*|races?|flak\w*|wrong|incorrect|leak\w*|hangs?|stale)\b/i.test(
    pull.title.replace(/-/g, " "),
  )
    ? "fix"
    : "change";
}

export function parseGhPulls(json: string): MergedPull[] {
  const rows = JSON.parse(json) as Array<{
    number: number;
    title: string;
    body: string | null;
    author: { login: string } | null;
    mergedAt: string;
    mergeCommit: { oid: string } | null;
    baseRefOid?: string;
    headRefOid?: string;
  }>;
  return rows
    .filter((row) => row.mergeCommit?.oid)
    .map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      author: row.author?.login ?? "",
      mergedAt: row.mergedAt,
      mergeCommit: row.mergeCommit!.oid,
      baseRefOid: row.baseRefOid,
      headRefOid: row.headRefOid,
    }));
}

export function parseGitPulls(log: string): MergedPull[] {
  const pulls: MergedPull[] = [];
  for (const record of log.split("\x1e")) {
    const [sha, author, date, subject, body] = record.replace(/^\n/, "").split("\x1f");
    if (!sha || !SHA.test(sha) || subject === undefined) continue;
    const number = pullNumberFromSubject(subject);
    if (number === null) continue;
    // GitHub's merge commit keeps the branch in the subject and the title in the body.
    const merge = /^Merge pull request #\d+ from \S+?\/(\S+)$/.exec(subject);
    const mergeTitle = body?.split("\n")[2]?.trim();
    pulls.push({
      number,
      title: merge
        ? `${mergeTitle || merge[1]} (${merge[1]})`
        : subject.replace(/\s*\(#\d+\)\s*$/, ""),
      body: body ?? "",
      author: author ?? "",
      mergedAt: date ?? "",
      mergeCommit: sha,
    });
  }
  return pulls;
}

/** Removed or changed line ranges per old path, from `git diff -U0 -M`. */
export function removedRanges(diff: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
    } else if (line.startsWith("--- ")) {
      file = line === "--- /dev/null" ? null : line.slice(6);
    } else if (file && line.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (!hunk) continue;
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count === 0) continue;
      const list = ranges.get(file) ?? [];
      list.push([start, count]);
      ranges.set(file, list);
    }
  }
  return ranges;
}

/** Commit, original file and original line for each line of `git blame --line-porcelain`. */
export function parseBlame(output: string): BlamedLine[] {
  const lines: BlamedLine[] = [];
  let commit = "";
  let origLine = 0;
  let file = "";
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(line);
    if (header) {
      commit = header[1]!;
      origLine = Number(header[2]);
    } else if (line.startsWith("filename ")) {
      file = line.slice("filename ".length);
    } else if (line.startsWith("\t")) {
      lines.push({ commit, file, line: origLine, content: line.slice(1) });
    }
  }
  return lines;
}

export function caseKey(original: number, fix: number): string {
  return `${original}-${fix}`;
}

export function listPulls(git: Git, options: Options): MergedPull[] {
  const since = new Date(options.now.getTime() - options.days * 86_400_000);
  if (options.source === "git") {
    return parseGitPulls(
      git([
        "log",
        "--first-parent",
        `--since=${since.toISOString()}`,
        "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%B%x1e",
        options.branch,
      ]),
    );
  }
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      options.repo,
      "--state",
      "merged",
      "--base",
      options.branch,
      "--search",
      `merged:>=${since.toISOString().slice(0, 10)}`,
      "--limit",
      "2000",
      "--json",
      "number,title,body,author,mergedAt,mergeCommit,baseRefOid,headRefOid",
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh pr list failed: ${result.error?.message ?? result.stderr.trim()}. Run gh auth login, or pass --source git.`,
    );
  }
  return parseGhPulls(result.stdout);
}

export function findCandidates(
  git: Git,
  pulls: readonly MergedPull[],
  options: Options,
): Candidate[] {
  const ordered = [...pulls].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const present = ordered.filter((pull) => {
    try {
      git(["cat-file", "-e", `${pull.mergeCommit}^{commit}`]);
      return true;
    } catch {
      console.error(`skip #${pull.number}: ${pull.mergeCommit} is not in this clone`);
      return false;
    }
  });
  const paws = new Map(
    present
      .filter((pull) => isAppAuthor(pull.author, options.app))
      .map((pull) => [pull.mergeCommit, pull]),
  );
  const found = new Map<string, Candidate>();
  for (const pull of present) {
    const parent = `${pull.mergeCommit}^1`;
    // A root commit changes no earlier line.
    if (!git(["rev-list", "--parents", "-n", "1", pull.mergeCommit]).trim().includes(" ")) continue;
    const diff = git([
      "diff",
      "-U0",
      "-M",
      "--no-color",
      "--no-ext-diff",
      parent,
      pull.mergeCommit,
    ]);
    for (const [file, ranges] of removedRanges(diff)) {
      if (SKIPPED_FILES.some((pattern) => pattern.test(file))) continue;
      const blame = git([
        "blame",
        "-w",
        "--line-porcelain",
        ...ranges.flatMap(([start, count]) => ["-L", `${start},+${count}`]),
        parent,
        "--",
        file,
      ]);
      for (const blamed of parseBlame(blame)) {
        const original = paws.get(blamed.commit);
        if (!original || original.number === pull.number) continue;
        if (!/[A-Za-z0-9]/.test(blamed.content)) continue;
        const key = caseKey(original.number, pull.number);
        if (options.known.has(key)) continue;
        let candidate = found.get(key);
        if (!candidate) {
          const trailer = closeoutTrailer(original.body);
          candidate = {
            original: {
              pr: original.number,
              title: original.title,
              base:
                trailer.base ??
                original.baseRefOid ??
                git(["rev-parse", `${original.mergeCommit}^1`]).trim(),
              head: trailer.head ?? original.headRefOid ?? original.mergeCommit,
              mergeCommit: original.mergeCommit,
            },
            fix: {
              pr: pull.number,
              title: pull.title,
              mergeCommit: pull.mergeCommit,
              mergedAt: pull.mergedAt,
            },
            kind: fixKind(pull),
            bug: `#${pull.number} changed it: ${pull.title}`,
            lines: [],
          };
          found.set(key, candidate);
        }
        candidate.lines.push({
          file: blamed.file,
          line: blamed.line,
          content: blamed.content.trim(),
        });
      }
    }
  }
  const rank: Record<FixKind, number> = { revert: 0, fix: 1, change: 2 };
  return [...found.values()].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.fix.mergedAt.localeCompare(b.fix.mergedAt),
  );
}

/** The case line to append to evals/review-escapes.jsonl once a person confirms it. */
export function draftEscape(
  candidate: Candidate,
  line = candidate.lines[0],
): Omit<ReviewEscape, "confirmedBy" | "confirmedAt"> {
  if (!line)
    throw new Error(`candidate ${caseKey(candidate.original.pr, candidate.fix.pr)} has no lines`);
  return {
    id: caseKey(candidate.original.pr, candidate.fix.pr),
    original: candidate.original,
    fix: {
      pr: candidate.fix.pr,
      title: candidate.fix.title,
      mergeCommit: candidate.fix.mergeCommit,
    },
    file: line.file,
    line: line.line,
    bug: candidate.bug,
  };
}

const VERB: Record<FixKind, string> = { revert: "reverts", fix: "fixes", change: "changes" };

export function formatCandidate(candidate: Candidate, maxLines = 5): string {
  const { original, fix } = candidate;
  const out = [
    `#${fix.pr} ${VERB[candidate.kind]} #${original.pr} (${candidate.lines.length} line${candidate.lines.length === 1 ? "" : "s"})`,
    `  original: #${original.pr} ${original.title}`,
    `  fix:      #${fix.pr} ${fix.title}`,
    `  bug:      ${candidate.bug}`,
    `  replay:   base ${original.base} head ${original.head}`,
  ];
  for (const line of candidate.lines.slice(0, maxLines)) {
    out.push(`  ${line.file}:${line.line}  ${line.content.slice(0, 100)}`);
  }
  if (candidate.lines.length > maxLines) out.push(`  … ${candidate.lines.length - maxLines} more`);
  return out.join("\n");
}

export function readEscapes(path: string): ReviewEscape[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReviewEscape);
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args: readonly string[]): void {
  if (args.includes("--help")) {
    console.log(
      [
        "bun scripts/review-escapes.ts [--days 30] [--repo pmdroid/paws-app] [--app paws-helper]",
        "                              [--branch main] [--source gh|git] [--kinds fix,revert,change] [--jsonl]",
      ].join("\n"),
    );
    return;
  }
  const root = join(import.meta.dir, "..");
  const escapesPath = join(root, "evals/review-escapes.jsonl");
  const source = argValue(args, "--source") ?? "gh";
  if (source !== "gh" && source !== "git") throw new Error("--source is gh or git");
  const options: Options = {
    repo: argValue(args, "--repo") ?? "pmdroid/paws-app",
    app: argValue(args, "--app") ?? "paws-helper",
    days: Number(argValue(args, "--days") ?? 30),
    branch: argValue(args, "--branch") ?? "main",
    source,
    now: new Date(),
    known: new Set(readEscapes(escapesPath).map((escape) => escape.id)),
  };
  const kinds = new Set((argValue(args, "--kinds") ?? "revert,fix,change").split(","));
  const git = gitIn(root);
  const pulls = listPulls(git, options);
  const candidates = findCandidates(git, pulls, options).filter((candidate) =>
    kinds.has(candidate.kind),
  );
  if (args.includes("--jsonl")) {
    for (const candidate of candidates) console.log(JSON.stringify(draftEscape(candidate)));
    return;
  }
  const pawsCount = pulls.filter((pull) => isAppAuthor(pull.author, options.app)).length;
  console.log(
    `${pulls.length} pull requests merged in ${options.days} days, ${pawsCount} by ${options.app}; ` +
      `${candidates.length} candidates (${options.known.size} already in evals/review-escapes.jsonl)\n`,
  );
  console.log(candidates.map((candidate) => formatCandidate(candidate)).join("\n\n"));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
