import { commentingAppsSteps, type Db, type ReviewCheckWait, type WorkItemRecord } from "../db";
import type { HeadChecks } from "../github";
import type { PullReviewCapabilities } from "./pull-reviews";

export type ReviewChecks = { head: string | null; pending: string[] | null; until: number };

export async function readReviewChecks(
  store: Db,
  input: {
    owner: string;
    repo: string;
    head: string;
    configured: readonly string[];
    maxMs: number;
    since: number;
    checkRuns(head: string): Promise<HeadChecks | null>;
  },
): Promise<ReviewChecks> {
  const apps = new Set([
    ...(await store.run((q) => commentingAppsSteps(q, input.owner, input.repo))),
    ...input.configured.map((slug) => slug.toLowerCase()),
  ]);
  const fallback = input.since + input.maxMs;
  if (apps.size === 0) return { head: input.head, pending: [], until: fallback };
  const checks = await input.checkRuns(input.head);
  if (checks === null) return { head: input.head, pending: null, until: fallback };
  const pending = checks.runs
    .filter(
      (run) => run.status !== "completed" && run.app !== null && apps.has(run.app.toLowerCase()),
    )
    .map((run) => run.name);
  const until = checks.pushedAt === null ? fallback : checks.pushedAt + input.maxMs;
  return { head: input.head, pending: [...new Set(pending)].sort(), until };
}

export async function holdForReviewChecks(
  item: WorkItemRecord,
  pullNumber: number,
  since: number,
  caps: PullReviewCapabilities,
): Promise<boolean> {
  if (!caps.reviewChecks) return false;
  const checks = await caps.reviewChecks(item, pullNumber, since);
  if (checks === null) return false;
  const open = caps.now() < checks.until;
  if (checks.pending === null) return open;
  const waiting = open && checks.pending.length > 0 && checks.head !== null;
  caps.noteReviewWait?.(waiting ? { head: checks.head!, names: checks.pending } : null);
  return waiting;
}

export function withReviewWait<T extends { payload: unknown }>(
  job: T,
  wait: ReviewCheckWait | null | undefined,
): T {
  if (wait === undefined) return job;
  const { reviewChecks: _old, ...payload } = (job.payload ?? {}) as Record<string, unknown>;
  return { ...job, payload: wait === null ? payload : { ...payload, reviewChecks: wait } };
}
