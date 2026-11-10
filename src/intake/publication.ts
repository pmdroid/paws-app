import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  dependencySnapshotGenerationSteps,
  leasedJobsForItemSteps,
  readPublicationIdentitySteps,
  sqliteDb,
} from "../db";
import type { createItemReconciler } from "./reconciliation";

export type PublicationPhase = "publish" | "merge";
export type PublicationCandidate = { sha: string; baseSha: string };

export function createPublicationReadiness(input: {
  db: Database;
  reconciler: Pick<ReturnType<typeof createItemReconciler>, "reconcile">;
  canMerge: (itemId: string) => Promise<boolean>;
  now?: () => number;
}) {
  const { reconciler } = input;
  const store = sqliteDb(input.db);
  const now = input.now ?? Date.now;
  const ready = new Map<string, { binding: string; phase: PublicationPhase }>();

  function current(itemId: string, candidate?: PublicationCandidate) {
    return store.run((q) =>
      q.transaction(function* (tx) {
        const identity = yield* readPublicationIdentitySteps(tx, itemId);
        if (!identity) return null;
        const jobs = yield* leasedJobsForItemSteps(tx, JOB_KIND.merge, itemId, now());
        if (jobs.length !== 1) return null;
        const checkpoint = identity.checkpoint === null ? null : JSON.parse(identity.checkpoint);
        const actual = candidate ?? { sha: checkpoint?.wipCommit, baseSha: checkpoint?.baseSha };
        if (
          typeof actual.sha !== "string" ||
          !actual.sha ||
          typeof actual.baseSha !== "string" ||
          !actual.baseSha
        )
          return null;
        const generation = (yield* dependencySnapshotGenerationSteps(tx, itemId)) ?? 0;
        return {
          identity,
          binding: JSON.stringify([itemId, identity, jobs[0], actual]),
          generation,
        };
      }),
    );
  }

  async function publicationReady(
    itemId: string,
    phase: PublicationPhase,
    signal?: AbortSignal,
    candidate?: PublicationCandidate,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const before = await current(itemId, candidate);
    if (!before) {
      ready.delete(itemId);
      return false;
    }
    const saved = ready.get(itemId);
    const key = JSON.stringify([before.binding, before.generation]);
    if (
      saved?.binding === key &&
      (saved.phase === phase || saved.phase === "merge") &&
      (await input.canMerge(itemId))
    )
      return true;
    ready.delete(itemId);
    try {
      await reconciler.reconcile({
        itemId,
        workspaceId: before.identity.workspaceId,
        signal,
      });
    } catch (caughtError1) {
      signal?.throwIfAborted();
      journalCaught(caughtError1, "publication.publicationReady.reconcile", itemId);
      return false;
    }
    signal?.throwIfAborted();
    const after = await current(itemId, candidate);
    if (!after || after.binding !== before.binding || !(await input.canMerge(itemId))) return false;
    ready.set(itemId, { binding: JSON.stringify([after.binding, after.generation]), phase });
    return true;
  }

  return { publicationReady };
}
