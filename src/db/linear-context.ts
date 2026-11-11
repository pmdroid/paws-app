import { asc, eq, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { getLinearIssueContextSteps } from "./linear-issue-context";

export function* saveLinearSessionContextSteps(
  q: Q,
  sessionId: string,
  context: string,
  richness = 1,
) {
  if (!context) return;
  const { linearSessionContext } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearSessionContext)
      .values({ sessionId, context, richness })
      .onConflictDoUpdate({
        target: linearSessionContext.sessionId,
        set: { context: sql`excluded.context`, richness: sql`excluded.richness` },
        setWhere: sql`excluded.richness > linear_session_context.richness`,
      }),
  );
}

export async function saveLinearSessionContext(
  store: Db,
  sessionId: string,
  context: string,
  richness = 1,
): Promise<void> {
  await store.run((q) => saveLinearSessionContextSteps(q, sessionId, context, richness));
}

function* sessionContextSteps(q: Q, sessionId: string) {
  const { linearSessionContext } = q.t;
  return yield* q.one(
    q.orm
      .select({
        context: linearSessionContext.context,
        snapshotContext: linearSessionContext.snapshotContext,
      })
      .from(linearSessionContext)
      .where(eq(linearSessionContext.sessionId, sessionId)),
  );
}

export function* getLinearSessionContextSteps(q: Q, sessionId: string) {
  const row = yield* sessionContextSteps(q, sessionId);
  const issueContext = yield* getLinearIssueContextSteps(q, sessionId);
  return [row?.context, row?.snapshotContext, issueContext].filter(Boolean).join("\n\n");
}

export async function getLinearSessionContext(store: Db, sessionId: string): Promise<string> {
  return store.run((q) => getLinearSessionContextSteps(q, sessionId));
}

export function* hasLinearSessionSnapshotContextSteps(q: Q, sessionId: string) {
  const row = yield* sessionContextSteps(q, sessionId);
  return row !== undefined && row.snapshotContext !== null;
}

export async function hasLinearSessionSnapshotContext(
  store: Db,
  sessionId: string,
): Promise<boolean> {
  return store.run((q) => hasLinearSessionSnapshotContextSteps(q, sessionId));
}

export function* saveLinearSessionSnapshotContextSteps(q: Q, sessionId: string, context: string) {
  const { linearSessionContext } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearSessionContext)
      .values({ sessionId, context: "", richness: -1, snapshotContext: context })
      .onConflictDoUpdate({
        target: linearSessionContext.sessionId,
        set: {
          snapshotContext: sql`COALESCE(linear_session_context.snapshot_context, excluded.snapshot_context)`,
        },
      }),
  );
}

export async function saveLinearSessionSnapshotContext(
  store: Db,
  sessionId: string,
  context: string,
): Promise<void> {
  await store.run((q) => saveLinearSessionSnapshotContextSteps(q, sessionId, context));
}

type LinearActivitySnapshotInput = {
  id: string;
  sessionId: string;
  createdAt: string;
  snapshot: string;
};

export function* saveLinearActivitySnapshotSteps(q: Q, input: LinearActivitySnapshotInput) {
  const snapshot = q.dialect === "sqlite" ? input.snapshot : sql`${input.snapshot}::jsonb`;
  yield* q.exec(
    q.orm
      .insert(q.t.linearActivitySnapshot)
      .values({ ...input, snapshot })
      .onConflictDoNothing({ target: q.t.linearActivitySnapshot.id }),
  );
}

export async function saveLinearActivitySnapshot(
  store: Db,
  input: LinearActivitySnapshotInput,
): Promise<void> {
  await store.run((q) => saveLinearActivitySnapshotSteps(q, input));
}

export function* listLinearActivitySnapshotsSteps(q: Q, sessionId: string) {
  const { linearActivitySnapshot } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ snapshot: linearActivitySnapshot.snapshot })
      .from(linearActivitySnapshot)
      .where(eq(linearActivitySnapshot.sessionId, sessionId))
      .orderBy(asc(linearActivitySnapshot.createdAt), asc(linearActivitySnapshot.id)),
  );
  return rows.map((row) =>
    q.dialect === "sqlite" ? (row.snapshot as string) : JSON.stringify(row.snapshot),
  );
}

export async function listLinearActivitySnapshots(
  store: Db,
  sessionId: string,
): Promise<readonly string[]> {
  return store.run((q) => listLinearActivitySnapshotsSteps(q, sessionId));
}
