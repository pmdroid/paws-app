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

const MOVE_ALL_PATH = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/sessions\/move$/;

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
  /** Records the move of `runId` unless it already moves; null when it does. */
  function request(runId: string, runnerId: string, principal: WorkspacePrincipal, at: number) {
    const status = runnerSessionMove(db, runId, runnerId)?.status;
    if (status === "moving" || status === "waiting") return null;
    requestRunnerSessionMove(db, { runId, runnerId, userId: principal.userId, now: at });
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "runner.session.move",
      subject: runId,
      now: at,
    });
    return runId;
  }
  /** Runs the handover the route asked for; the route does not wait for the runner. */
  function start(runId: string, runnerId: string, itemId: string) {
    const settling = settle(runId, runnerId, itemId)
      .catch((error: unknown) => {
        journalCaught(error, "runner-control.sessionMove.settle", itemId);
      })
      .finally(() => pending.delete(settling));
    pending.add(settling);
  }
  /** The admin check every move route shares; a refusal is audited. */
  function admin(principal: WorkspacePrincipal, subject: string, at: number): boolean {
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    if (member?.active && isWorkspaceAdmin(member.role)) return true;
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "access.denied",
      subject,
      now: at,
    });
    return false;
  }
  /** Sessions on `runnerId` the runner can hand over now: a live work lease on an active run. */
  function liveSessions(runnerId: string, workspaceId: string, at: number, runId?: string) {
    return db
      .query<
        { runId: string; itemId: string },
        [string, string, number, string | null, string | null]
      >(
        `SELECT w.run_id AS runId,r.item_id AS itemId FROM runner_work w JOIN run r ON r.id=w.run_id
         WHERE w.runner_id=? AND w.workspace_id=? AND w.ended_at IS NULL AND w.lease_until>?
         AND r.status IN ('active','provisioning') AND (? IS NULL OR w.run_id=?)
         ORDER BY r.created_at,w.run_id`,
      )
      .all(runnerId, workspaceId, at, runId ?? null, runId ?? null);
  }
  /** `POST /api/runners/:runnerId/sessions/move`: Move running work off a draining runner. */
  function moveAll(runnerId: string, principal: WorkspacePrincipal): Response {
    const at = now();
    const decision = immediate(db, () => {
      if (!admin(principal, `runner_drain_move:${runnerId}`, at)) return "denied" as const;
      const runner = db
        .query<{ status: string }, [string, string]>(
          "SELECT status FROM runner WHERE id=? AND workspace_id=?",
        )
        .get(runnerId, principal.workspaceId);
      if (runner?.status !== "draining") return "not_draining" as const;
      // One move per session, as Move to another runner asks it.
      return liveSessions(runnerId, principal.workspaceId, at).filter(
        (session) => request(session.runId, runnerId, principal, at) !== null,
      );
    });
    if (decision === "denied")
      return json({ error: "Only workspace owners and admins can move running work." }, 403);
    if (decision === "not_draining")
      return json({ error: "Drain this runner before moving all of its running work." }, 409);
    for (const session of decision) start(session.runId, runnerId, session.itemId);
    return json({ ok: true, moving: decision.length }, 202);
  }
  return {
    async fetch(httpRequest: Request, principal: WorkspacePrincipal): Promise<Response | null> {
      const path = new URL(httpRequest.url).pathname;
      const all = MOVE_ALL_PATH.exec(path);
      const match = all ? null : MOVE_PATH.exec(path);
      if (!all && !match) return null;
      if (httpRequest.method !== "POST") return json({ error: "Use POST." }, 405);
      if (all) return moveAll(all[1]!, principal);
      const [, runnerId, runId] = match as unknown as [string, string, string];
      const at = now();
      const decision = immediate(db, () => {
        if (!admin(principal, `runner_session_move:${runId}`, at)) return "denied" as const;
        const [session] = liveSessions(runnerId, principal.workspaceId, at, runId);
        if (!session) return "gone" as const;
        if (request(runId, runnerId, principal, at) === null) return "moving" as const;
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
      start(runId, runnerId, decision.itemId);
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
