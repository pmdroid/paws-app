import type { Database } from "bun:sqlite";
import { commentingApps } from "../db";
import type { HeadCheckRun } from "../github";

export type ReviewChecks = { head: string; pending: string[]; until: number };

export async function readReviewChecks(
  db: Database,
  input: {
    owner: string;
    repo: string;
    head: string;
    configured: readonly string[];
    maxMs: number;
    since: number;
    checkRuns(head: string): Promise<HeadCheckRun[] | null>;
  },
): Promise<ReviewChecks | null> {
  const apps = new Set([
    ...commentingApps(db, input.owner, input.repo),
    ...input.configured.map((slug) => slug.toLowerCase()),
  ]);
  if (apps.size === 0) return { head: input.head, pending: [], until: input.since };
  const runs = await input.checkRuns(input.head);
  if (runs === null) return null;
  const starts = runs
    .map((run) => (run.startedAt === null ? Number.NaN : Date.parse(run.startedAt)))
    .filter((start) => Number.isFinite(start));
  const pushed = starts.length > 0 ? Math.min(...starts) : input.since;
  const pending = runs
    .filter(
      (run) => run.status !== "completed" && run.app !== null && apps.has(run.app.toLowerCase()),
    )
    .map((run) => run.name);
  return { head: input.head, pending: [...new Set(pending)].sort(), until: pushed + input.maxMs };
}
