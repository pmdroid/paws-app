import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { orm } from "./orm";
import { openFindings } from "./schema";

/**
 * Records what was still open at the item's last published head: the line the final Linear
 * response carries, already escaped. An empty line means nothing was open. Each publication
 * replaces it.
 */
export function saveOpenFindings(
  db: Database,
  input: { itemId: string; head: string; line: string; now: number },
): void {
  const values = { headSha: input.head, line: input.line, recordedAt: input.now };
  orm(db)
    .insert(openFindings)
    .values({ itemId: input.itemId, ...values })
    .onConflictDoUpdate({ target: openFindings.itemId, set: values })
    .run();
}

export function getPublishedHead(db: Database, itemId: string): string | null {
  return (
    orm(db)
      .select({ head: openFindings.headSha })
      .from(openFindings)
      .where(eq(openFindings.itemId, itemId))
      .get()?.head ?? null
  );
}

/** The open-findings line of the item's last published head, or null when nothing was open. */
export function getOpenFindingsLine(db: Database, itemId: string): string | null {
  const row = orm(db)
    .select({ line: openFindings.line })
    .from(openFindings)
    .where(eq(openFindings.itemId, itemId))
    .get();
  return row?.line ? row.line : null;
}

/** A final response with the open-findings line of the item's last published head after it. */
export function withOpenFindings(db: Database, itemId: string, body: string): string {
  const line = getOpenFindingsLine(db, itemId);
  return line === null ? body : `${body}\n\n${line}`;
}
