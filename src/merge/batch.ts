import { journal } from "../journal";
import {
  latestCandidatePathsSteps,
  listMergeQueuesSteps,
  updateSettingSteps,
  type Db,
  type MergeQueuePosition,
  type Q,
  type Steps,
} from "../db";
import type { MainCi } from "../github";
import type { MergeContext } from "./orders";

export const MERGE_BATCH_WINDOW_MS = 10 * 60 * 1000;

type Lane = { repository: string; lane: string };
type LaneBatch = { merges: { pull: number; at: number }[]; slowed?: true };

function batchKey({ repository, lane }: Lane): string {
  return `merge.batch:${JSON.stringify([repository.toLowerCase(), lane])}`;
}

function readBatch(stored: string | null): LaneBatch {
  return stored === null ? { merges: [] } : (JSON.parse(stored) as LaneBatch);
}

function laneName({ repository, lane }: Lane): string {
  return lane === "" ? repository : `${repository} (${lane})`;
}

export async function recordLaneMerge(
  store: Db,
  lane: Lane,
  pull: number,
  now: number,
): Promise<void> {
  await store.transaction((q) =>
    updateSettingSteps(
      q,
      batchKey(lane),
      (stored) => {
        const batch = readBatch(stored);
        const last = batch.merges.at(-1);
        const merge = { pull, at: now };
        const merges =
          last && now - last.at <= MERGE_BATCH_WINDOW_MS ? [...batch.merges, merge] : [merge];
        return JSON.stringify({ ...batch, merges });
      },
      now,
    ),
  );
}

async function laneSlowed(store: Db, lane: Lane, main: MainCi | undefined, now: number) {
  const seen = { slowed: false, broke: [] as number[], recovered: false };
  await store.transaction((q) =>
    updateSettingSteps(
      q,
      batchKey(lane),
      (stored) => {
        const batch = readBatch(stored);
        if (batch.slowed && main !== "green") {
          seen.slowed = true;
          return JSON.stringify(batch);
        }
        if (main === "failed" && batch.merges.length >= 2) {
          seen.slowed = true;
          seen.broke = batch.merges.map((merge) => merge.pull);
          return JSON.stringify({ merges: [], slowed: true });
        }
        seen.recovered = batch.slowed === true;
        return JSON.stringify(main === "green" ? { merges: [] } : batch);
      },
      now,
    ),
  );
  if (seen.broke.length)
    journal(
      `Main's CI failed after the ${laneName(lane)} merge lane merged ${seen.broke.map((pull) => `#${pull}`).join(", ")} together; the lane merges one at a time until main is green.`,
    );
  if (seen.recovered)
    journal(`Main's CI is green again; the ${laneName(lane)} merge lane merges in parallel.`);
  return seen.slowed;
}

export async function mergesAlongside(
  { store, item, caps }: MergeContext,
  place: MergeQueuePosition,
  pull: { number: number; head: string },
  held: (q: Q, itemId: string) => Steps<boolean>,
): Promise<boolean> {
  const parallel = caps.mergeParallel?.() ?? 1;
  if (parallel <= 1) return false;
  const apart = await store.run(function* (q) {
    const ahead = (yield* listMergeQueuesSteps(q, held)).filter(
      (entry) =>
        entry.repository === place.repository &&
        entry.lane === place.lane &&
        entry.position < place.position &&
        !entry.busy,
    );
    if (ahead.length >= parallel) return false;
    const paths = yield* latestCandidatePathsSteps(q);
    const mine = paths.get(item.id);
    if (mine === undefined) return false;
    return ahead.every((entry) => {
      const theirs = paths.get(entry.itemId);
      return theirs !== undefined && !theirs.some((path) => mine.includes(path));
    });
  });
  if (!apart) return false;
  const ci = await caps.readPullCi(item, pull);
  if (ci.state !== "green") return false;
  return !(await laneSlowed(store, place, ci.main, caps.now()));
}
