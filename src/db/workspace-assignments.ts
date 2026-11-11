import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";

export type WorkspaceAssignmentStatus = "pending" | "ready" | "accepted" | "continued" | "invalid";

/** A delegation held until its creator signs in. `event` is the verified event's JSON text. */
export type WorkspaceAssignmentHold = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  actorId: string;
  tokenHash: string;
  linkId: string | null;
  linkExpiresAt: number | null;
  fingerprint: string;
  event: string;
  expiresAt: number;
  status: WorkspaceAssignmentStatus;
};

function holdColumns(q: Q) {
  const hold = q.t.workspaceAssignment;
  return {
    sessionId: hold.sessionId,
    generation: hold.generation,
    workspaceId: hold.workspaceId,
    actorId: hold.actorId,
    tokenHash: hold.tokenHash,
    linkId: hold.linkId,
    linkExpiresAt: hold.linkExpiresAt,
    fingerprint: hold.fingerprint,
    event: jsonText(q, hold.event),
    expiresAt: hold.expiresAt,
    status: sql<WorkspaceAssignmentStatus>`${hold.status}`,
  };
}

export function* latestWorkspaceAssignmentSteps(
  q: Q,
  sessionId: string,
): Steps<WorkspaceAssignmentHold | null> {
  const { workspaceAssignment: hold } = q.t;
  const row = yield* q.one(
    q.orm
      .select(holdColumns(q))
      .from(hold)
      .where(eq(hold.sessionId, sessionId))
      .orderBy(desc(hold.generation))
      .limit(1),
  );
  return row ?? null;
}

export async function latestWorkspaceAssignment(
  store: Db,
  sessionId: string,
): Promise<WorkspaceAssignmentHold | null> {
  return store.run((q) => latestWorkspaceAssignmentSteps(q, sessionId));
}

export function* workspaceAssignmentByTokenSteps(
  q: Q,
  tokenHash: string,
): Steps<WorkspaceAssignmentHold | null> {
  const { workspaceAssignment: hold } = q.t;
  const row = yield* q.one(
    q.orm.select(holdColumns(q)).from(hold).where(eq(hold.tokenHash, tokenHash)),
  );
  return row ?? null;
}

export async function workspaceAssignmentByToken(
  store: Db,
  tokenHash: string,
): Promise<WorkspaceAssignmentHold | null> {
  return store.run((q) => workspaceAssignmentByTokenSteps(q, tokenHash));
}

export function* workspaceAssignmentTokenForLinkSteps(q: Q, linkId: string): Steps<string | null> {
  const { workspaceAssignment: hold } = q.t;
  const row = yield* q.one(
    q.orm.select({ tokenHash: hold.tokenHash }).from(hold).where(eq(hold.linkId, linkId)),
  );
  return row?.tokenHash ?? null;
}

export async function workspaceAssignmentTokenForLink(
  store: Db,
  linkId: string,
): Promise<string | null> {
  return store.run((q) => workspaceAssignmentTokenForLinkSteps(q, linkId));
}

type PendingAssignments = { linked: boolean } | { workspaceId: string; actorId: string };

/** Token hashes of pending holds, either with or without a link, or one person's in a workspace. */
export function* pendingWorkspaceAssignmentTokensSteps(
  q: Q,
  scope: PendingAssignments,
): Steps<string[]> {
  const { workspaceAssignment: hold } = q.t;
  const filter =
    "linked" in scope
      ? scope.linked
        ? isNotNull(hold.linkId)
        : isNull(hold.linkId)
      : and(eq(hold.workspaceId, scope.workspaceId), eq(hold.actorId, scope.actorId));
  const rows = yield* q.all(
    q.orm
      .select({ tokenHash: hold.tokenHash })
      .from(hold)
      .where(and(eq(hold.status, "pending"), filter)),
  );
  return rows.map((row) => row.tokenHash);
}

export async function pendingWorkspaceAssignmentTokens(
  store: Db,
  scope: PendingAssignments,
): Promise<string[]> {
  return store.run((q) => pendingWorkspaceAssignmentTokensSteps(q, scope));
}

type NewWorkspaceAssignment = Omit<WorkspaceAssignmentHold, "status" | "linkId"> & {
  linkId: string;
};

/** Writes a pending hold. False when this session generation already has one. */
export function* insertWorkspaceAssignmentSteps(q: Q, row: NewWorkspaceAssignment): Steps<boolean> {
  const { workspaceAssignment: hold } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(hold)
      .values({ ...row, event: jsonFromText(q, row.event), status: "pending" })
      .onConflictDoNothing({ target: [hold.sessionId, hold.generation] })
      .returning({ tokenHash: hold.tokenHash }),
  );
  return inserted.length === 1;
}

export async function insertWorkspaceAssignment(
  store: Db,
  row: NewWorkspaceAssignment,
): Promise<boolean> {
  return store.run((q) => insertWorkspaceAssignmentSteps(q, row));
}

/** Ends a hold that has not yet continued. */
export function* invalidateWorkspaceAssignmentSteps(q: Q, tokenHash: string): Steps<void> {
  const { workspaceAssignment: hold } = q.t;
  yield* q.exec(
    q.orm
      .update(hold)
      .set({ status: "invalid" })
      .where(
        and(eq(hold.tokenHash, tokenHash), inArray(hold.status, ["pending", "ready", "accepted"])),
      ),
  );
}

export async function invalidateWorkspaceAssignment(store: Db, tokenHash: string): Promise<void> {
  await store.run((q) => invalidateWorkspaceAssignmentSteps(q, tokenHash));
}

type AssignmentMove =
  | { from: "pending"; to: "ready"; completedAt: number }
  | { from: "ready"; to: "accepted" }
  | { from: "accepted"; to: "continued" };

/** Moves a hold one status forward, only while it is still in `from`. */
export function* moveWorkspaceAssignmentSteps(
  q: Q,
  tokenHash: string,
  move: AssignmentMove,
): Steps<void> {
  const { workspaceAssignment: hold } = q.t;
  yield* q.exec(
    q.orm
      .update(hold)
      .set({ status: move.to, ...("completedAt" in move ? { completedAt: move.completedAt } : {}) })
      .where(and(eq(hold.tokenHash, tokenHash), eq(hold.status, move.from))),
  );
}

export async function moveWorkspaceAssignment(
  store: Db,
  tokenHash: string,
  move: AssignmentMove,
): Promise<void> {
  await store.run((q) => moveWorkspaceAssignmentSteps(q, tokenHash, move));
}

/** Gives a pending hold written before link ids existed its link and new token hash. */
export function* linkWorkspaceAssignmentSteps(
  q: Q,
  tokenHash: string,
  link: { linkId: string; expiresAt: number; tokenHash: string },
): Steps<void> {
  const { workspaceAssignment: hold } = q.t;
  yield* q.exec(
    q.orm
      .update(hold)
      .set({
        linkId: link.linkId,
        linkExpiresAt: link.expiresAt,
        expiresAt: link.expiresAt,
        tokenHash: link.tokenHash,
      })
      .where(and(eq(hold.tokenHash, tokenHash), eq(hold.status, "pending"), isNull(hold.linkId))),
  );
}

export async function linkWorkspaceAssignment(
  store: Db,
  tokenHash: string,
  link: { linkId: string; expiresAt: number; tokenHash: string },
): Promise<void> {
  await store.run((q) => linkWorkspaceAssignmentSteps(q, tokenHash, link));
}
