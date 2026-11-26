import { and, count, desc, eq, gt, inArray, isNull, lt, max, notInArray, or } from "drizzle-orm";
import { type Q } from "./db";
import { ulid } from "./ulid";

export const ISSUE_VM_PROVIDERS = ["exe-dev", "boat", "instabox", "host"] as const;
export type IssueVmProvider = (typeof ISSUE_VM_PROVIDERS)[number];

export const ISSUE_VM_STATES = [
  "creating",
  "awake",
  "sleeping",
  "asleep",
  "waking",
  "unknown",
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
  want: "awake" | "asleep";
  deadlineAt: number | null;
  failure: string | null;
  providerRef: string | null;
  generation: number;
};

export type NewIssueVm = {
  id?: string;
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  provider: IssueVmProvider;
  hostRunnerId?: string | null;
  deadlineAt?: number;
  now: number;
};

export function* insertIssueVmSteps(q: Q, input: NewIssueVm) {
  const { now, hostRunnerId, deadlineAt, id = ulid(now), ...row } = input;
  yield* q.exec(
    q.orm.insert(q.t.issueVm).values({
      ...row,
      id,
      hostRunnerId: hostRunnerId ?? null,
      deadlineAt: deadlineAt ?? null,
      state: "creating",
      createdAt: now,
      stateAt: now,
    }),
  );
  return id;
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

export function* lockIssueVmSteps(q: Q, id: string) {
  const { issueVm: v } = q.t;
  const row = yield* q.one(q.orm.select().from(v).where(eq(v.id, id)).for("update"));
  return (row ?? null) as IssueVm | null;
}

export function* liveIssueVmForItemSteps(q: Q, itemId: string) {
  const { issueVm: v } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(v)
      .where(and(eq(v.itemId, itemId), notInArray(v.state, ENDED_STATES))),
  );
  return (row ?? null) as IssueVm | null;
}

export type IssueVmMove = Partial<
  Pick<IssueVm, "deadlineAt" | "failure" | "providerRef" | "runnerId">
> & { state?: IssueVmState };

export function* moveIssueVmSteps(
  q: Q,
  input: { id: string; generation: number; set: IssueVmMove; now: number },
) {
  const { issueVm: v } = q.t;
  const { state, ...rest } = input.set;
  const rows = yield* q.all(
    q.orm
      .update(v)
      .set({
        ...rest,
        ...(state === undefined ? {} : { state, stateAt: input.now }),
        generation: input.generation + 1,
      })
      .where(and(eq(v.id, input.id), eq(v.generation, input.generation)))
      .returning({ id: v.id }),
  );
  return rows.length > 0;
}

export function* setIssueVmWantSteps(q: Q, input: { id: string; want: IssueVm["want"] }) {
  const { issueVm: v } = q.t;
  yield* q.exec(q.orm.update(v).set({ want: input.want }).where(eq(v.id, input.id)));
}

export function* unsettledIssueVmIdsSteps(q: Q) {
  const { issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: v.id })
      .from(v)
      .where(
        or(
          inArray(v.state, ["creating", "sleeping", "waking", "unknown"]),
          and(eq(v.state, "awake"), eq(v.want, "asleep")),
          and(eq(v.state, "asleep"), eq(v.want, "awake")),
        ),
      )
      .orderBy(v.id),
  );
  return rows.map((row) => row.id);
}

const HOST_STATES: Partial<Record<IssueVmState, IssueVmState>> = {
  sleeping: "asleep",
  waking: "awake",
};

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

export function* liveHostIssueVmsSteps(q: Q, hostRunnerId: string) {
  const { issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: v.id, state: v.state })
      .from(v)
      .where(and(eq(v.hostRunnerId, hostRunnerId), notInArray(v.state, ENDED_STATES)))
      .orderBy(v.id),
  );
  return rows.map((row) => {
    const state = row.state as IssueVmState;
    return { id: row.id, state: HOST_STATES[state] ?? state };
  });
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

export function* openIssueVmAwakeSteps(
  q: Q,
  { issueVmId, hourlyUsd, now }: { issueVmId: string; hourlyUsd: number | null; now: number },
) {
  const row = { id: ulid(now), issueVmId, startedAt: now, hourlyUsd };
  yield* q.exec(q.orm.insert(q.t.issueVmAwake).values(row).onConflictDoNothing());
}

export function* closeIssueVmAwakeSteps(q: Q, input: { issueVmId: string; now: number }) {
  const { issueVmAwake: a } = q.t;
  yield* q.exec(
    q.orm
      .update(a)
      .set({ endedAt: input.now })
      .where(and(eq(a.issueVmId, input.issueVmId), isNull(a.endedAt))),
  );
}

export function* issueVmAwakeIntervalsSteps(
  q: Q,
  input: { workspaceId: string; from: number; to: number },
) {
  const { issueVmAwake: a, issueVm: v } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        provider: v.provider,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        hourlyUsd: a.hourlyUsd,
      })
      .from(a)
      .innerJoin(v, eq(v.id, a.issueVmId))
      .where(
        and(
          eq(v.workspaceId, input.workspaceId),
          lt(a.startedAt, input.to),
          or(isNull(a.endedAt), gt(a.endedAt, input.from)),
        ),
      ),
  );
  return rows.map((row) => ({ ...row, provider: row.provider as IssueVmProvider }));
}

export type IssueVmSpendSettings = {
  monthlyLimitUsd: number;
  boatHourlyUsd: number | null;
  instaboxHourlyUsd: number | null;
};

export function* issueVmSpendSettingsSteps(q: Q, workspaceId: string) {
  const { issueVmSpend: s } = q.t;
  const row = yield* q.one(q.orm.select().from(s).where(eq(s.workspaceId, workspaceId)));
  return (row ?? null) as IssueVmSpendSettings | null;
}

export function* saveIssueVmSpendSettingsSteps(
  q: Q,
  input: {
    workspaceId: string;
    changes: Partial<IssueVmSpendSettings>;
    defaultLimitUsd: number;
    updatedBy: string;
    now: number;
  },
) {
  const set = { ...input.changes, updatedBy: input.updatedBy, updatedAt: input.now };
  yield* q.exec(
    q.orm
      .insert(q.t.issueVmSpend)
      .values({ workspaceId: input.workspaceId, monthlyLimitUsd: input.defaultLimitUsd, ...set })
      .onConflictDoUpdate({ target: q.t.issueVmSpend.workspaceId, set }),
  );
}
