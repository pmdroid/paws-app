import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

type OpenFindings = { itemId: string; head: string; line: string; now: number };

/**
 * Records what was still open at the item's last published head: the line the final Linear
 * response carries, already escaped. An empty line means nothing was open. Each publication
 * replaces it.
 */
export function* saveOpenFindingsSteps(q: Q, input: OpenFindings): Steps<void> {
  const { openFindings } = q.t;
  const values = { headSha: input.head, line: input.line, recordedAt: input.now };
  yield* q.exec(
    q.orm
      .insert(openFindings)
      .values({ itemId: input.itemId, ...values })
      .onConflictDoUpdate({ target: openFindings.itemId, set: values }),
  );
}

export function saveOpenFindings(db: Database, input: OpenFindings): void {
  settled(sqliteDb(db).run((q) => saveOpenFindingsSteps(q, input)));
}

export function* getPublishedHeadSteps(q: Q, itemId: string): Steps<string | null> {
  const { openFindings } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ head: openFindings.headSha })
      .from(openFindings)
      .where(eq(openFindings.itemId, itemId)),
  );
  return row?.head ?? null;
}

export function getPublishedHead(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => getPublishedHeadSteps(q, itemId)));
}

/** The open-findings line of the item's last published head, or null when nothing was open. */
export function* getOpenFindingsLineSteps(q: Q, itemId: string): Steps<string | null> {
  const { openFindings } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ line: openFindings.line })
      .from(openFindings)
      .where(eq(openFindings.itemId, itemId)),
  );
  return row?.line ? row.line : null;
}

/** A final response with the open-findings line of the item's last published head after it. */
export function* withOpenFindingsSteps(q: Q, itemId: string, body: string): Steps<string> {
  const line = yield* getOpenFindingsLineSteps(q, itemId);
  return line === null ? body : `${body}\n\n${line}`;
}

export function withOpenFindings(db: Database, itemId: string, body: string): string {
  return settled(sqliteDb(db).run((q) => withOpenFindingsSteps(q, itemId, body)));
}
