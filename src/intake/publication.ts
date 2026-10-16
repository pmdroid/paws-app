import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { canAdvanceItem, hasPendingEpicChanges } from "./dependencies";
import type { createEpicReconciler } from "./reconciliation";

export type PublicationPhase = "publish" | "merge";
export type PublicationCandidate = { sha: string; baseSha: string };

type Identity = {
  epicId: string;
  workspaceId: string;
  checkpoint: string | null;
  runId: string;
  agent: string;
  runKind: string;
  runStatus: string;
  specificationHash: string;
  specificationRevision: number;
  sessionId: string;
  sessionGeneration: number;
  organizationId: string;
  teamId: string;
  clientId: string;
  appUserId: string;
  creatorId: string | null;
  actorId: string | null;
};

export function createPublicationReadiness(input: {
  db: Database;
  reconciler: Pick<ReturnType<typeof createEpicReconciler>, "reconcile">;
  canAdvance?: (itemId: string) => boolean;
  now?: () => number;
}) {
  const { db, reconciler } = input;
  const now = input.now ?? Date.now;
  const ready = new Map<string, { binding: string; phase: PublicationPhase }>();

  function current(itemId: string, candidate?: PublicationCandidate) {
    return db
      .transaction(() => {
        const identity = db
          .query<Identity, [string]>(
            `SELECT i.epic_id AS epicId,w.id AS workspaceId,i.checkpoint,
         r.id AS runId,r.agent,r.kind AS runKind,r.status AS runStatus,
         p.hash AS specificationHash,p.revision AS specificationRevision,
         s.session_id AS sessionId,s.generation AS sessionGeneration,
         s.organization_id AS organizationId,s.team_id AS teamId,s.oauth_client_id AS clientId,
         s.app_user_id AS appUserId,s.creator_id AS creatorId,
         COALESCE((SELECT u.linear_user_id FROM workspace_user u WHERE u.id=i.owner_user_id), i.delegated_by, s.creator_id) AS actorId
         FROM work_item i JOIN work_item_specification p ON p.item_id=i.id AND p.present=1
         JOIN run r ON r.id=i.current_run_id AND r.item_id=i.id
         JOIN epic e ON e.id=i.epic_id AND e.state IN ('running','stalled')
         JOIN linear_session s ON s.session_id=i.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id
         WHERE i.id=? AND i.state IN ('verifying','merge_queue') AND i.cancel_requested=0
         AND s.stopped_at IS NULL AND s.team_id IS NOT NULL
         AND s.app_user_id IS NOT NULL AND s.oauth_client_id IS NOT NULL`,
          )
          .get(itemId);
        if (!identity) return null;
        const jobs = db
          .query<{ id: number; attempts: number; worker: string }, [string, string, number]>(
            `SELECT id,attempts,locked_by AS worker FROM job WHERE queue=? AND status='running'
         AND json_extract(payload,'$.itemId')=? AND locked_by IS NOT NULL AND locked_until>?`,
          )
          .all(JOB_KIND.merge, itemId, now());
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
        const generation =
          db
            .query<{ generation: number }, [string]>(
              "SELECT generation FROM epic_dependency_snapshot WHERE epic_id=?",
            )
            .get(identity.epicId)?.generation ?? 0;
        return {
          identity,
          binding: JSON.stringify([itemId, identity, jobs[0], actual]),
          generation,
        };
      })
      .deferred();
  }

  async function publicationReady(
    itemId: string,
    phase: PublicationPhase,
    signal?: AbortSignal,
    candidate?: PublicationCandidate,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const before = current(itemId, candidate);
    if (!before) {
      ready.delete(itemId);
      return false;
    }
    const saved = ready.get(itemId);
    const key = JSON.stringify([before.binding, before.generation]);
    if (
      saved?.binding === key &&
      (saved.phase === phase || saved.phase === "merge") &&
      !hasPendingEpicChanges(db, before.identity.epicId) &&
      canAdvanceItem(db, {
        epicId: before.identity.epicId,
        workspaceId: before.identity.workspaceId,
        itemId,
      }) &&
      input.canAdvance?.(itemId) !== false
    )
      return true;
    ready.delete(itemId);
    try {
      await reconciler.reconcile({
        epicId: before.identity.epicId,
        workspaceId: before.identity.workspaceId,
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      return false;
    }
    signal?.throwIfAborted();
    const after = current(itemId, candidate);
    if (
      !after ||
      after.binding !== before.binding ||
      hasPendingEpicChanges(db, after.identity.epicId) ||
      !canAdvanceItem(db, {
        epicId: after.identity.epicId,
        workspaceId: after.identity.workspaceId,
        itemId,
      }) ||
      input.canAdvance?.(itemId) === false
    )
      return false;
    ready.set(itemId, { binding: JSON.stringify([after.binding, after.generation]), phase });
    return true;
  }

  return { publicationReady };
}
