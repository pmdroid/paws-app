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
    : [
        {
          content: `${mode === "code" ? "Implement" : mode === "answer" ? "Answer" : "Create files for"} ${identifier}`,
          status: "inProgress" as const,
        },
      ];
  let phase: Phase = mode === "code" ? "implementing" : "working";

  function enqueue(op: string, update: SessionUpdate, replace = false) {
    immediate(db, () => {
      const id = enqueueOutboxOnce(db, {
        target: "linear",
        op,
        orderingKey: sessionId,
        priority: 6,
        generation,
        idempotencyKey: `${op}:${sessionId}:${randomUUID()}`,
        payload: { ...update, identifier, mode },
        now: now(),
      });
      if (!replace) return;
      db.run(
        `UPDATE outbox SET status = 'dropped', error = 'Superseded by a newer session metadata version.'
        WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ? AND op = ? AND id < ?
          AND status IN ('pending', 'dead')`,
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
    enqueue("linear.session.plan", { sessionId, plan: [...agentSteps, ...milestones] }, true);
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
      enqueue("linear.session.summary", { sessionId, summary }, true);
    },
    link(label: string, url: string) {
      enqueue("linear.session.links", { sessionId, addedExternalUrls: [{ label, url }] });
    },
  };
}
