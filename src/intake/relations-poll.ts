import type { Database } from "bun:sqlite";
import { blockerCheckedAt, getWorkItem } from "../db";
import {
  BLOCKED_RELATIONS_POLL_MS,
  RELATIONS_POLL_MS,
  type createItemReconciler,
  type RelationsScope,
} from "./reconciliation";

const BLOCKER_CHECK_PATH = "/api/blocker-checks";
const BLOCKER_CHECK_COOLDOWN_MS = 15_000;

type Reconciler = Pick<ReturnType<typeof createItemReconciler>, "pollRelations" | "blockedItemIds">;

export function relationsPollIntervalMs(input: { blocked: boolean; lowBudget: boolean }): number {
  return input.blocked && !input.lowBudget ? BLOCKED_RELATIONS_POLL_MS : RELATIONS_POLL_MS;
}

export function createRelationsPolls(input: {
  db: Database;
  reconciler: Reconciler;
  lowBudget: () => boolean;
  reconcileExecution: () => void;
  read?: <T>(run: () => Promise<T>) => Promise<T>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const read = input.read ?? ((run) => run());
  const pressed = new Map<string, number>();

  async function poll(scope: RelationsScope, signal?: AbortSignal) {
    const changed = await read(() => input.reconciler.pollRelations({ scope, signal }));
    if (changed.length) input.reconcileExecution();
    return changed;
  }

  function intervalMs(): number {
    return relationsPollIntervalMs({
      blocked: input.reconciler.blockedItemIds().length > 0,
      lowBudget: input.lowBudget(),
    });
  }

  async function checkNow(itemId: string, signal?: AbortSignal) {
    const at = now();
    const last = pressed.get(itemId);
    if (last !== undefined && at - last < BLOCKER_CHECK_COOLDOWN_MS)
      return { ok: false as const, retryAfterMs: last + BLOCKER_CHECK_COOLDOWN_MS - at };
    for (const [id, time] of pressed)
      if (at - time >= BLOCKER_CHECK_COOLDOWN_MS) pressed.delete(id);
    pressed.set(itemId, at);
    const changed = await poll({ itemId }, signal);
    return { ok: true as const, changed: changed.length > 0 };
  }

  return {
    intervalMs,
    all: (signal?: AbortSignal) => poll("all", signal),
    blocked: async (signal?: AbortSignal) =>
      intervalMs() === BLOCKED_RELATIONS_POLL_MS ? poll("blocked", signal) : [],
    checkNow,
  };
}

export function createBlockerCheckRoute(input: {
  db: Database;
  polls: Pick<ReturnType<typeof createRelationsPolls>, "checkNow">;
  blockedItemIds: () => string[];
  signal?: AbortSignal;
}) {
  return async (request: Request, sessionIds: readonly string[]): Promise<Response | null> => {
    if (new URL(request.url).pathname !== BLOCKER_CHECK_PATH) return null;
    if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
    const length = Number(request.headers.get("content-length") ?? NaN);
    let itemId: unknown;
    try {
      if (!request.headers.get("content-type")?.startsWith("application/json") || !(length <= 1024))
        throw new Error();
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "itemId")
        throw new Error();
      itemId = (body as { itemId: unknown }).itemId;
    } catch {
      return Response.json({ error: "Send an itemId as bounded JSON." }, { status: 400 });
    }
    if (typeof itemId !== "string" || !itemId)
      return Response.json({ error: "Send an itemId as bounded JSON." }, { status: 400 });
    const item = input
      .blockedItemIds()
      .map((id) => getWorkItem(input.db, id))
      .find(
        (candidate) =>
          candidate?.sessionKey &&
          sessionIds.includes(candidate.sessionKey) &&
          (candidate.id === itemId || candidate.linearIdentifier === itemId),
      );
    if (!item)
      return Response.json({ error: `${itemId} is not waiting on a blocker.` }, { status: 409 });
    const result = await input.polls.checkNow(item.id, input.signal);
    if (!result.ok) {
      const seconds = Math.ceil(result.retryAfterMs / 1000);
      return Response.json(
        {
          error: `Blockers for ${item.linearIdentifier} were just checked. Try again in ${seconds} s.`,
        },
        { status: 429, headers: { "retry-after": String(seconds) } },
      );
    }
    const checkedAt = blockerCheckedAt(input.db, item.id);
    return Response.json({
      itemId: item.id,
      changed: result.changed,
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    });
  };
}
