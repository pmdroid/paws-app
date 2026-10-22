import type { Database } from "bun:sqlite";
import {
  cancelPawsUpdate,
  clearPawsUpdate,
  getPawsUpdate,
  listUpdateHolders,
  markPawsUpdate,
  requestPawsUpdateNow,
  schedulePawsUpdate,
  type PawsUpdate,
} from "../db";
import type { PawsCheckout } from "./checkout";

/** How often Paws compares its commit with `origin/main`. */
export const UPDATE_CHECK_MS = 10 * 60_000;
/** How often a waiting update looks for running work to finish. */
export const UPDATE_TICK_MS = 15_000;
/** Exit code after an applied update. `Restart=on-failure` in `paws.service` starts the new code. */
export const UPDATE_RESTART_EXIT = 75;

export type TickResult = "idle" | "busy" | "waiting" | "applied" | "failed";

export type PawsUpdater = {
  /** After startup: finish or fail an update that was applying when Paws exited. */
  startup(): Promise<void>;
  /** Schedule an update when `main` is ahead. An automatic check respects the workspace setting. */
  check(source: "automatic" | "manual"): Promise<PawsUpdate | null>;
  /** Apply a waiting update once no task runs, or at once after **Update now**. */
  tick(): Promise<TickResult>;
};

export function createPawsUpdater(input: {
  db: Database;
  checkout: PawsCheckout;
  now: () => number;
  /** `[update] automatic` in config.toml. Missing means on. */
  automatic: () => boolean;
  /** Exit so systemd starts the new code. */
  restart: () => void;
  log?: (message: string) => void;
}): PawsUpdater {
  const { db, checkout } = input;
  let busy = false;
  return {
    async startup() {
      const update = getPawsUpdate(db);
      if (update?.status !== "applying") return;
      if ((await checkout.head()) === update.target) {
        clearPawsUpdate(db);
        input.log?.(`Paws updated to ${update.target.slice(0, 7)}.`);
      } else
        markPawsUpdate(db, "failed", input.now(), "Paws restarted before the update finished.");
    },
    async check(source) {
      if (source === "automatic" && !input.automatic()) return null;
      const current = await checkout.head();
      const target = await checkout.fetchMain();
      if (target === current || !(await checkout.contains(target, current))) return null;
      return schedulePawsUpdate(db, { target, current, source, now: input.now() });
    },
    async tick() {
      if (busy) return "busy";
      const update = getPawsUpdate(db);
      if (update?.status !== "waiting") return "idle";
      if (!update.nowRequested && listUpdateHolders(db).length > 0) return "waiting";
      busy = true;
      markPawsUpdate(db, "applying", input.now());
      try {
        await checkout.apply(update.target);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The update failed.";
        markPawsUpdate(db, "failed", input.now(), message);
        input.log?.(`Paws stays on ${update.current.slice(0, 7)}. ${message}`);
        return "failed";
      } finally {
        busy = false;
      }
      input.restart();
      return "applied";
    },
  };
}

/** `POST /api/paws-update` with `{ action: "now" | "cancel" }`. Owners and admins only. */
export async function handlePawsUpdateRequest(
  request: Request,
  role: string,
  db: Database,
  now: () => number,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/paws-update") return null;
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  if (role !== "owner" && role !== "admin")
    return Response.json(
      { error: "Only workspace owners and admins can update Paws." },
      { status: 403 },
    );
  const body: unknown = await request.json().catch(() => null);
  const action = typeof body === "object" && body !== null && "action" in body ? body.action : null;
  if (action === "now") {
    return requestPawsUpdateNow(db, now())
      ? Response.json({ ok: true })
      : Response.json({ error: "No Paws update is waiting." }, { status: 409 });
  }
  if (action === "cancel") {
    return cancelPawsUpdate(db)
      ? Response.json({ ok: true })
      : Response.json({ error: "No Paws update can be cancelled." }, { status: 409 });
  }
  return Response.json({ error: "action must be now or cancel." }, { status: 400 });
}
