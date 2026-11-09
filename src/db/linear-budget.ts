import { and, count, eq, lte, sql } from "drizzle-orm";
import type { Db } from "./db";
import type { Orm } from "./orm";
import { linearRequestBudget, linearRequestReservation } from "./schema";
import * as pg from "./schema-pg";
import { ulid } from "./ulid";

export type LinearBudgetRow = {
  windowStartMs: number;
  spent: number;
  holdUntilMs: number | null;
  requestLimit: number | null;
};

type Spend = { now: number; windowMs: number; limit: number | null; share: number; ttlMs: number };

const columns = {
  windowStartMs: linearRequestBudget.windowStart,
  spent: linearRequestBudget.spent,
  holdUntilMs: linearRequestBudget.holdUntil,
  requestLimit: linearRequestBudget.requestLimit,
};

const pgColumns = {
  windowStartMs: pg.linearRequestBudget.windowStart,
  spent: pg.linearRequestBudget.spent,
  holdUntilMs: pg.linearRequestBudget.holdUntil,
  requestLimit: pg.linearRequestBudget.requestLimit,
};

function admits(row: LinearBudgetRow | undefined, inFlight: number, spend: Spend) {
  if (row?.holdUntilMs != null && row.holdUntilMs > spend.now) return null;
  const ended = row === undefined || row.windowStartMs + spend.windowMs <= spend.now;
  const known = spend.limit ?? row?.requestLimit ?? null;
  const used = (ended ? 0 : row.spent) + inFlight;
  if (known !== null && used >= Math.floor(known * spend.share)) return null;
  return { ended };
}

export function linearBudgetStore(db: Db, workspace: string) {
  const sqliteSpend = (handle: Orm, spend: Spend): string | null =>
    handle.transaction(
      (tx) => {
        const r = linearRequestReservation;
        tx.delete(r)
          .where(and(eq(r.workspace, workspace), lte(r.expiresAt, spend.now)))
          .run();
        const row = tx
          .select(columns)
          .from(linearRequestBudget)
          .where(eq(linearRequestBudget.workspace, workspace))
          .get();
        const inFlight = tx
          .select({ n: count() })
          .from(r)
          .where(eq(r.workspace, workspace))
          .get()!.n;
        const admitted = admits(row, inFlight, spend);
        if (admitted === null) return null;
        if (admitted.ended)
          tx.insert(linearRequestBudget)
            .values({ workspace, windowStart: spend.now, spent: 0, requestLimit: spend.limit })
            .onConflictDoUpdate({
              target: linearRequestBudget.workspace,
              set: { windowStart: spend.now, spent: 0 },
            })
            .run();
        const id = ulid(spend.now);
        tx.insert(r)
          .values({ id, workspace, expiresAt: spend.now + spend.ttlMs })
          .run();
        return id;
      },
      { behavior: "immediate" },
    );

  return {
    read(): Promise<LinearBudgetRow | null> {
      if (db.dialect === "sqlite")
        return db.sync(
          (handle) =>
            handle
              .select(columns)
              .from(linearRequestBudget)
              .where(eq(linearRequestBudget.workspace, workspace))
              .get() ?? null,
        );
      return db.orm
        .select(pgColumns)
        .from(pg.linearRequestBudget)
        .where(eq(pg.linearRequestBudget.workspace, workspace))
        .then((rows) => rows[0] ?? null);
    },
    spend(spend: Spend): Promise<string | null> {
      if (db.dialect === "sqlite") return db.sync((handle) => sqliteSpend(handle, spend));
      return db.orm.transaction(async (tx) => {
        const t = pg.linearRequestBudget;
        const r = pg.linearRequestReservation;
        await tx
          .insert(t)
          .values({ workspace, windowStart: spend.now, spent: 0, requestLimit: spend.limit })
          .onConflictDoNothing();
        const [row] = await tx
          .select(pgColumns)
          .from(t)
          .where(eq(t.workspace, workspace))
          .for("update");
        await tx.delete(r).where(and(eq(r.workspace, workspace), lte(r.expiresAt, spend.now)));
        const [inFlight] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(r)
          .where(eq(r.workspace, workspace));
        const admitted = admits(row, inFlight?.n ?? 0, spend);
        if (admitted === null) return null;
        if (admitted.ended)
          await tx
            .update(t)
            .set({ windowStart: spend.now, spent: 0 })
            .where(eq(t.workspace, workspace));
        const id = ulid(spend.now);
        await tx.insert(r).values({ id, workspace, expiresAt: spend.now + spend.ttlMs });
        return id;
      });
    },
    release(id: string, now: number, windowMs: number, counted: boolean): Promise<void> {
      if (db.dialect === "sqlite")
        return db.sync((handle) =>
          handle.transaction(
            (tx) => {
              const t = linearRequestBudget;
              tx.delete(linearRequestReservation).where(eq(linearRequestReservation.id, id)).run();
              if (!counted)
                tx.update(t)
                  .set({ spent: sql`${t.spent} + 1` })
                  .where(
                    and(eq(t.workspace, workspace), sql`${t.windowStart} + ${windowMs} > ${now}`),
                  )
                  .run();
            },
            { behavior: "immediate" },
          ),
        );
      return db.orm.transaction(async (tx) => {
        const t = pg.linearRequestBudget;
        await tx.delete(pg.linearRequestReservation).where(eq(pg.linearRequestReservation.id, id));
        if (!counted)
          await tx
            .update(t)
            .set({ spent: sql`${t.spent} + 1` })
            .where(and(eq(t.workspace, workspace), sql`${t.windowStart} + ${windowMs} > ${now}`));
      });
    },
    sync(
      now: number,
      windowMs: number,
      limit: number,
      window: { startMs: number; spent: number } | null,
    ): Promise<void> {
      const current = window !== null && window.startMs + windowMs > now ? window : null;
      const values = {
        workspace,
        windowStart: current?.startMs ?? now,
        spent: current?.spent ?? 0,
        requestLimit: limit,
      };
      if (db.dialect === "sqlite") {
        const t = linearRequestBudget;
        const newer =
          current === null
            ? null
            : sql`(${t.windowStart} + ${windowMs} <= ${now} OR ${t.windowStart} < ${current.startMs})`;
        return db.sync((handle) => {
          handle
            .insert(t)
            .values(values)
            .onConflictDoUpdate({
              target: t.workspace,
              set:
                current === null
                  ? { requestLimit: limit }
                  : {
                      requestLimit: limit,
                      windowStart: sql`CASE WHEN ${newer} THEN ${current.startMs} ELSE MIN(${t.windowStart}, ${current.startMs}) END`,
                      spent: sql`CASE WHEN ${newer} THEN ${current.spent} ELSE MAX(${t.spent}, ${current.spent}) END`,
                    },
            })
            .run();
        });
      }
      const t = pg.linearRequestBudget;
      const newer =
        current === null
          ? null
          : sql`(${t.windowStart} + ${windowMs} <= ${now} OR ${t.windowStart} < ${current.startMs})`;
      return db.orm
        .insert(t)
        .values(values)
        .onConflictDoUpdate({
          target: t.workspace,
          set:
            current === null
              ? { requestLimit: limit }
              : {
                  requestLimit: limit,
                  windowStart: sql`CASE WHEN ${newer} THEN ${current.startMs} ELSE LEAST(${t.windowStart}, ${current.startMs}) END`,
                  spent: sql`CASE WHEN ${newer} THEN ${current.spent} ELSE GREATEST(${t.spent}, ${current.spent}) END`,
                },
        })
        .then(() => undefined);
    },
    hold(now: number, untilMs: number): Promise<void> {
      const values = { workspace, windowStart: now, spent: 0, holdUntil: untilMs };
      if (db.dialect === "sqlite") {
        const t = linearRequestBudget;
        return db.sync((handle) => {
          handle
            .insert(t)
            .values(values)
            .onConflictDoUpdate({
              target: t.workspace,
              set: { holdUntil: sql`MAX(COALESCE(${t.holdUntil}, 0), excluded.hold_until)` },
            })
            .run();
        });
      }
      const t = pg.linearRequestBudget;
      return db.orm
        .insert(t)
        .values(values)
        .onConflictDoUpdate({
          target: t.workspace,
          set: { holdUntil: sql`GREATEST(COALESCE(${t.holdUntil}, 0), excluded.hold_until)` },
        })
        .then(() => undefined);
    },
  };
}
