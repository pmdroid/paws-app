import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  clearRunnerSessionMove,
  immediate,
  noteRunnerSessionMove,
  requestRunnerSessionMove,
  runnerSessionMove,
  workspaceMember,
} from "../db";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";

/** What the runner backend's `handOverItem` answers, as far as the runner card tells it. */
export type SessionHandoverOutcome =
  | { status: "handed_over" | "finished" | "timed_out" | "unanswered" | "old_runner" }
  | { status: "not_running" }
  | { status: "failed"; reason: "commit" | "snapshot" | "publication" };

const MOVE_PATH =
  /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/sessions\/([A-Za-z0-9_-]{1,64})\/move$/;

const STAYED = {
  timed_out:
    "The runner found no safe point to stop within 2 minutes, so the session keeps running here.",
  unanswered: "The runner did not answer in time, so the session keeps running here.",
  old_runner: "This runner's release cannot hand sessions over. Update the runner to move it.",
  not_running: "The session was no longer running here, so there was nothing to move.",
} as const;
const FAILED_STEP = {
  commit: "commit its work in progress",
  snapshot: "save the agent's session",
  publication: "publish its work in progress and session",
} as const;

/**
 * `POST /api/runners/:runnerId/sessions/:runId/move`: an owner or admin asks the runner to hand
 * one running session over. Paws then resumes it on another eligible runner, and the runner card
 * shows the move from `runner_session_move`. The server checks the session, CSRF and origin.
 */
export function createRunnerSessionMoves(options: {
  db: Database;
  handOver(itemId: string, signal?: AbortSignal): Promise<SessionHandoverOutcome>;
  now?: () => number;
  /** Aborted at shutdown: Paws stops waiting for the runner's answer. */
  signal?: AbortSignal;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  /** Settles once the runner answered; the route does not wait for it. */
  const pending = new Set<Promise<void>>();
  async function settle(runId: string, runnerId: string, itemId: string) {
    let outcome: SessionHandoverOutcome;
    try {
      outcome = await options.handOver(itemId, options.signal);
    } catch (error) {
      journalCaught(error, "runner-control.sessionMove.handOver", itemId);
      if (options.signal?.aborted) return;
      outcome = { status: "unanswered" };
    }
    // A handed-over run is moving until it lands; the backend says while it waits why.
    if (outcome.status === "handed_over") return;
    const reason =
      outcome.status === "finished"
        ? null
        : outcome.status === "failed"
          ? `The runner stopped the agent but could not ${FAILED_STEP[outcome.reason]}, so it keeps running here.`
          : STAYED[outcome.status];
    immediate(db, () => {
      if (runnerSessionMove(db, runId, runnerId)?.status !== "moving") return;
      if (reason === null) clearRunnerSessionMove(db, runId, runnerId);
      else noteRunnerSessionMove(db, { runId, runnerId, status: "stayed", reason, now: now() });
    });
  }
  return {
    async fetch(request: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const match = MOVE_PATH.exec(new URL(request.url).pathname);
      if (!match) return null;
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      const [, runnerId, runId] = match as unknown as [string, string, string];
      const at = now();
      const decision = immediate(db, () => {
        const member = workspaceMember(db, principal.workspaceId, principal.userId);
        if (!member?.active || !isWorkspaceAdmin(member.role)) {
          auditWorkspaceAccess(db, {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            action: "access.denied",
            subject: `runner_session_move:${runId}`,
            now: at,
          });
          return "denied" as const;
        }
        const session = db
          .query<{ itemId: string }, [string, string, string, number]>(
            `SELECT r.item_id AS itemId FROM runner_work w JOIN run r ON r.id=w.run_id
             WHERE w.run_id=? AND w.runner_id=? AND w.workspace_id=?
             AND w.ended_at IS NULL AND w.lease_until>? AND r.status IN ('active','provisioning')`,
          )
          .get(runId, runnerId, principal.workspaceId, at);
        if (!session) return "gone" as const;
        const status = runnerSessionMove(db, runId, runnerId)?.status;
        if (status === "moving" || status === "waiting") return "moving" as const;
        requestRunnerSessionMove(db, { runId, runnerId, userId: principal.userId, now: at });
        auditWorkspaceAccess(db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.session.move",
          subject: runId,
          now: at,
        });
        return session;
      });
      if (decision === "denied")
        return json({ error: "Only workspace owners and admins can move running work." }, 403);
      if (decision === "gone")
        return json(
          {
            error:
              "This session is not running on this runner now. Sessions in Closeout move once they run again.",
          },
          409,
        );
      if (decision === "moving") return json({ ok: true, moving: true }, 202);
      const settling = settle(runId, runnerId, decision.itemId)
        .catch((error: unknown) => {
          journalCaught(error, "runner-control.sessionMove.settle", decision.itemId);
        })
        .finally(() => pending.delete(settling));
      pending.add(settling);
      return json({ ok: true, moving: true }, 202);
    },
    /** Waits for every handover the route started, as tests and shutdown do. */
    async settled() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
