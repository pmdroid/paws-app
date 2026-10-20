import type { Database } from "bun:sqlite";
import { refreshRepositoryCatalog, type CatalogEntry } from "../db";

export function createRepositoryCatalogRefresh(
  db: Database,
  list: () => Promise<readonly CatalogEntry[]>,
  signal: AbortSignal,
) {
  let next: PromiseWithResolvers<boolean> | null = null;
  let draining = false;
  let idle = Promise.resolve();
  const generation = () =>
    JSON.stringify([
      db.query("SELECT id FROM workspace ORDER BY id").all(),
      db
        .query(
          "SELECT workspace_id,generation,secret_id,installation_id FROM workspace_github_connection ORDER BY workspace_id",
        )
        .all(),
    ]);
  const listUntilShutdown = async () => {
    const entries = await list();
    signal.throwIfAborted();
    return entries;
  };
  async function drain() {
    try {
      while (next && !signal.aborted) {
        const waiting = next;
        next = null;
        try {
          const snapshot = generation();
          const current = () => !signal.aborted && next === null && snapshot === generation();
          const refreshed = await refreshRepositoryCatalog(
            db,
            listUntilShutdown,
            Date.now(),
            current,
          ).catch(() => false);
          waiting.resolve(refreshed);
          if (!signal.aborted && snapshot !== generation())
            next ??= Promise.withResolvers<boolean>();
        } catch {
          waiting.resolve(false);
        }
      }
    } finally {
      next?.resolve(false);
      next = null;
      draining = false;
    }
  }
  return {
    refresh(): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      next ??= Promise.withResolvers<boolean>();
      const result = next.promise;
      if (!draining) {
        draining = true;
        idle = drain();
      }
      return result;
    },
    stopped: () => idle,
  };
}
