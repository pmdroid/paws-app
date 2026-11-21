import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Q, Steps } from "./db";
import type { notebookChange, notebookEntry } from "./schema-pg";
import { ulid } from "./ulid";

export type NotebookScopeKind = "repository" | "project";

export type NotebookScope = {
  readonly workspaceId: string;
  readonly kind: NotebookScopeKind;
  readonly id: string;
};

export type NotebookEntryRow = typeof notebookEntry.$inferSelect;

export type NotebookChangeRow = Omit<typeof notebookChange.$inferSelect, "action"> & {
  action: "add" | "patch" | "remove";
};

export type NotebookWrite =
  | { readonly action: "add"; readonly entryId?: string; readonly body: string }
  | {
      readonly action: "patch";
      readonly entryId: string;
      readonly before: string;
      readonly body: string;
    }
  | { readonly action: "remove"; readonly entryId: string; readonly before: string };

type ScopeColumns = { workspaceId: PgColumn; scopeKind: PgColumn; scopeId: PgColumn };

function scoped(table: ScopeColumns, scope: NotebookScope, more?: SQL) {
  return and(
    eq(table.workspaceId, scope.workspaceId),
    eq(table.scopeKind, scope.kind),
    eq(table.scopeId, scope.id),
    more,
  );
}

function columns(scope: NotebookScope) {
  return { workspaceId: scope.workspaceId, scopeKind: scope.kind, scopeId: scope.id };
}

export function* lockNotebookSteps(q: Q, scope: NotebookScope, now: number): Steps<void> {
  const { notebook } = q.t;
  yield* q.exec(
    q.orm
      .insert(notebook)
      .values({ ...columns(scope), revision: 0, updatedAt: now })
      .onConflictDoNothing(),
  );
  yield* q.all(
    q.orm
      .select({ revision: notebook.revision })
      .from(notebook)
      .where(scoped(notebook, scope))
      .for("update"),
  );
}

export function* notebookStateSteps(
  q: Q,
  scope: NotebookScope,
): Steps<{ revision: number; entries: NotebookEntryRow[] }> {
  const { notebook, notebookEntry: entry } = q.t;
  const row = yield* q.one(
    q.orm.select({ revision: notebook.revision }).from(notebook).where(scoped(notebook, scope)),
  );
  const entries = yield* q.all(
    q.orm.select().from(entry).where(scoped(entry, scope)).orderBy(asc(entry.id)),
  );
  return { revision: row?.revision ?? 0, entries };
}

export function* notebookChangesSteps(
  q: Q,
  scope: NotebookScope,
  query: { readonly limit: number } | { readonly id: string },
): Steps<NotebookChangeRow[]> {
  const { notebookChange: change } = q.t;
  const select = q.orm.select().from(change);
  const rows =
    "id" in query
      ? yield* q.all(select.where(scoped(change, scope, eq(change.id, query.id))))
      : yield* q.all(
          select.where(scoped(change, scope)).orderBy(desc(change.id)).limit(query.limit),
        );
  return rows as NotebookChangeRow[];
}

export function* writeNotebookSteps(
  q: Q,
  scope: NotebookScope,
  input: {
    readonly writes: readonly NotebookWrite[];
    readonly itemId: string | null;
    readonly actorId: string | null;
    readonly now: number;
  },
): Steps<NotebookChangeRow[]> {
  const { notebook, notebookEntry: entry, notebookChange } = q.t;
  const { now, itemId, actorId } = input;
  const ids = input.writes.map(() => ulid(now)).sort();
  const entryIds = input.writes.map(() => ulid(now)).sort();
  const changes: NotebookChangeRow[] = [];
  const at = { ...columns(scope), itemId, actorId, at: now };
  for (const [index, write] of input.writes.entries()) {
    const entryId = write.action === "add" ? (write.entryId ?? entryIds[index]!) : write.entryId;
    const where = scoped(entry, scope, eq(entry.id, entryId));
    if (write.action === "add")
      yield* q.exec(
        q.orm.insert(entry).values({
          ...columns(scope),
          id: entryId,
          body: write.body,
          createdAt: now,
          updatedAt: now,
        }),
      );
    else if (write.action === "patch")
      yield* q.exec(q.orm.update(entry).set({ body: write.body, updatedAt: now }).where(where));
    else yield* q.exec(q.orm.delete(entry).where(where));
    changes.push({
      id: ids[index]!,
      entryId,
      action: write.action,
      before: write.action === "add" ? null : write.before,
      after: write.action === "remove" ? null : write.body,
      ...at,
    });
  }
  yield* q.exec(q.orm.insert(notebookChange).values(changes));
  yield* q.exec(
    q.orm
      .update(notebook)
      .set({ revision: sql`${notebook.revision} + 1`, updatedAt: now })
      .where(scoped(notebook, scope)),
  );
  return changes;
}

export function* workspaceNotebooksSteps(
  q: Q,
  workspaceId: string,
): Steps<{ kind: NotebookScopeKind; id: string; size: number }[]> {
  const { notebook, notebookEntry: entry } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ kind: notebook.scopeKind, id: notebook.scopeId })
      .from(notebook)
      .where(eq(notebook.workspaceId, workspaceId))
      .orderBy(asc(notebook.scopeKind), asc(notebook.scopeId)),
  );
  const bodies = yield* q.all(
    q.orm
      .select({ kind: entry.scopeKind, id: entry.scopeId, body: entry.body })
      .from(entry)
      .where(eq(entry.workspaceId, workspaceId)),
  );
  const sizes = new Map<string, number>();
  for (const row of bodies) {
    const key = `${row.kind}:${row.id}`;
    sizes.set(key, (sizes.get(key) ?? 0) + row.body.length);
  }
  return rows.map((row) => ({
    kind: row.kind as NotebookScopeKind,
    id: row.id,
    size: sizes.get(`${row.kind}:${row.id}`) ?? 0,
  }));
}

export function* workItemProjectsSteps(
  q: Q,
  input: { readonly projectIds: readonly string[]; readonly ownerUserId?: string },
): Steps<{ id: string; name: string | null }[]> {
  if (input.projectIds.length === 0) return [];
  const { workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ id: workItem.linearProjectId, name: workItem.linearProjectName })
      .from(workItem)
      .where(
        and(
          inArray(workItem.linearProjectId, [...input.projectIds]),
          input.ownerUserId === undefined ? undefined : eq(workItem.ownerUserId, input.ownerUserId),
        ),
      ),
  );
  return rows.flatMap((row) => (row.id === null ? [] : [{ id: row.id, name: row.name }]));
}

export function* notebookChangeLabelsSteps(
  q: Q,
  input: { readonly actorIds: string[]; readonly itemIds: string[] },
): Steps<{ actors: Map<string, string>; items: Map<string, string> }> {
  const { workspaceUser: user, workItem: item } = q.t;
  const actors = input.actorIds.length
    ? yield* q.all(q.orm.select().from(user).where(inArray(user.id, input.actorIds)))
    : [];
  const items = input.itemIds.length
    ? yield* q.all(
        q.orm
          .select({ id: item.id, linearIdentifier: item.linearIdentifier })
          .from(item)
          .where(inArray(item.id, input.itemIds)),
      )
    : [];
  return {
    actors: new Map(actors.map((row) => [row.id, row.name])),
    items: new Map(items.map((row) => [row.id, row.linearIdentifier])),
  };
}
