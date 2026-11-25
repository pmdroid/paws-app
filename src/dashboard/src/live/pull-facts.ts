import { join } from "node:path";
import {
  getItemBranchStateSteps,
  getPublishedHeadSteps,
  getPullRequestTextSteps,
  listCiRoundsSteps,
  listConfirmedRemoteMergesSteps,
  listItemPullRequestsSteps,
  listWorkItemRepositoriesSteps,
  type CiRound,
  type Db,
  type WorkItemRecord,
} from "../../../db";
import type { PullState, StatusPullCi, StatusPullRequest, StatusPullSize } from "../contract";

export type PullFacts = Omit<StatusPullRequest, "number" | "url"> & {
  number?: number;
  url?: string;
};

const sizes = new Map<string, StatusPullSize>();

export async function pullFactsFor(
  store: Db,
  records: readonly WorkItemRecord[],
  pawsHome: string | undefined,
): Promise<Map<string, PullFacts>> {
  if (records.length === 0) return new Map();
  const ids = records.map((record) => record.id);
  const reads = await store.run(function* (q) {
    const each = [];
    for (const id of ids)
      each.push({
        id,
        title: (yield* getPullRequestTextSteps(q, id))?.title ?? null,
        head: yield* getPublishedHeadSteps(q, id),
        branch: yield* getItemBranchStateSteps(q, id),
        rounds: yield* listCiRoundsSteps(q, id),
      });
    return {
      each,
      pulls: new Map((yield* listItemPullRequestsSteps(q, ids)).map((row) => [row.itemId, row])),
      merges: yield* listConfirmedRemoteMergesSteps(q, ids),
      repositories: yield* listWorkItemRepositoriesSteps(q, ids),
    };
  });
  const facts = new Map<string, PullFacts>();
  for (const [index, record] of records.entries()) {
    const { id, title, head, branch, rounds } = reads.each[index]!;
    const pull = reads.pulls.get(id);
    const merge = reads.merges.get(id);
    const repository = reads.repositories.get(id);
    const tip = head ?? branch?.head ?? null;
    const mirror =
      pawsHome && repository ? mirrorOf(pawsHome, repository.owner, repository.repo) : null;
    const size = mirror && branch && tip ? await diffSize(mirror, branch.base, tip) : null;
    const ci = head ? ciOf(rounds.findLast((round) => round.head === head)) : null;
    const url = pull?.pullUrl ?? merge?.pullUrl ?? null;
    facts.set(id, {
      ...(url ? { number: pull?.pullNumber ?? merge!.pullNumber, url } : {}),
      ...(title?.trim() ? { title: title.trim() } : {}),
      state: pullState(record, merge !== undefined),
      ...(pull ? { openedAt: new Date(pull.openedAt).toISOString() } : {}),
      ...(head ? { head } : {}),
      ...(merge?.mergeSha ? { mergeSha: merge.mergeSha } : {}),
      ...(merge ? { mergedAt: new Date(merge.confirmedAt).toISOString() } : {}),
      ...(ci ? { ci } : {}),
      ...(size ? { size } : {}),
    });
  }
  return facts;
}

export function pullState(record: WorkItemRecord, merged: boolean): PullState {
  if (merged || record.state === "merged") return "merged";
  return record.state === "cancelled" || record.state === "failed" ? "closed" : "open";
}

export function withPullFacts(
  pr: StatusPullRequest | null,
  facts: PullFacts | undefined,
): StatusPullRequest | null {
  if (facts === undefined) return pr;
  const { number, url, ...rest } = facts;
  const base = pr ?? (number !== undefined && url !== undefined ? { number, url } : null);
  return base === null ? null : { ...base, ...rest };
}

function ciOf(round: CiRound | undefined): StatusPullCi | null {
  if (round === undefined || round.checks.length === 0) return null;
  const failed = round.checks
    .filter((check) => check.state === "failed")
    .map((check) => check.name);
  const state = failed.length
    ? "failed"
    : round.checks.some((check) => check.state === "running")
      ? "pending"
      : "passed";
  return { state, failed, at: new Date(round.recordedAt).toISOString() };
}

function mirrorOf(root: string, owner: string, repo: string): string | null {
  const safe = (part: string) => /^[A-Za-z0-9._-]+$/.test(part) && !/^\.+$/.test(part);
  return safe(owner) && safe(repo) ? join(root, "repos", owner, `${repo}.git`) : null;
}

async function diffSize(
  mirror: string,
  base: string,
  head: string,
): Promise<StatusPullSize | null> {
  const commit = /^[0-9a-f]{7,64}$/i;
  if (!commit.test(base) || !commit.test(head)) return null;
  const key = `${mirror}\0${base}\0${head}`;
  const cached = sizes.get(key);
  if (cached) return cached;
  let output: string;
  try {
    const child = Bun.spawn(["git", "-C", mirror, "diff", "--numstat", `${base}...${head}`], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return null;
  } catch {
    return null;
  }
  const size = { files: 0, additions: 0, deletions: 0 };
  for (const line of output.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (added === undefined || deleted === undefined) continue;
    size.files += 1;
    size.additions += Number(added) || 0;
    size.deletions += Number(deleted) || 0;
  }
  if (sizes.size >= 500) sizes.delete(sizes.keys().next().value!);
  sizes.set(key, size);
  return size;
}
