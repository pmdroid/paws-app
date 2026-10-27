import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { evidencePath } from "../closeout";
import { reviewRecordsSince } from "../closeout-spec";
import { getWorkItemRepository, listWorkItems, openDatabase } from "../db";
import { journalCaught } from "../journal";
import { itemPathId } from "../loop";
import { DEFAULT_SINCE_DAYS } from "./sources";
import { DEFAULT_OUT, formatCandidate } from "./output";
import type { Candidate, StoredFinding } from "./types";

export const PROBES_USAGE = `usage: paws probes collect <owner/repo> [--since <days>d|<YYYY-MM-DD>] [--out <file>] [--keep <id,id>] [--dry-run]

Drafts Closeout probe rules from the pull request comments of the last ${DEFAULT_SINCE_DAYS} days,
stored Closeout review findings, and the repository's agent docs. The agent runs on this machine
with your own sign-in. It writes ${DEFAULT_OUT} (or --out) and the probe scripts next to it,
for you to review and add to .agents/closeout.yaml. It does not commit, push, or open a pull request.`;

export type ProbesCommand = {
  owner: string;
  repo: string;
  since: Date;
  out: string;
  keep: string[] | null;
  dryRun: boolean;
};

/** `probes collect …` arguments. Throws with the usage on anything else. */
export function parseProbesArgs(argv: readonly string[], now = new Date()): ProbesCommand {
  const fail = (message: string): never => {
    throw new Error(`${message}\n\n${PROBES_USAGE}`);
  };
  if (argv[0] !== "collect") fail("Unknown probes command.");
  let target: string | undefined;
  let since = new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
  let out = DEFAULT_OUT;
  let keep: string[] | null = null;
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => argv[++index] ?? fail(`${arg} needs a value.`);
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--out") out = value();
    else if (arg === "--keep")
      keep = value()
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    else if (arg === "--since") since = parseSince(value(), now) ?? fail(`Invalid --since.`);
    else if (arg.startsWith("-")) fail(`Unknown option ${arg}.`);
    else if (target === undefined) target = arg;
    else fail(`Unexpected argument ${arg}.`);
  }
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(target ?? "");
  if (!match) return fail("Name the repository as owner/repo.");
  return { owner: match[1]!, repo: match[2]!, since, out, keep, dryRun };
}

function parseSince(value: string, now: Date): Date | null {
  const days = /^(\d+)d?$/.exec(value);
  if (days) return new Date(now.getTime() - Number(days[1]) * 86_400_000);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Review findings Closeout stored for the repository's tasks in this Paws home. A missing
 * database or evidence directory reads as none.
 */
export async function readStoredFindings(input: {
  home: string;
  dbPath: string;
  owner: string;
  repo: string;
}): Promise<StoredFinding[]> {
  if (!existsSync(input.dbPath)) return [];
  const db = openDatabase(input.dbPath);
  const tasks: string[] = [];
  try {
    for (const item of listWorkItems(db)) {
      const bound = getWorkItemRepository(db, item.id);
      if (bound?.owner.toLowerCase() !== input.owner.toLowerCase()) continue;
      if (bound.repo.toLowerCase() !== input.repo.toLowerCase()) continue;
      tasks.push(itemPathId(item));
    }
  } finally {
    db.close();
  }
  const findings: StoredFinding[] = [];
  for (const task of tasks) {
    const dir = evidencePath(task, input.home);
    if (!existsSync(dir)) continue;
    try {
      for (const record of await reviewRecordsSince(dir, []))
        for (const finding of record.findings)
          findings.push({ task, check: record.itemId, head: record.head, finding });
    } catch (error) {
      journalCaught(error, "probe-collector.readStoredFindings", task);
    }
  }
  return findings;
}

/** Ask on the terminal which candidates to keep. `--keep` answers without asking. */
export function keepCandidates(
  keep: readonly string[] | null,
  print: (text: string) => void,
): (candidates: readonly Candidate[]) => Promise<string[]> {
  return async (candidates) => {
    if (keep) {
      const known = new Set(candidates.map((candidate) => candidate.id));
      for (const id of keep)
        if (!known.has(id)) print(`--keep: ${id} is not a decidable candidate.`);
      return keep.filter((id) => known.has(id));
    }
    if (!process.stdin.isTTY) {
      print("Not a terminal: keeping every decidable candidate. Use --keep to choose.");
      return candidates.map((candidate) => candidate.id);
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const kept: string[] = [];
      for (const candidate of candidates) {
        print(formatCandidate(candidate));
        const answer = (await prompt.question(`Keep ${candidate.id}? [Y/n] `)).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") kept.push(candidate.id);
      }
      return kept;
    } finally {
      prompt.close();
    }
  };
}
