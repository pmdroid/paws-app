import { eq } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

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

export async function saveOpenFindings(store: Db, input: OpenFindings): Promise<void> {
  await store.run((q) => saveOpenFindingsSteps(q, input));
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

export async function getPublishedHead(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => getPublishedHeadSteps(q, itemId));
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

export async function withOpenFindings(store: Db, itemId: string, body: string): Promise<string> {
  return store.run((q) => withOpenFindingsSteps(q, itemId, body));
}
