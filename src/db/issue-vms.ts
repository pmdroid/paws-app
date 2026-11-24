import { and, count, desc, eq, gt, isNull, max, notInArray, or } from "drizzle-orm";
import { type Q } from "./db";
import { ulid } from "./ulid";

export const ISSUE_VM_PROVIDERS = ["exe-dev", "boat", "instabox", "host"] as const;
export type IssueVmProvider = (typeof ISSUE_VM_PROVIDERS)[number];

export const ISSUE_VM_STATES = [
  "creating",
  "awake",
  "asleep",
  "deleting",
  "deleted",
  "failed",
] as const;
export type IssueVmState = (typeof ISSUE_VM_STATES)[number];

const ENDED_STATES: IssueVmState[] = ["deleted", "failed"];

export type IssueVm = {
  id: string;
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  provider: IssueVmProvider;
  hostRunnerId: string | null;
  runnerId: string | null;
  state: IssueVmState;
  createdAt: number;
  stateAt: number;
  deletedAt: number | null;
};

export type NewIssueVm = {
  id: string;
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  provider: IssueVmProvider;
  hostRunnerId?: string | null;
  now: number;
};

export function* insertIssueVmSteps(q: Q, input: NewIssueVm) {
  const { now, hostRunnerId, ...row } = input;
  yield* q.exec(
    q.orm.insert(q.t.issueVm).values({
      ...row,
      hostRunnerId: hostRunnerId ?? null,
      state: "creating",
      createdAt: now,
      stateAt: now,
    }),
  );
}

export function* issueVmByIdSteps(q: Q, id: string) {
  const { issueVm: v } = q.t;
  const row = yield* q.one(q.orm.select().from(v).where(eq(v.id, id)));
  return (row ?? null) as IssueVm | null;
}

export function* updateLiveIssueVmStateSteps(
  q: Q,
  input: { id: string; state: IssueVmState; now: number },
) {
  const { issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(v)
      .set({
        state: input.state,
        stateAt: input.now,
        ...(input.state === "deleted" ? { deletedAt: input.now } : {}),
      })
      .where(and(eq(v.id, input.id), notInArray(v.state, ENDED_STATES)))
      .returning({ id: v.id }),
  );
  return rows.length;
}

export function* deletingHostIssueVmIdsSteps(q: Q, hostRunnerId: string) {
  const { issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.hostRunnerId, hostRunnerId), eq(v.state, "deleting")))
      .orderBy(v.id),
  );
  return rows.map((row) => row.id);
}

export function* issueVmsInUseSteps(q: Q, input: { workspaceId: string; memberUserId?: string }) {
  const { issueVm: v } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ inUse: count() })
      .from(v)
      .where(
        and(
          eq(v.workspaceId, input.workspaceId),
          notInArray(v.state, ENDED_STATES),
          input.memberUserId === undefined ? undefined : eq(v.memberUserId, input.memberUserId),
        ),
      ),
  );
  return Number(row?.inUse ?? 0);
}

export type NewIssueVmGrant = {
  id?: string;
  workspaceId: string;
  memberUserId: string;
  limit: number;
  endsAt: number;
  grantedBy: string;
  now: number;
};

export function* insertIssueVmGrantSteps(q: Q, input: NewIssueVmGrant) {
  const { now, id = ulid(now), ...row } = input;
  yield* q.exec(q.orm.insert(q.t.issueVmGrant).values({ ...row, id, createdAt: now }));
  return id;
}

export type IssueVmGrant = {
  id: string;
  workspaceId: string;
  memberUserId: string;
  limit: number;
  endsAt: number;
  grantedBy: string;
  createdAt: number;
  revokedAt: number | null;
};

export function* activeIssueVmGrantsSteps(q: Q, input: { workspaceId: string; at: number }) {
  const { issueVmGrant: g } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(g)
      .where(
        and(
          eq(g.workspaceId, input.workspaceId),
          or(isNull(g.revokedAt), gt(g.revokedAt, input.at)),
          gt(g.endsAt, input.at),
        ),
      )
      .orderBy(desc(g.limit), desc(g.endsAt), desc(g.id)),
  );
  return rows as IssueVmGrant[];
}

export function* revokeIssueVmGrantSteps(
  q: Q,
  input: { workspaceId: string; id: string; now: number },
) {
  const { issueVmGrant: g } = q.t;
  const row = yield* q.one(
    q.orm
      .update(g)
      .set({ revokedAt: input.now })
      .where(and(eq(g.id, input.id), eq(g.workspaceId, input.workspaceId), isNull(g.revokedAt)))
      .returning(),
  );
  return (row ?? null) as IssueVmGrant | null;
}

export function* issueVmStateCountsSteps(q: Q, workspaceId: string) {
  const { issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ memberUserId: v.memberUserId, state: v.state, vms: count() })
      .from(v)
      .where(and(eq(v.workspaceId, workspaceId), notInArray(v.state, ENDED_STATES)))
      .groupBy(v.memberUserId, v.state),
  );
  return rows.map((row) => ({ ...row, state: row.state as IssueVmState, vms: Number(row.vms) }));
}

export function* activeIssueVmGrantLimitSteps(
  q: Q,
  input: { workspaceId: string; memberUserId: string; at: number },
) {
  const { issueVmGrant: g } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ limit: max(g.limit) })
      .from(g)
      .where(
        and(
          eq(g.workspaceId, input.workspaceId),
          eq(g.memberUserId, input.memberUserId),
          or(isNull(g.revokedAt), gt(g.revokedAt, input.at)),
          gt(g.endsAt, input.at),
        ),
      ),
  );
  return row?.limit ?? null;
}
