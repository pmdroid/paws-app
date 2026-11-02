import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getWorkItemRepository,
  listCloseoutProgress,
  reviewFindingIssues,
  reviewFindingKey,
  type CloseoutProgressRecord,
  type CloseoutStepRecord,
} from "../../../db";
import { redactCloseoutText } from "../server/artifact";
import {
  REVIEW_SEVERITIES,
  type ReviewSeverity,
  type StatusReview,
  type StatusReviewFinding,
  type StatusReviewRound,
} from "../contract";

/** A review record larger than this is not read. Closeout caps a record at 200 findings. */
const RECORD_LIMIT_BYTES = 4 * 1024 * 1024;

type StoredFinding = Pick<
  StatusReviewFinding,
  "severity" | "location" | "explanation" | "evidence"
>;

type StoredReview = {
  path: string;
  itemId: string;
  base: string;
  head: string;
  attempt: number;
  findings: StoredFinding[];
  writtenAt: number;
};

/**
 * Each review item's rounds for one issue, read from the review records Closeout stored under
 * `<pawsHome>/closeout/evidence/<task>/evidence/`. The review steps of `progress` say which
 * findings were pre-existing and the item's `failOn`; a record without its step has neither.
 */
export function reviewsOf(
  progress: readonly CloseoutProgressRecord[],
  pawsHome: string,
  env: NodeJS.ProcessEnv,
): StatusReview[] {
  const steps = new Map<string, CloseoutStepRecord>();
  const failOn = new Map<string, ReviewSeverity>();
  for (const row of [...progress].sort((left, right) => left.updatedAt - right.updatedAt)) {
    for (const step of row.steps) {
      if (step.kind !== "review") continue;
      if (step.evidencePath) steps.set(`${row.taskId}\n${step.evidencePath}`, step);
      if (step.failOn) failOn.set(step.id, step.failOn);
    }
  }
  const byItem = new Map<string, Array<{ stored: StoredReview; step?: CloseoutStepRecord }>>();
  for (const task of new Set(progress.map((row) => row.taskId))) {
    for (const stored of storedReviews(evidenceDir(pawsHome, task))) {
      const entries = byItem.get(stored.itemId) ?? [];
      entries.push({ stored, step: steps.get(`${task}\n${stored.path}`) });
      byItem.set(stored.itemId, entries);
    }
  }
  return [...byItem.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entries]) => {
      entries.sort(
        (left, right) =>
          left.stored.writtenAt - right.stored.writtenAt ||
          left.stored.attempt - right.stored.attempt,
      );
      const rounds: StatusReviewRound[] = [];
      for (const { stored, step } of entries) {
        const limit = step?.failOn ?? failOn.get(id) ?? null;
        const preExisting = new Set(step?.preExisting ?? []);
        const findings = stored.findings.map((finding, index) => {
          const old = preExisting.has(index);
          return {
            ...redacted(finding, env),
            preExisting: old,
            blocking: !old && limit !== null && meets(finding.severity, limit),
            since: null,
          };
        });
        rounds.push({
          attempt: stored.attempt,
          baseSha: stored.base,
          headSha: stored.head,
          failOn: limit,
          ...against(findings, rounds.at(-1)?.findings),
        });
      }
      return { id, rounds };
    });
}

/**
 * The reviews of work item `itemId`, each pre-existing finding with the Linear issue filed from
 * it on any item. Reads the database only; Linear is called when someone files an issue.
 */
export function itemReviews(
  db: Database,
  itemId: string,
  pawsHome: string,
  env: NodeJS.ProcessEnv,
  progress: readonly CloseoutProgressRecord[] = listCloseoutProgress(db),
): StatusReview[] {
  const reviews = reviewsOf(
    progress.filter((row) => row.itemId === itemId),
    pawsHome,
    env,
  );
  const bound = getWorkItemRepository(db, itemId);
  if (bound === null || reviews.length === 0) return reviews;
  const repository = `${bound.owner}/${bound.repo}`;
  const keyOf = (finding: StatusReviewFinding) =>
    finding.preExisting
      ? reviewFindingKey({ repository, location: finding.location, text: finding.explanation })
      : null;
  const all = reviews.flatMap((review) =>
    review.rounds.flatMap((round) => [...round.findings, ...round.fixed]),
  );
  const filed = reviewFindingIssues(
    db,
    all.map(keyOf).filter((key) => key !== null),
  );
  if (filed.size === 0) return reviews;
  const mark = (finding: StatusReviewFinding): StatusReviewFinding => {
    const key = keyOf(finding);
    const issue = key === null ? undefined : filed.get(key);
    return issue
      ? { ...finding, filed: { identifier: issue.identifier, url: issue.url } }
      : finding;
  };
  return reviews.map((review) => ({
    ...review,
    rounds: review.rounds.map((round) => ({
      ...round,
      findings: round.findings.map(mark),
      fixed: round.fixed.map(mark),
    })),
  }));
}

/**
 * `findings` marked new or still open against the previous round's, and the previous findings
 * none of them matches. A finding matches one at the same path, whatever its line, as Closeout
 * counts repeated review findings.
 */
function against(
  findings: StatusReviewFinding[],
  previous: readonly StatusReviewFinding[] | undefined,
): Pick<StatusReviewRound, "findings" | "fixed"> {
  if (previous === undefined) return { findings, fixed: [] };
  const left = new Map<string, StatusReviewFinding[]>();
  for (const finding of previous) {
    const key = findingKey(finding.location);
    left.set(key, [...(left.get(key) ?? []), finding]);
  }
  const marked = findings.map((finding): StatusReviewFinding => {
    const bucket = left.get(findingKey(finding.location));
    return { ...finding, since: bucket?.shift() === undefined ? "new" : "open" };
  });
  const fixed = [...left.values()]
    .flat()
    .map((finding) => ({ ...finding, blocking: false, since: null }));
  return { findings: marked, fixed };
}

/** The location without a trailing `:line` or `:line:column`. */
function findingKey(location: string): string {
  let key = location.trim();
  for (let index = 0; index < 2; index += 1) {
    const colon = key.lastIndexOf(":");
    if (colon <= 0 || !/^[0-9]+$/.test(key.slice(colon + 1))) break;
    key = key.slice(0, colon);
  }
  return key;
}

function meets(severity: ReviewSeverity, failOn: ReviewSeverity): boolean {
  return REVIEW_SEVERITIES.indexOf(severity) <= REVIEW_SEVERITIES.indexOf(failOn);
}

function redacted(finding: StoredFinding, env: NodeJS.ProcessEnv): StoredFinding {
  return {
    severity: finding.severity,
    location: redactCloseoutText(finding.location, env),
    explanation: redactCloseoutText(finding.explanation, env),
    evidence: redactCloseoutText(finding.evidence, env),
  };
}

/** The task's evidence directory, named as `src/closeout/run.ts` names it. */
function evidenceDir(pawsHome: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return join(pawsHome, "closeout", "evidence", safe);
}

/** Review records under `<dir>/evidence`, each with its path relative to `dir`. */
function storedReviews(dir: string): StoredReview[] {
  const found: StoredReview[] = [];
  const walk = (folder: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(folder, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 12) walk(file, depth + 1);
        continue;
      }
      if (!name.endsWith(".json") || !stat.isFile() || stat.size > RECORD_LIMIT_BYTES) continue;
      const stored = readReview(file, stat.mtimeMs);
      if (stored) found.push({ ...stored, path: relative(dir, file).split(sep).join("/") });
    }
  };
  walk(join(dir, "evidence"), 0);
  return found;
}

function readReview(file: string, writtenAt: number): Omit<StoredReview, "path"> | null {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(body) || body.recordType !== "review") return null;
  const { itemId, base, head, attempt, findings } = body;
  if (typeof itemId !== "string" || typeof base !== "string" || typeof head !== "string") {
    return null;
  }
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return null;
  if (!Array.isArray(findings)) return null;
  const read = findings.map(readFinding);
  if (read.some((finding) => finding === null)) return null;
  return { itemId, base, head, attempt, findings: read as StoredFinding[], writtenAt };
}

function readFinding(input: unknown): StoredFinding | null {
  if (!isRecord(input)) return null;
  const { severity, location, explanation, evidence } = input;
  if (!REVIEW_SEVERITIES.includes(severity as ReviewSeverity)) return null;
  if (typeof location !== "string" || typeof explanation !== "string") return null;
  if (typeof evidence !== "string") return null;
  return { severity: severity as ReviewSeverity, location, explanation, evidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
