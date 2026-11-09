import { randomUUID } from "node:crypto";
import { ordinal, type RestartReason, type WorkItemState } from "../core";
import {
  enqueueOutboxOnceSteps,
  getLinearSessionGenerationSteps,
  itemWaitSinceSteps,
  keepItemWaitsSteps,
  lastItemEventSteps,
  lastPausedBySteps,
  linearSessionClosedSteps,
  pullRequestReadyQueuedSteps,
  type ItemHold,
  type Q,
  type Steps,
} from "../db";

export const WAIT_KEEPALIVE_MS = 25 * 60 * 1000;

export type ItemWait = {
  itemId: string;
  sessionId: string;
  identifier: string;
  version: number;
} & (
  | { kind: "blocked"; blockers: string[] }
  | { kind: "overlap"; blocker: string; files: string[]; start?: true }
  | {
      kind: "runner";
      position: number;
      noRunner?: string;
      restart: Exclude<RestartReason, "follow_up" | "answer"> | null;
    }
  | { kind: "paused"; by: string | null }
  | { kind: "recovering" }
);

type WaitItem = {
  id: string;
  identifier: string | null;
  position: number;
  state: WorkItemState;
  version: number;
  cancelRequested: number;
  absent: number;
  liveRun: number;
  liveJob: number;
  sessionId: string | null;
};

const BUSY: readonly WorkItemState[] = [
  "running",
  "verifying",
  "recovering",
  "awaiting_input",
  "paused",
  "merge_queue",
];

function* restartReasonSteps(q: Q, itemId: string) {
  const last = yield* lastItemEventSteps(q, itemId);
  return last?.kind === "restart" &&
    (last.reason === "findings" ||
      last.reason === "ci" ||
      last.reason === "review" ||
      last.reason === "conflict")
    ? last.reason
    : null;
}

export function* itemWaitsSteps(
  q: Q,
  items: readonly WaitItem[],
  holds: readonly ItemHold[],
  positions: ReadonlyMap<string, number>,
): Steps<ItemWait[]> {
  const held = new Map(holds.map((hold) => [hold.itemId, hold]));
  const sessions = new Map<string, WaitItem[]>();
  for (const item of [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)))
    if (item.sessionId && !item.absent)
      sessions.set(item.sessionId, [...(sessions.get(item.sessionId) ?? []), item]);
  const waits: ItemWait[] = [];
  for (const [sessionId, members] of sessions) {
    const faces: ItemWait[] = [];
    for (const item of members) {
      if (item.cancelRequested || item.identifier === null) continue;
      const base = {
        itemId: item.id,
        sessionId,
        identifier: item.identifier,
        version: item.version,
      };
      if (item.state === "paused") {
        faces.push({ ...base, kind: "paused", by: yield* lastPausedBySteps(q, item.id) });
        continue;
      }
      if (item.state === "recovering" && !item.liveJob) {
        faces.push({ ...base, kind: "recovering" });
        continue;
      }
      if (item.state !== "queued" || item.liveRun || item.liveJob) continue;
      const hold = held.get(item.id);
      if (hold?.reason === "blocked") {
        faces.push({ ...base, kind: "blocked", blockers: hold.blockers });
        continue;
      }
      if (hold?.reason === "overlap" && hold.blockers[0]) {
        faces.push({
          ...base,
          kind: "overlap",
          blocker: hold.blockers[0],
          files: hold.files ?? [],
          ...(hold.start ? { start: hold.start } : {}),
        });
        continue;
      }
      const position = positions.get(item.id);
      if ((hold?.reason === "slot" || hold?.reason === "cap") && position !== undefined)
        faces.push({
          ...base,
          kind: "runner",
          position,
          ...(hold.reason === "slot" && hold.blockers[0] ? { noRunner: hold.blockers[0] } : {}),
          restart: yield* restartReasonSteps(q, item.id),
        });
    }
    const shown = new Set(faces.map((face) => face.itemId));
    if (
      members.some(
        (item) =>
          !shown.has(item.id) &&
          (BUSY.includes(item.state) || Boolean(item.liveRun) || Boolean(item.liveJob)),
      )
    )
      continue;
    const face =
      faces.find((entry) => entry.kind === "paused" || entry.kind === "recovering") ?? faces[0];
    if (face) waits.push(face);
  }
  return waits;
}

/** `waiting for PAS-1 to merge (both change provider.ts)`, file names without their directories. */
export function overlapLine(blocker: string, files: readonly string[], start?: true): string {
  return `waiting for ${blocker} to ${start ? "start" : "merge"}${bothChange(files)}`;
}

function bothChange(files: readonly string[]): string {
  const names = [...new Set(files.map((path) => path.slice(path.lastIndexOf("/") + 1)))];
  return names.length ? ` (both change ${names.join(", ")})` : "";
}

export function waitingLine(wait: ItemWait): string | null {
  if (wait.kind === "overlap") return `Still ${overlapLine(wait.blocker, wait.files, wait.start)}.`;
  if (wait.kind === "blocked")
    return `${
      wait.blockers.length
        ? `Still waiting for ${wait.blockers.join(", ")}.`
        : "Still waiting for a blocking issue."
    } Paws checks blockers in Linear every minute while it waits.`;
  if (wait.kind === "runner")
    return wait.noRunner
      ? `Still waiting. ${wait.noRunner}.`
      : `Still ${ordinal(wait.position)} in line for a runner.`;
  return null;
}

/**
 * An item sent back to rebase and held behind another item that changes the same files says so
 * once per blocker, after its pull request response. The key adds the item to the
 * `merge-hold:<generation>:<blocker>` the activity gate lets through, because outbox keys are
 * unique across sessions and two items can wait for one blocker. Not `terminal`: the session goes
 * on. A blocker that has not started yet gets its line when it starts.
 */
export function* postConflictHoldsSteps(
  q: Q,
  waits: readonly ItemWait[],
  now: number,
): Steps<void> {
  for (const wait of waits) {
    if (wait.kind !== "overlap" || wait.start) continue;
    if ((yield* restartReasonSteps(q, wait.itemId)) !== "conflict") continue;
    const generation = yield* getLinearSessionGenerationSteps(q, wait.sessionId);
    if (
      !(yield* pullRequestReadyQueuedSteps(q, wait.sessionId, generation)) ||
      (yield* linearSessionClosedSteps(q, wait.sessionId, generation))
    )
      continue;
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: wait.sessionId,
      idempotencyKey: `merge-hold:${generation}:${wait.blocker}:${wait.itemId}`,
      delivery: "ordered",
      payload: {
        id: randomUUID(),
        sessionId: wait.sessionId,
        itemId: wait.itemId,
        kind: "response",
        body: `Waiting for ${wait.blocker} to merge first${bothChange(wait.files)}, then rebasing.`,
      },
      now,
    });
  }
}

export function* postWaitKeepalivesSteps(
  q: Q,
  waits: readonly ItemWait[],
  now: number,
): Steps<void> {
  const queued = waits.filter(
    (wait) => wait.kind === "blocked" || wait.kind === "overlap" || wait.kind === "runner",
  );
  yield* keepItemWaitsSteps(
    q,
    queued.map((wait) => wait.itemId),
  );
  for (const wait of queued) {
    const since = yield* itemWaitSinceSteps(q, wait.itemId, wait.version, now);
    const mark = Math.floor((now - since) / WAIT_KEEPALIVE_MS);
    const body = waitingLine(wait);
    if (mark < 1 || body === null) continue;
    const generation = yield* getLinearSessionGenerationSteps(q, wait.sessionId);
    if (yield* linearSessionClosedSteps(q, wait.sessionId, generation)) continue;
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: wait.sessionId,
      idempotencyKey: `${wait.itemId}:wait:${wait.version}:keep:${mark}`,
      priority: 1,
      payload: {
        sessionId: wait.sessionId,
        itemId: wait.itemId,
        kind: "thought",
        body,
        ephemeral: true,
      },
      now,
    });
  }
}
