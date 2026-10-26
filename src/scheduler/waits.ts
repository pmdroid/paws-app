import type { Database } from "bun:sqlite";
import { ordinal, type RestartReason, type WorkItemState } from "../core";
import {
  enqueueOutboxOnce,
  getLinearSessionGeneration,
  itemWaitSince,
  keepItemWaits,
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
  | {
      kind: "runner";
      position: number;
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
  const last = db
    .query<{ kind: string; reason: string | null }, [string]>(
      "SELECT kind,reason FROM work_item_event WHERE item_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(itemId);
  return last?.kind === "restart" &&
    (last.reason === "findings" ||
      last.reason === "ci" ||
      last.reason === "review" ||
      last.reason === "conflict")
    ? last.reason
    : null;
}

function pausedBy(db: Database, itemId: string): string | null {
  return (
    db
      .query<{ name: string }, [string]>(
        `SELECT u.name FROM workspace_access_audit a JOIN workspace_user u ON u.id=a.user_id
         WHERE a.action='execution.pause' AND a.subject=? ORDER BY a.id DESC LIMIT 1`,
      )
      .get(itemId)?.name ?? null
  );
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
      const position = positions.get(item.id);
      if ((hold?.reason === "slot" || hold?.reason === "cap") && position !== undefined)
        return [{ ...base, kind: "runner", position, restart: restartReason(db, item.id) }];
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

export function waitingLine(wait: ItemWait): string | null {
  if (wait.kind === "blocked")
    return wait.blockers.length
      ? `Still waiting for ${wait.blockers.join(", ")}.`
      : "Still waiting for a blocking issue.";
  if (wait.kind === "runner") return `Still ${ordinal(wait.position)} in line for a runner.`;
  return null;
}

export function postWaitKeepalives(db: Database, waits: readonly ItemWait[], now: number): void {
  const queued = waits.filter((wait) => wait.kind === "blocked" || wait.kind === "runner");
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
    if (
      db
        .query(
          `SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=? AND delivery_generation=?
           AND delivery_kind IN ('terminal','stop') AND status!='dropped' LIMIT 1`,
        )
        .get(wait.sessionId, generation)
    )
      continue;
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
