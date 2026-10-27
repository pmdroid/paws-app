import type { Database } from "bun:sqlite";
import {
  openReviewEscapes,
  settleReviewEscape,
  type NotEscapeReason,
  type ReviewEscapeRecord,
} from "../db";

/** What a fix changed between the accepted head and the head Closeout accepted after it. */
export type FixDiff = {
  /** Every file the fix's own commits touched. */
  files: string[];
  /** The files whose change is more than whitespace. */
  substantive: string[];
  /** The files of the change the independent review saw at the accepted head. */
  reviewed: string[];
};

/** Reads a fix's diff; see {@link readFixDiff}. */
export type FixDiffReader = (accepted: string, fix: string, base: string) => Promise<FixDiff>;

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|__snapshots__|spec|fixtures?)\//,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)[^/]+_test\.[^/]+$/,
];
const DOC_PATH = [
  /(^|\/)docs?\//,
  /\.(md|mdx|markdown|rst|txt|adoc)$/i,
  /(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)[^/]*$/,
];

/** A test, fixture or documentation path: a fix that only touches these is not an escape. */
export function testOrDocPath(path: string): boolean {
  return [...TEST_PATH, ...DOC_PATH].some((pattern) => pattern.test(path));
}

/**
 * Whether a fix round's candidate counts against the independent review. A CI failure that also
 * fails on main is a flake. A fix that changes nothing, or only tests, docs or whitespace, is not
 * an escape, and neither is a review or comment fix outside the files the review saw.
 */
export function classifyReviewEscape(
  candidate: Pick<ReviewEscapeRecord, "trigger" | "detail">,
  diff: FixDiff,
): { escape: true } | { escape: false; reason: NotEscapeReason } {
  const checks = candidate.detail.checks ?? [];
  if (candidate.trigger === "ci" && checks.length > 0 && checks.every((check) => check.failsOnBase))
    return { escape: false, reason: "flake" };
  if (diff.files.length === 0) return { escape: false, reason: "no_change" };
  const code = diff.substantive.filter((path) => !testOrDocPath(path));
  if (code.length === 0) return { escape: false, reason: "tests_docs_format" };
  if (candidate.trigger !== "ci") {
    const reviewed = new Set(diff.reviewed);
    if (!code.some((path) => reviewed.has(path))) return { escape: false, reason: "unreviewed" };
  }
  return { escape: true };
}

/**
 * Closeout accepted `fixHead`: settle every open candidate of the item that started on an earlier
 * head with the files its fix changed. A diff that can't be read leaves the candidate open for the
 * next acceptance. The number settled.
 */
export async function settleReviewEscapes(
  db: Database,
  input: { itemId: string; fixHead: string; base: string; now: number; read: FixDiffReader },
): Promise<number> {
  let settled = 0;
  for (const candidate of openReviewEscapes(db, input.itemId)) {
    if (candidate.acceptedHead === input.fixHead) continue;
    const diff = await input.read(candidate.acceptedHead, input.fixHead, input.base);
    const verdict = classifyReviewEscape(candidate, diff);
    if (
      settleReviewEscape(db, candidate.id, {
        fixHead: input.fixHead,
        files: diff.files,
        escape: verdict.escape,
        notEscapeReason: verdict.escape ? null : verdict.reason,
        now: input.now,
      })
    )
      settled++;
  }
  return settled;
}

/**
 * The fix's diff in `worktree`. Its commits are the ones on `fix` and not on `accepted` or
 * `base`, without merges and without commits whose patch `accepted` already has, so a rebase onto
 * main counts only what the fix added.
 */
export function readFixDiff(
  git: (args: string[]) => Promise<string>,
  worktree: string,
): FixDiffReader {
  return async (accepted, fix, base) => {
    const range = [
      "--no-merges",
      "--no-renames",
      "--cherry-pick",
      "--right-only",
      "--format=",
      "--numstat",
      "-z",
      `${accepted}...${fix}`,
      `^${base}`,
    ];
    const [all, substantive, reviewed] = await Promise.all([
      git(["-C", worktree, "log", ...range]),
      git(["-C", worktree, "log", "-w", "--ignore-blank-lines", ...range]),
      git(["-C", worktree, "diff", "--no-renames", "--name-only", "-z", `${base}...${accepted}`]),
    ]);
    return {
      files: numstatPaths(all),
      substantive: numstatPaths(substantive),
      reviewed: [...new Set(reviewed.split("\0").filter((path) => path !== ""))].sort(),
    };
  };
}

function numstatPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const entry of output.split("\0")) {
    const path = entry.replace(/^\n+/, "").split("\t")[2];
    if (path) paths.add(path);
  }
  return [...paths].sort();
}
