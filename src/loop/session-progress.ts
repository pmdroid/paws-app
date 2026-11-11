import { hasPublishedPullRequestSteps } from "./activity-policy";
import type { TaskMode } from "../core";
import { randomUUID } from "node:crypto";
import {
  enqueueOutboxOnceSteps,
  listOutboxSteps,
  publishSessionMetadataSteps,
  sessionFenceGenerationSteps,
  sessionLinkQueuedSteps,
  type Db,
  type Q,
  type Steps,
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

export type LinearSessionProgress = Awaited<ReturnType<typeof createLinearSessionProgress>>;

export async function createLinearSessionProgress(
  store: Db,
  sessionId: string,
  identifier: string,
  now: () => number = Date.now,
  mode: TaskMode = "code",
  itemId?: string,
) {
  const progress = await store.run((q) =>
    linearSessionProgressSteps(q, sessionId, identifier, now, mode, itemId),
  );
  return {
    steps: progress,
    plan: (plan: readonly SessionPlanStep[]) => store.transaction((q) => progress.plan(q, plan)),
    wait: (step: string | null, title: string) =>
      store.transaction((q) => progress.wait(q, step, title)),
    restart: (reason: string, round: number, version: number, limit = 3) =>
      store.transaction((q) => progress.restart(q, reason, round, version, limit)),
    phase: (next: Phase) => store.transaction((q) => progress.phase(q, next)),
    reach: (next: "merging") => store.transaction((q) => progress.reach(q, next)),
    keepalive: (lastLine: string | null) => store.run((q) => progress.keepalive(q, lastLine)),
    status: (text: string) => store.transaction((q) => progress.status(q, text)),
    mergeStatus: (text: string) => store.transaction((q) => progress.mergeStatus(q, text)),
    restartWait: (text: string) => store.transaction((q) => progress.restartWait(q, text)),
    link: (label: string, url: string) => store.transaction((q) => progress.link(q, label, url)),
  };
}

export function* linearSessionProgressSteps(
  read: Q,
  sessionId: string,
  identifier: string,
  now: () => number = Date.now,
  mode: TaskMode = "code",
  itemId?: string,
) {
  const owner = itemId === undefined ? {} : { itemId };
  const generation = yield* sessionFenceGenerationSteps(read, sessionId);
  const hostSteps = mode === "code" ? HOST_STEPS : [];
  const latestPlan = function* (q: Q) {
    return (yield* listOutboxSteps(q, sessionId)).findLast(
      (row) =>
        (row.payload as SessionUpdate).plan !== undefined &&
        row.generation === generation &&
        (row.status !== "dropped" || row.error?.startsWith("Sending with outbox")) &&
        (row.payload as { identifier?: string }).identifier === identifier &&
        ((row.payload as { mode?: TaskMode }).mode ?? "code") === mode,
    );
  };
  const saved = (yield* latestPlan(read))?.payload as
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
  const afterPr = (q: Q) => hasPublishedPullRequestSteps(q, sessionId, generation);

  function* preserveHostProgress(q: Q): Steps<void> {
    const latest = (yield* latestPlan(q))?.payload as typeof saved;
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
    if ((yield* afterPr(q)) && ["working", "implementing", "fixing", "verifying"].includes(phase))
      phase = latest.phase ?? "merging";
  }

  // Plan and summary are latest-wins: a pending row takes the new payload, and a new row
  // waits until METADATA_INTERVAL_MS after the last one went out. A final update is due now.
  function* publish(q: Q, op: string, update: SessionUpdate, final = false): Steps<void> {
    const metadata =
      op === "linear.session.plan"
        ? { agentSteps: steps, hostPlan: milestones, phase, restartVersion, waits }
        : {};
    const field = op === "linear.session.plan" ? "plan" : "summary";
    yield* publishSessionMetadataSteps(q, {
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

  function* publishPlan(q: Q, final = false): Steps<void> {
    yield* preserveHostProgress(q);
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
    yield* publish(
      q,
      "linear.session.plan",
      { sessionId, plan: [...waits, ...agentSteps, ...milestones] },
      final || phase === "completed",
    );
  }

  return {
    *plan(q: Q, plan: readonly SessionPlanStep[]): Steps<void> {
      started = true;
      steps = plan;
      yield* publishPlan(q);
    },
    *wait(q: Q, step: string | null, title: string): Steps<void> {
      yield* preserveHostProgress(q);
      started = false;
      const last = waits.at(-1);
      if (step !== null && (last?.content !== step || last.status !== "inProgress")) {
        endWaits();
        waits.push({ content: step, status: "inProgress" });
      }
      yield* publishPlan(q);
      if (!(yield* afterPr(q)))
        yield* publish(q, "linear.session.summary", { sessionId, summary: title.slice(0, 255) });
    },
    *restart(q: Q, reason: string, round: number, version: number, limit = 3): Steps<void> {
      started = true;
      yield* preserveHostProgress(q);
      if (
        restartVersion === version ||
        ((yield* latestPlan(q))?.payload as typeof saved)?.restartVersion === version
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
      const pullRequest = yield* afterPr(q);
      if (!pullRequest) phase = "fixing";
      // Due now, with the summary below: the turn's new step should not lag it by the interval.
      yield* publishPlan(q, true);
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
      yield* publish(
        q,
        "linear.session.summary",
        { sessionId, summary: `${identifier}: ${status}` },
        true,
      );
    },
    *phase(q: Q, next: Phase): Steps<void> {
      started = true;
      yield* preserveHostProgress(q);
      const afterPullRequest = yield* afterPr(q);
      if (afterPullRequest && ["working", "implementing", "fixing", "verifying"].includes(next)) {
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
          yield* publishPlan(q);
        }
        return;
      }
      if (next === "publishing" && afterPullRequest) return;
      if (next === "merging")
        milestones = milestones.map((step, index) =>
          index >= hostSteps.length ? { ...step, status: "completed" } : step,
        );
      phase = next;
      yield* publishPlan(q);
      const status =
        next === "working"
          ? mode === "answer"
            ? "preparing answer"
            : mode === "plan"
              ? "planning sub-issues"
              : "creating files"
          : next === "fixing"
            ? "fixing Closeout findings"
            : next === "merging" && (yield* afterPr(q))
              ? "waiting to merge"
              : next === "completed" && (yield* afterPr(q))
                ? "merged"
                : next;
      const summary = `${identifier}: ${status}`.slice(0, 255);
      yield* publish(q, "linear.session.summary", { sessionId, summary }, next === "completed");
    },
    *reach(q: Q, next: "merging"): Steps<void> {
      const current = ((yield* latestPlan(q))?.payload as typeof saved)?.phase ?? phase;
      if (current === next || current === "completed") return;
      yield* this.phase(q, next);
    },
    /**
     * The keepalive line: the agent's current plan step while it works, else the last
     * line it posted, else the phase name.
     */
    *keepalive(q: Q, lastLine: string | null): Steps<string> {
      const latest = (yield* latestPlan(q))?.payload as typeof saved;
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
    *status(q: Q, text: string): Steps<void> {
      yield* publish(q, "linear.session.summary", { sessionId, summary: text.slice(0, 255) }, true);
    },
    *mergeStatus(q: Q, text: string): Steps<void> {
      yield* this.status(q, (yield* afterPr(q)) ? `${identifier}: waiting to merge` : text);
    },
    *restartWait(q: Q, text: string): Steps<void> {
      if (!(yield* afterPr(q))) yield* this.status(q, text);
    },
    *link(q: Q, label: string, url: string): Steps<void> {
      // Links are not throttled, so they sort ahead of a plan or summary that is still waiting.
      if (yield* sessionLinkQueuedSteps(q, sessionId, generation, url)) return;
      yield* enqueueOutboxOnceSteps(q, {
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
