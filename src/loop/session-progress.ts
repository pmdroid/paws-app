import { hasPublishedPullRequest } from "./activity-policy";
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
  itemId?: string,
) {
  const owner = itemId === undefined ? {} : { itemId };
  const generation =
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM outbox_session_fence WHERE target = 'linear' AND ordering_key = ?",
      )
      .get(sessionId)?.generation ?? 0;
  const hostSteps = mode === "code" ? HOST_STEPS : [];
  const latestPlan = () =>
    listOutbox(db, sessionId).findLast(
      (row) =>
        (row.payload as SessionUpdate).plan !== undefined &&
        row.generation === generation &&
        (row.status !== "dropped" || row.error?.startsWith("Sending with outbox")) &&
        (row.payload as { identifier?: string }).identifier === identifier &&
        ((row.payload as { mode?: TaskMode }).mode ?? "code") === mode,
    );
  const saved = latestPlan()?.payload as
    | (SessionUpdate & {
        agentSteps?: SessionPlanStep[];
        hostPlan?: SessionPlanStep[];
        phase?: Phase;
        restartVersion?: number;
        waits?: SessionPlanStep[];
      })
    | undefined;
  let steps: readonly SessionPlanStep[] =
    saved?.agentSteps ??
    (saved?.plan ?? []).slice(0, hostSteps.length ? -hostSteps.length : undefined);
  let milestones: SessionPlanStep[] =
    saved?.hostPlan ??
    saved?.plan?.slice(-hostSteps.length) ??
    hostSteps.map((content) => ({ content, status: "pending" as const }));
  if (!hostSteps.length) milestones = [];
  let phase: Phase = saved?.phase ?? (mode === "code" ? "implementing" : "working");
  let restartVersion = saved?.restartVersion;
  // Wait steps lead the plan. Each completes when the wait ends and never returns to pending.
  let waits: SessionPlanStep[] = saved?.waits ?? [];
  let started = false;
  const afterPr = () => hasPublishedPullRequest(db, sessionId, generation);

  function preserveHostProgress() {
    const latest = latestPlan()?.payload as typeof saved;
    if (latest?.waits)
      waits = latest.waits
        .map((step, index) => {
          const current = waits[index];
          return step.status === "completed" || !current || current.content !== step.content
            ? step
            : current;
        })
        .concat(waits.slice(latest.waits.length));
    if (!latest?.hostPlan) return;
    if (
      latest.restartVersion !== undefined &&
      (restartVersion === undefined || latest.restartVersion > restartVersion)
    )
      restartVersion = latest.restartVersion;
    milestones = latest.hostPlan
      .map((step, index) => {
        const current = milestones[index];
        return step.status === "completed" || !current || current.content !== step.content
          ? step
          : current;
      })
      .concat(milestones.slice(latest.hostPlan.length));
    if (afterPr() && ["working", "implementing", "fixing", "verifying"].includes(phase))
      phase = latest.phase ?? "merging";
  }

  // Plan and summary are latest-wins: a pending row takes the new payload, and a new row
  // waits until METADATA_INTERVAL_MS after the last one went out. A final update is due now.
  function publish(op: string, update: SessionUpdate, final = false) {
    immediate(db, () => {
      const at = now();
      const metadata =
        op === "linear.session.plan"
          ? { agentSteps: steps, hostPlan: milestones, phase, restartVersion, waits }
          : {};
      const payload = JSON.stringify({ ...update, ...metadata, identifier, mode, ...owner });
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
      const field = op === "linear.session.plan" ? "plan" : "summary";
      if (
        delivered !== undefined &&
        JSON.stringify((JSON.parse(delivered) as SessionUpdate)[field]) ===
          JSON.stringify(update[field])
      ) {
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
        .query<{ at: number | null }, [number, string, number, number]>(
          `SELECT MAX(CASE WHEN status = 'sent' THEN sent_at ELSE ? END) AS at FROM outbox
          WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ?
            AND op LIKE 'linear.session.%'
            AND (status = 'sent' OR (status = 'pending' AND locked_until > ?))`,
        )
        .get(at, sessionId, generation, at)?.at;
      const id = enqueueOutboxOnce(db, {
        target: "linear",
        op,
        orderingKey: sessionId,
        priority: 6,
        generation,
        idempotencyKey: `${op}:${sessionId}:${randomUUID()}`,
        payload: { ...update, ...metadata, identifier, mode, ...owner },
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

  function endWaits() {
    waits = waits.map((step) =>
      step.status === "inProgress" ? { ...step, status: "completed" } : step,
    );
  }

  function publishPlan() {
    preserveHostProgress();
    if (started) endWaits();
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
    milestones = milestones.map((step, index): SessionPlanStep => {
      if (step.status === "completed" || step.status === "canceled") return step;
      const desired =
        index < hostSteps.length
          ? phaseIndex > index + 1
            ? "completed"
            : phaseIndex === index + 1
              ? "inProgress"
              : "pending"
          : phase === "completed"
            ? "completed"
            : step.status;
      return {
        ...step,
        status: desired === "pending" && step.status === "inProgress" ? "inProgress" : desired,
      };
    });
    publish(
      "linear.session.plan",
      { sessionId, plan: [...waits, ...agentSteps, ...milestones] },
      phase === "completed",
    );
  }

  return {
    plan(plan: readonly SessionPlanStep[]) {
      started = true;
      steps = plan;
      publishPlan();
    },
    /** The item waits before it starts: "Wait for PAS-m" in progress and the title saying so. */
    wait(step: string | null, title: string) {
      preserveHostProgress();
      started = false;
      const last = waits.at(-1);
      if (step !== null && (last?.content !== step || last.status !== "inProgress")) {
        endWaits();
        waits.push({ content: step, status: "inProgress" });
      }
      publishPlan();
      publish("linear.session.summary", { sessionId, summary: title.slice(0, 255) });
    },
    restart(reason: string, round: number, version: number, limit = 3) {
      started = true;
      preserveHostProgress();
      if (
        restartVersion === version ||
        (latestPlan()?.payload as typeof saved)?.restartVersion === version
      )
        return;
      restartVersion = version;
      const content =
        reason === "ci"
          ? "Fix CI"
          : reason === "review"
            ? "Fix review findings"
            : reason === "conflict"
              ? "Resolve merge conflict"
              : `Fix Closeout findings (${round} of ${limit})`;
      milestones = milestones.map((step) =>
        step.status === "inProgress" && step.content !== "Merge verified changes"
          ? { ...step, status: "completed" }
          : step,
      );
      milestones.push({ content, status: "inProgress" });
      if (!afterPr()) phase = "fixing";
      publishPlan();
      publish(
        "linear.session.summary",
        {
          sessionId,
          summary: `${identifier}: ${reason === "ci" ? "fixing CI" : reason === "review" ? "fixing review findings" : reason === "conflict" ? "resolving merge conflict" : `fixing Closeout findings (${round} of ${limit})`}`,
        },
        true,
      );
    },
    phase(next: Phase) {
      started = true;
      preserveHostProgress();
      if (afterPr() && ["working", "implementing", "fixing", "verifying"].includes(next)) {
        if (next === "verifying") {
          const last = milestones.at(-1);
          const fixing = last?.status === "inProgress" && /^(Fix |Resolve )/.test(last.content);
          const content = fixing ? "Verify fixes" : "Re-verify after rebase";
          if (fixing)
            milestones = milestones.map((step, index) =>
              index === milestones.length - 1 ? { ...step, status: "completed" } : step,
            );
          if (last?.content !== content || last.status === "completed")
            milestones.push({ content, status: "inProgress" });
          publishPlan();
          publish(
            "linear.session.summary",
            {
              sessionId,
              summary: `${identifier}: ${fixing ? "checking fixes" : "rebased onto main, re-verifying"}`,
            },
            true,
          );
        }
        return;
      }
      if (next === "merging")
        milestones = milestones.map((step, index) =>
          index >= hostSteps.length ? { ...step, status: "completed" } : step,
        );
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
      const added = db
        .query<{ id: number }, [string, number, string]>(
          `SELECT id FROM outbox WHERE target = 'linear' AND op = 'linear.session.links'
            AND ordering_key = ? AND delivery_generation = ? AND status IN ('pending', 'sent')
            AND json_extract(payload, '$.addedExternalUrls[0].url') = ? LIMIT 1`,
        )
        .get(sessionId, generation, url);
      if (added !== null) return;
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "linear.session.links",
        orderingKey: sessionId,
        priority: 5,
        generation,
        idempotencyKey: `linear.session.links:${sessionId}:${randomUUID()}`,
        payload: { sessionId, addedExternalUrls: [{ label, url }], identifier, mode, ...owner },
        now: now(),
      });
    },
  };
}
