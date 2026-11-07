import type { Database } from "bun:sqlite";
import { and, count, eq, lte, sql } from "drizzle-orm";
import { orm } from "./orm";
import { linearRequestBudget, linearRequestReservation } from "./schema";
import { immediate } from "./tx";
import { ulid } from "./ulid";

export type LinearBudgetRow = {
  windowStartMs: number;
  spent: number;
  holdUntilMs: number | null;
  requestLimit: number | null;
};

const columns = {
  windowStartMs: linearRequestBudget.windowStart,
  spent: linearRequestBudget.spent,
  holdUntilMs: linearRequestBudget.holdUntil,
  requestLimit: linearRequestBudget.requestLimit,
};

export function linearBudgetStore(db: Database, workspace: string) {
  const handle = orm(db);
  return {
    read(): LinearBudgetRow | null {
      return (
        handle
          .select(columns)
          .from(linearRequestBudget)
          .where(eq(linearRequestBudget.workspace, workspace))
          .get() ?? null
      );
    },
    spend(
      now: number,
      windowMs: number,
      limit: number | null,
      share: number,
      ttlMs: number,
    ): string | null {
      const t = linearRequestBudget;
      const r = linearRequestReservation;
      return immediate(db, () => {
        handle
          .delete(r)
          .where(and(eq(r.workspace, workspace), lte(r.expiresAt, now)))
          .run();
        const row = handle.select(columns).from(t).where(eq(t.workspace, workspace)).get();
        if (row?.holdUntilMs != null && row.holdUntilMs > now) return null;
        const expired = row === undefined || row.windowStartMs + windowMs <= now;
        const inFlight = handle
          .select({ n: count() })
          .from(r)
          .where(eq(r.workspace, workspace))
          .get()!.n;
        const known = limit ?? row?.requestLimit ?? null;
        const used = (expired ? 0 : row.spent) + inFlight;
        if (known !== null && used >= Math.floor(known * share)) return null;
        if (expired)
          handle
            .insert(t)
            .values({ workspace, windowStart: now, spent: 0, holdUntil: null, requestLimit: limit })
            .onConflictDoUpdate({ target: t.workspace, set: { windowStart: now, spent: 0 } })
            .run();
        const id = ulid(now);
        handle
          .insert(r)
          .values({ id, workspace, expiresAt: now + ttlMs })
          .run();
        return id;
      });
    },
    release(id: string, now: number, windowMs: number, counted: boolean): void {
      const t = linearRequestBudget;
      immediate(db, () => {
        handle.delete(linearRequestReservation).where(eq(linearRequestReservation.id, id)).run();
        if (!counted)
          handle
            .update(t)
            .set({ spent: sql`${t.spent} + 1` })
            .where(and(eq(t.workspace, workspace), sql`${t.windowStart} + ${windowMs} > ${now}`))
            .run();
      });
    },
    sync(
      now: number,
      windowMs: number,
      limit: number,
      window: { startMs: number; spent: number } | null,
    ): void {
      const t = linearRequestBudget;
      const current = window !== null && window.startMs + windowMs > now;
      const newer =
        window === null
          ? sql`0`
          : sql`(${t.windowStart} + ${windowMs} <= ${now} OR ${t.windowStart} < ${window.startMs})`;
      handle
        .insert(t)
        .values({
          workspace,
          windowStart: current ? window.startMs : now,
          spent: current ? window.spent : 0,
          requestLimit: limit,
        })
        .onConflictDoUpdate({
          target: t.workspace,
          set: current
            ? {
                requestLimit: limit,
                windowStart: sql`CASE WHEN ${newer} THEN ${window.startMs} ELSE MIN(${t.windowStart}, ${window.startMs}) END`,
                spent: sql`CASE WHEN ${newer} THEN ${window.spent} ELSE MAX(${t.spent}, ${window.spent}) END`,
              }
            : { requestLimit: limit },
        })
        .run();
    },
    hold(now: number, untilMs: number): void {
      handle
        .insert(linearRequestBudget)
        .values({ workspace, windowStart: now, spent: 0, holdUntil: untilMs })
        .onConflictDoUpdate({
          target: linearRequestBudget.workspace,
          set: {
            holdUntil: sql`MAX(COALESCE(${linearRequestBudget.holdUntil}, 0), excluded.hold_until)`,
          },
        })
        .run();
    },
  };
}
