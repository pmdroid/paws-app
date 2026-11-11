import { hasPublishedPullRequest } from "./activity-policy";
import type { Database } from "bun:sqlite";
import type { TaskMode } from "../core";
import { randomUUID } from "node:crypto";
import {
  enqueueOutboxOnce,
  listOutbox,
  publishSessionMetadata,
  sessionFenceGeneration,
  sessionLinkQueued,
} from "../db";
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

const PHASE_LINES: Record<Phase, string> = {
  working: "Creating files for",
  implementing: "Implementing",
  fixing: "Fixing Closeout findings for",
  verifying: "Verifying",
  publishing: "Opening the pull request for",
  merging: "Merging",
  completed: "Finishing",
};

export function createLinearSessionProgress(
  db: Database,
  sessionId: string,
  identifier: string,
  now: () => number = Date.now,
  mode: TaskMode = "code",
  itemId?: string,
) {
  const owner = itemId === undefined ? {} : { itemId };
  const generation = sessionFenceGeneration(db, sessionId);
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
    const metadata =
      op === "linear.session.plan"
        ? { agentSteps: steps, hostPlan: milestones, phase, restartVersion, waits }
        : {};
    const field = op === "linear.session.plan" ? "plan" : "summary";
    publishSessionMetadata(db, {
      sessionId,
      generation,
      op,
      field,
      value: update[field],
      payload: { ...update, ...metadata, identifier, mode, ...owner },
      final,
      idempotencyKey: `${op}:${sessionId}:${randomUUID()}`,
      intervalMs: METADATA_INTERVAL_MS,
      at: now(),
    });
  }

  function endWaits() {
    waits = waits.map((step) =>
      step.status === "inProgress" ? { ...step, status: "completed" } : step,
    );
  }

  function publishPlan(final = false) {
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
      final || phase === "completed",
    );
  }

  return {
    plan(plan: readonly SessionPlanStep[]) {
      started = true;
      steps = plan;
      publishPlan();
    },
    wait(step: string | null, title: string) {
      preserveHostProgress();
      started = false;
      const last = waits.at(-1);
      if (step !== null && (last?.content !== step || last.status !== "inProgress")) {
        endWaits();
        waits.push({ content: step, status: "inProgress" });
      }
      publishPlan();
      if (!afterPr())
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
              ? "Fix merge conflicts"
              : `Fix Closeout findings (${round} of ${limit})`;
      milestones = milestones.map((step) =>
        step.status === "inProgress" && step.content !== "Merge verified changes"
          ? { ...step, status: "completed" }
          : step,
      );
      milestones.push({ content, status: "inProgress" });
      const pullRequest = afterPr();
      if (!pullRequest) phase = "fixing";
      // Due now, with the summary below: the turn's new step should not lag it by the interval.
      publishPlan(true);
      const status = pullRequest
        ? reason === "ci"
          ? "fixing CI"
          : reason === "review"
            ? "fixing review comments"
            : reason === "conflict"
              ? "fixing merge conflicts"
              : "fixing Closeout findings"
        : reason === "ci"
          ? `fixing CI (${round} of ${limit})`
          : reason === "review"
            ? `fixing review findings (${round} of ${limit})`
            : reason === "conflict"
              ? "resolving merge conflict"
              : `fixing Closeout findings (${round} of ${limit})`;
      publish("linear.session.summary", { sessionId, summary: `${identifier}: ${status}` }, true);
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
        }
        return;
      }
      if (next === "publishing" && afterPr()) return;
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
            : mode === "plan"
              ? "planning sub-issues"
              : "creating files"
          : next === "fixing"
            ? "fixing Closeout findings"
            : next === "merging" && afterPr()
              ? "waiting to merge"
              : next === "completed" && afterPr()
                ? "merged"
                : next;
      const summary = `${identifier}: ${status}`.slice(0, 255);
      publish("linear.session.summary", { sessionId, summary }, next === "completed");
    },
    reach(next: "merging") {
      const current = (latestPlan()?.payload as typeof saved)?.phase ?? phase;
      if (current === next || current === "completed") return;
      this.phase(next);
    },
    /**
     * The keepalive line: the agent's current plan step while it works, else the last
     * line it posted, else the phase name.
     */
    keepalive(lastLine: string | null): string {
      const latest = latestPlan()?.payload as typeof saved;
      const current = latest?.phase ?? phase;
      const agentSteps = latest?.agentSteps ?? steps;
      if (current === "working" || current === "implementing" || current === "fixing") {
        const active = agentSteps.findIndex((step) => step.status === "inProgress");
        const index =
          active >= 0 ? active : agentSteps.findIndex((step) => step.status === "pending");
        const step = agentSteps[index]?.content.trim();
        if (step)
          return `Step ${index + 1} of ${agentSteps.length}: ${step}${/[.!?]$/.test(step) ? "" : "."}`;
      }
      if (lastLine !== null && lastLine.trim() !== "") return lastLine;
      const line =
        current === "working" && mode === "answer"
          ? "Preparing the answer for"
          : current === "working" && mode === "plan"
            ? "Planning sub-issues for"
            : PHASE_LINES[current];
      return `${line} ${identifier}.`;
    },
    status(text: string) {
      publish("linear.session.summary", { sessionId, summary: text.slice(0, 255) }, true);
    },
    mergeStatus(text: string) {
      this.status(afterPr() ? `${identifier}: waiting to merge` : text);
    },
    restartWait(text: string) {
      if (!afterPr()) this.status(text);
    },
    link(label: string, url: string) {
      // Links are not throttled, so they sort ahead of a plan or summary that is still waiting.
      if (sessionLinkQueued(db, sessionId, generation, url)) return;
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
