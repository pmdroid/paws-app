import type { Database } from "bun:sqlite";
import type { TaskMode } from "../core";
import { randomUUID } from "node:crypto";
import { enqueueOutboxOnce, immediate, listOutbox } from "../db";
import type { SessionPlanStep, SessionUpdate } from "../linear";

type Phase =
  | "working"
  | "implementing"
  | "fixing"
  | "verifying"
  | "publishing"
  | "merging"
  | "completed";

/** At most one plan and one summary per session go to Linear in this window. */
const METADATA_INTERVAL_MS = 120_000;

const HOST_STEPS = ["Verify changes", "Open pull request", "Merge verified changes"];

export function createLinearSessionProgress(
  db: Database,
  sessionId: string,
  identifier: string,
  now: () => number = Date.now,
  mode: TaskMode = "code",
) {
  const generation =
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM outbox_session_fence WHERE target = 'linear' AND ordering_key = ?",
      )
      .get(sessionId)?.generation ?? 0;
  const hostSteps = mode === "code" ? HOST_STEPS : [];
  const previous = listOutbox(db, sessionId).findLast(
    (row) =>
      row.op === "linear.session.plan" &&
      row.generation === generation &&
      row.status !== "dropped" &&
      (row.payload as { identifier?: string }).identifier === identifier &&
      ((row.payload as { mode?: TaskMode }).mode ?? "code") === mode,
  );
  let steps: readonly SessionPlanStep[] = previous
    ? ((previous.payload as SessionUpdate).plan ?? []).slice(
        0,
        hostSteps.length ? -hostSteps.length : undefined,
      )
    : [];
  let phase: Phase = mode === "code" ? "implementing" : "working";

  // Plan and summary are latest-wins: a pending row takes the new payload, and a new row
  // waits until METADATA_INTERVAL_MS after the last one went out. A final update is due now.
  function publish(op: string, update: SessionUpdate, final = false) {
    immediate(db, () => {
      const at = now();
      const payload = JSON.stringify({ ...update, identifier, mode });
      const pending = db
        .query<{ id: number }, [string, number, string, number]>(
          `SELECT id FROM outbox WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ?
            AND op = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until <= ?)
          ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId, generation, op, at);
      const delivered = db
        .query<{ payload: string }, [string, number, string, number]>(
          `SELECT payload FROM outbox WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ?
            AND op = ? AND (status = 'sent' OR (status = 'pending' AND locked_until > ?))
          ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId, generation, op, at)?.payload;
      if (delivered === payload) {
        if (pending)
          db.run(
            `UPDATE outbox SET status = 'dropped', error = 'Matches the session metadata already sent.'
            WHERE id = ?`,
            [pending.id],
          );
        return;
      }
      if (pending) {
        db.run(
          `UPDATE outbox SET payload = ?, not_before = CASE WHEN ? THEN 0 ELSE not_before END
          WHERE id = ?`,
          [payload, final ? 1 : 0, pending.id],
        );
        return;
      }
      const last = db
        .query<{ at: number | null }, [number, string, number, string, number]>(
          `SELECT MAX(CASE WHEN status = 'sent' THEN sent_at ELSE ? END) AS at FROM outbox
          WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ? AND op = ?
            AND (status = 'sent' OR (status = 'pending' AND locked_until > ?))`,
        )
        .get(at, sessionId, generation, op, at)?.at;
      const id = enqueueOutboxOnce(db, {
        target: "linear",
        op,
        orderingKey: sessionId,
        priority: 6,
        generation,
        idempotencyKey: `${op}:${sessionId}:${randomUUID()}`,
        payload: { ...update, identifier, mode },
        notBefore: final || last == null ? 0 : last + METADATA_INTERVAL_MS,
        now: at,
      });
      db.run(
        `UPDATE outbox SET status = 'dropped', error = 'Superseded by a newer session metadata version.'
        WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ? AND op = ? AND id < ?
          AND status = 'dead'`,
        [sessionId, generation, op, id],
      );
    });
  }

  function publishPlan() {
    const phaseIndex =
      phase === "fixing"
        ? 1
        : ["implementing", "verifying", "publishing", "merging", "completed"].indexOf(phase);
    const agentSteps =
      phase === "implementing" || phase === "working" || phase === "fixing"
        ? steps
        : steps.map((step) => ({
            ...step,
            status: step.status === "canceled" ? ("canceled" as const) : ("completed" as const),
          }));
    const milestones = hostSteps.map((content, index): SessionPlanStep => ({
      content,
      status:
        phaseIndex > index + 1 ? "completed" : phaseIndex === index + 1 ? "inProgress" : "pending",
    }));
    publish(
      "linear.session.plan",
      { sessionId, plan: [...agentSteps, ...milestones] },
      phase === "completed",
    );
  }

  return {
    plan(plan: readonly SessionPlanStep[]) {
      steps = plan;
      publishPlan();
    },
    phase(next: Phase) {
      phase = next;
      publishPlan();
      const status =
        next === "working"
          ? mode === "answer"
            ? "preparing answer"
            : "creating files"
          : next === "fixing"
            ? "fixing Closeout findings"
            : next;
      const summary = `${identifier}: ${status}`.slice(0, 255);
      publish("linear.session.summary", { sessionId, summary }, next === "completed");
    },
    status(text: string) {
      publish("linear.session.summary", { sessionId, summary: text.slice(0, 255) }, true);
    },
    link(label: string, url: string) {
      // Links are not throttled, so they sort ahead of a plan or summary that is still waiting.
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "linear.session.links",
        orderingKey: sessionId,
        priority: 5,
        generation,
        idempotencyKey: `linear.session.links:${sessionId}:${randomUUID()}`,
        payload: { sessionId, addedExternalUrls: [{ label, url }], identifier, mode },
        now: now(),
      });
    },
  };
}
