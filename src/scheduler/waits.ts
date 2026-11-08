import type { Database } from "bun:sqlite";
import { ordinal, type RestartReason, type WorkItemState } from "../core";
import {
  enqueueOutboxOnce,
  getLinearSessionGeneration,
  itemWaitSince,
  keepItemWaits,
  lastItemEvent,
  lastPausedBy,
  linearSessionClosed,
  type ItemHold,
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

function restartReason(db: Database, itemId: string) {
  const last = lastItemEvent(db, itemId);
  return last?.kind === "restart" &&
    (last.reason === "findings" ||
      last.reason === "ci" ||
      last.reason === "review" ||
      last.reason === "conflict")
    ? last.reason
    : null;
}

function pausedBy(db: Database, itemId: string): string | null {
  return lastPausedBy(db, itemId);
}

export function itemWaits(
  db: Database,
  items: readonly WaitItem[],
  holds: readonly ItemHold[],
  positions: ReadonlyMap<string, number>,
): ItemWait[] {
  const held = new Map(holds.map((hold) => [hold.itemId, hold]));
  const sessions = new Map<string, WaitItem[]>();
  for (const item of [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)))
    if (item.sessionId && !item.absent)
      sessions.set(item.sessionId, [...(sessions.get(item.sessionId) ?? []), item]);
  const waits: ItemWait[] = [];
  for (const [sessionId, members] of sessions) {
    const faces = members.flatMap((item): ItemWait[] => {
      if (item.cancelRequested || item.identifier === null) return [];
      const base = {
        itemId: item.id,
        sessionId,
        identifier: item.identifier,
        version: item.version,
      };
      if (item.state === "paused") return [{ ...base, kind: "paused", by: pausedBy(db, item.id) }];
      if (item.state === "recovering" && !item.liveJob) return [{ ...base, kind: "recovering" }];
      if (item.state !== "queued" || item.liveRun || item.liveJob) return [];
      const hold = held.get(item.id);
      if (hold?.reason === "blocked")
        return [{ ...base, kind: "blocked", blockers: hold.blockers }];
      if (hold?.reason === "overlap" && hold.blockers[0])
        return [
          {
            ...base,
            kind: "overlap",
            blocker: hold.blockers[0],
            files: hold.files ?? [],
            ...(hold.start ? { start: hold.start } : {}),
          },
        ];
      const position = positions.get(item.id);
      if ((hold?.reason === "slot" || hold?.reason === "cap") && position !== undefined)
        return [
          {
            ...base,
            kind: "runner",
            position,
            ...(hold.reason === "slot" && hold.blockers[0] ? { noRunner: hold.blockers[0] } : {}),
            restart: restartReason(db, item.id),
          },
        ];
      return [];
    });
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
  const names = [...new Set(files.map((path) => path.slice(path.lastIndexOf("/") + 1)))];
  return `waiting for ${blocker} to ${start ? "start" : "merge"}${names.length ? ` (both change ${names.join(", ")})` : ""}`;
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

export function postWaitKeepalives(db: Database, waits: readonly ItemWait[], now: number): void {
  const queued = waits.filter(
    (wait) => wait.kind === "blocked" || wait.kind === "overlap" || wait.kind === "runner",
  );
  keepItemWaits(
    db,
    queued.map((wait) => wait.itemId),
  );
  for (const wait of queued) {
    const since = itemWaitSince(db, wait.itemId, wait.version, now);
    const mark = Math.floor((now - since) / WAIT_KEEPALIVE_MS);
    const body = waitingLine(wait);
    if (mark < 1 || body === null) continue;
    const generation = getLinearSessionGeneration(db, wait.sessionId);
    if (linearSessionClosed(db, wait.sessionId, generation)) continue;
    enqueueOutboxOnce(db, {
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
