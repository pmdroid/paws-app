import { and, eq, isNull, or } from "drizzle-orm";
import { type Db, type Q, type Steps } from "./db";
import { ulid } from "./ulid";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type * as schema from "./schema-pg";

export type ThreadSurfaceKind = "slack" | "buzz";
export type ThreadContextKind = "thread" | "private" | "code_channel" | "project_hub";

export type ThreadScope = {
  workspaceId: string;
  surface: ThreadSurfaceKind;
  installationId: string;
};

export type ThreadPlace = {
  kind: ThreadContextKind;
  channelId: string;
  threadId?: string | null;
  privateMember?: string | null;
};

export type ThreadContextRecord = ThreadScope & {
  id: string;
  kind: ThreadContextKind;
  channelId: string;
  threadId: string | null;
  privateMember: string | null;
  taskId: string;
  actor: string;
  createdAt: number;
};

export type ThreadTaskRecord = ThreadScope & {
  id: string;
  privateMember: string | null;
  primaryContextId: string;
  createdBy: string;
  createdByUserId: string | null;
  repository: string | null;
  sourceRef: string | null;
  sourceCommit: string | null;
  sourceSetBy: string | null;
  linearIssueId: string | null;
  issueAttachedAt: number | null;
  delegationId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ThreadActor = { actor: string; actorUserId?: string | null; now: number };

export type ResolvedThread = {
  task: ThreadTaskRecord;
  context: ThreadContextRecord;
  created: boolean;
};

const blank = (value: string | null | undefined) => value ?? "";
const orNull = (value: string) => (value === "" ? null : value);

function placeKey(place: ThreadPlace) {
  const privateMember = blank(place.privateMember);
  if ((place.kind === "private") !== (privateMember !== ""))
    throw new Error("A private conversation names its member, and only a private one does.");
  const threadId = place.kind === "code_channel" ? "" : blank(place.threadId);
  if (place.kind === "thread" && threadId === "")
    throw new Error("A channel thread needs its root message id.");
  return { channelId: place.channelId, threadId, privateMember };
}

type ScopedTable = { workspaceId: AnyPgColumn; surface: AnyPgColumn; installationId: AnyPgColumn };

function scopeWhere(table: ScopedTable, scope: ThreadScope) {
  return and(
    eq(table.workspaceId, scope.workspaceId),
    eq(table.surface, scope.surface),
    eq(table.installationId, scope.installationId),
  );
}

function contextRecord(row: typeof schema.threadContext.$inferSelect) {
  return {
    ...row,
    surface: row.surface as ThreadSurfaceKind,
    kind: row.kind as ThreadContextKind,
    threadId: orNull(row.threadId),
    privateMember: orNull(row.privateMember),
  };
}

function taskRecord(row: typeof schema.threadTask.$inferSelect): ThreadTaskRecord {
  return {
    ...row,
    surface: row.surface as ThreadSurfaceKind,
    privateMember: orNull(row.privateMember),
  };
}

function* contextAtSteps(q: Q, scope: ThreadScope, key: ReturnType<typeof placeKey>) {
  const { threadContext: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(c)
      .where(
        and(
          scopeWhere(c, scope),
          eq(c.channelId, key.channelId),
          eq(c.threadId, key.threadId),
          eq(c.privateMember, key.privateMember),
        ),
      ),
  );
  return row === undefined ? null : contextRecord(row);
}

function* codeChannelSteps(q: Q, scope: ThreadScope, channelId: string) {
  const { threadContext: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(c)
      .where(and(scopeWhere(c, scope), eq(c.channelId, channelId), eq(c.kind, "code_channel"))),
  );
  return row === undefined ? null : contextRecord(row);
}

export function* getThreadTaskSteps(
  q: Q,
  scope: ThreadScope,
  taskId: string,
): Steps<ThreadTaskRecord | null> {
  const { threadTask: t } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(t)
      .where(and(scopeWhere(t, scope), eq(t.id, taskId))),
  );
  return row === undefined ? null : taskRecord(row);
}

export async function getThreadTask(store: Db, scope: ThreadScope, taskId: string) {
  return store.run((q) => getThreadTaskSteps(q, scope, taskId));
}

export function* threadContextsSteps(q: Q, scope: ThreadScope, taskId: string) {
  const { threadContext: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(c)
      .where(and(scopeWhere(c, scope), eq(c.taskId, taskId)))
      .orderBy(c.createdAt, c.id),
  );
  return rows.map(contextRecord);
}

export async function threadContexts(store: Db, scope: ThreadScope, taskId: string) {
  return store.run((q) => threadContextsSteps(q, scope, taskId));
}

export function* findThreadSteps(q: Q, scope: ThreadScope, place: ThreadPlace) {
  const key = placeKey(place);
  const context =
    (yield* contextAtSteps(q, scope, key)) ??
    (key.privateMember === "" ? yield* codeChannelSteps(q, scope, key.channelId) : null);
  if (context === null) return null;
  const task = yield* getThreadTaskSteps(q, scope, context.taskId);
  return task === null ? null : { task, context };
}

export function* resolveThreadSteps(
  q: Q,
  scope: ThreadScope,
  place: ThreadPlace,
  actor: ThreadActor,
): Steps<ResolvedThread> {
  if (place.kind === "project_hub")
    throw new Error("A project hub links an existing task; it does not start one.");
  const found = yield* findThreadSteps(q, scope, place);
  if (found !== null) return { ...found, created: false };
  const key = placeKey(place);
  const taskId = ulid(actor.now);
  const contextId = ulid(actor.now);
  const { threadTask: t, threadContext: c } = q.t;
  yield* q.exec(
    q.orm.insert(t).values({
      id: taskId,
      ...scope,
      privateMember: key.privateMember,
      primaryContextId: contextId,
      createdBy: actor.actor,
      createdByUserId: actor.actorUserId ?? null,
      createdAt: actor.now,
      updatedAt: actor.now,
    }),
  );
  const inserted = yield* q.one(
    q.orm
      .insert(c)
      .values({
        id: contextId,
        ...scope,
        kind: place.kind,
        ...key,
        taskId,
        actor: actor.actor,
        createdAt: actor.now,
      })
      .onConflictDoNothing()
      .returning({ id: c.id }),
  );
  if (inserted === undefined) {
    yield* q.exec(q.orm.delete(t).where(eq(t.id, taskId)));
    const raced = yield* findThreadSteps(q, scope, place);
    if (raced === null) throw new Error("The thread mapping was claimed but cannot be read.");
    return { ...raced, created: false };
  }
  const task = (yield* getThreadTaskSteps(q, scope, taskId))!;
  const context = (yield* contextAtSteps(q, scope, key))!;
  return { task, context, created: true };
}

export async function resolveThread(
  store: Db,
  scope: ThreadScope,
  place: ThreadPlace,
  actor: ThreadActor,
): Promise<ResolvedThread> {
  return store.transaction((q) => resolveThreadSteps(q, scope, place, actor));
}

export function* linkThreadContextSteps(
  q: Q,
  scope: ThreadScope,
  taskId: string,
  place: ThreadPlace,
  actor: ThreadActor & { primary?: boolean },
): Steps<ThreadContextRecord> {
  const task = yield* getThreadTaskSteps(q, scope, taskId);
  if (task === null) throw new Error(`No thread task ${taskId} in this installation.`);
  if (place.kind === "private" || place.kind === "thread")
    throw new Error("A task keeps the conversation it started in; link a Code channel or hub.");
  if (task.privateMember !== null && task.privateMember !== actor.actor)
    throw new Error("Only the member of a private conversation can move it to a shared channel.");
  const key = placeKey(place);
  const existing =
    (yield* contextAtSteps(q, scope, key)) ??
    (place.kind === "code_channel" ? yield* codeChannelSteps(q, scope, key.channelId) : null);
  if (existing !== null && existing.taskId !== taskId)
    throw new Error("That channel already belongs to another task.");
  const { threadTask: t, threadContext: c } = q.t;
  const context =
    existing ??
    contextRecord(
      (yield* q.one(
        q.orm
          .insert(c)
          .values({
            id: ulid(actor.now),
            ...scope,
            kind: place.kind,
            ...key,
            taskId,
            actor: actor.actor,
            createdAt: actor.now,
          })
          .returning(),
      ))!,
    );
  if (actor.primary ?? place.kind === "code_channel")
    yield* q.exec(
      q.orm
        .update(t)
        .set({ primaryContextId: context.id, updatedAt: actor.now })
        .where(eq(t.id, taskId)),
    );
  return context;
}

export async function linkThreadContext(
  store: Db,
  scope: ThreadScope,
  taskId: string,
  place: ThreadPlace,
  actor: ThreadActor & { primary?: boolean },
): Promise<ThreadContextRecord> {
  return store.transaction((q) => linkThreadContextSteps(q, scope, taskId, place, actor));
}

export function* primaryThreadContextSteps(q: Q, scope: ThreadScope, taskId: string) {
  const task = yield* getThreadTaskSteps(q, scope, taskId);
  if (task === null) return null;
  const { threadContext: c } = q.t;
  const row = yield* q.one(q.orm.select().from(c).where(eq(c.id, task.primaryContextId)));
  return row === undefined ? null : { task, context: contextRecord(row) };
}

export type ThreadSource = { repository: string; ref: string | null; commit: string | null };

export async function setThreadSource(
  store: Db,
  scope: ThreadScope,
  taskId: string,
  source: ThreadSource | null,
  actor: ThreadActor,
): Promise<boolean> {
  return store.transaction(function* (q) {
    const { threadTask: t } = q.t;
    const updated = yield* q.all(
      q.orm
        .update(t)
        .set({
          repository: source?.repository ?? null,
          sourceRef: source?.ref ?? null,
          sourceCommit: source?.commit ?? null,
          sourceSetBy: source === null ? null : actor.actor,
          updatedAt: actor.now,
        })
        .where(and(scopeWhere(t, scope), eq(t.id, taskId)))
        .returning({ id: t.id }),
    );
    return updated.length === 1;
  });
}

export async function reserveThreadIssue(
  store: Db,
  scope: ThreadScope,
  taskId: string,
  now: number,
): Promise<string> {
  return store.transaction(function* (q) {
    const { threadTask: t } = q.t;
    yield* q.exec(
      q.orm
        .update(t)
        .set({ linearIssueId: crypto.randomUUID(), updatedAt: now })
        .where(and(scopeWhere(t, scope), eq(t.id, taskId), isNull(t.linearIssueId))),
    );
    const task = yield* getThreadTaskSteps(q, scope, taskId);
    if (task?.linearIssueId == null) throw new Error(`No thread task ${taskId} to reserve.`);
    return task.linearIssueId;
  });
}

export async function attachThreadIssue(
  store: Db,
  scope: ThreadScope,
  taskId: string,
  input: { linearIssueId: string; delegationId: string; now: number },
): Promise<ThreadTaskRecord> {
  return store.transaction(function* (q) {
    const { threadTask: t } = q.t;
    yield* q.exec(
      q.orm
        .update(t)
        .set({
          linearIssueId: input.linearIssueId,
          delegationId: input.delegationId,
          issueAttachedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            scopeWhere(t, scope),
            eq(t.id, taskId),
            isNull(t.issueAttachedAt),
            or(isNull(t.linearIssueId), eq(t.linearIssueId, input.linearIssueId)),
          ),
        ),
    );
    const task = yield* getThreadTaskSteps(q, scope, taskId);
    if (task === null) throw new Error(`No thread task ${taskId} to attach.`);
    if (task.linearIssueId !== input.linearIssueId || task.delegationId !== input.delegationId)
      throw new Error(`Thread task ${taskId} already has its own Linear issue.`);
    return task;
  });
}

export async function threadTaskForIssue(
  store: Db,
  workspaceId: string,
  linearIssueId: string,
): Promise<ThreadTaskRecord | null> {
  return store.run(function* (q) {
    const { threadTask: t } = q.t;
    const row = yield* q.one(
      q.orm
        .select()
        .from(t)
        .where(and(eq(t.workspaceId, workspaceId), eq(t.linearIssueId, linearIssueId))),
    );
    return row === undefined ? null : taskRecord(row);
  });
}
