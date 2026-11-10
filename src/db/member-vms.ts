import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

export const MEMBER_VM_DELETE_STEPS = ["drain", "tailnet", "revoke", "destroy", "clear"] as const;
export type MemberVmDeleteStep = (typeof MEMBER_VM_DELETE_STEPS)[number];

export const MEMBER_VM_STEPS = ["create", "install", "enroll", "health", "ready"] as const;
export type MemberVmStep = (typeof MEMBER_VM_STEPS)[number];

export type MemberVm = {
  id: string;
  workspaceId: string;
  userId: string;
  vmName: string;
  pool: string | null;
  step: MemberVmStep;
  failure: string | null;
  runnerId: string | null;
  stepStartedAt: number;
  createRequestedAt: number | null;
  installStartedAt: number | null;
  tokenExpiresAt: number | null;
  installAt: number | null;
  enrollAt: number | null;
  healthAt: number | null;
  readyAt: number | null;
  createdAt: number;
  updatedAt: number;
  deleteStep: MemberVmDeleteStep | null;
  deleteRunnerId: string | null;
  deleteRequestedBy: string | null;
  deleteForce: number;
  deleteStepStartedAt: number | null;
  deleteAt: string | null;
  deleteFailure: string | null;
  deleteBlocked: string | null;
  enrollmentsTracked: number;
};

const STEP_AT = {
  install: "installAt",
  enroll: "enrollAt",
  health: "healthAt",
  ready: "readyAt",
} as const satisfies Record<Exclude<MemberVmStep, "create">, string>;

function columns(q: Q) {
  const { memberVm: m } = q.t;
  return {
    ...getTableColumns(m),
    deleteAt: jsonText(q, m.deleteAt) as SQL<string | null>,
    deleteBlocked: jsonText(q, m.deleteBlocked) as SQL<string | null>,
  };
}

export function* memberVmByIdSteps(q: Q, id: string) {
  const { memberVm: m } = q.t;
  const row = yield* q.one(q.orm.select(columns(q)).from(m).where(eq(m.id, id)));
  return (row ?? null) as MemberVm | null;
}

export async function memberVmById(store: Db, id: string): Promise<MemberVm | null> {
  return store.run((q) => memberVmByIdSteps(q, id));
}

export function* memberVmForMemberSteps(q: Q, workspaceId: string, userId: string) {
  const { memberVm: m } = q.t;
  const row = yield* q.one(
    q.orm
      .select(columns(q))
      .from(m)
      .where(and(eq(m.workspaceId, workspaceId), eq(m.userId, userId))),
  );
  return (row ?? null) as MemberVm | null;
}

export async function memberVmForMember(
  store: Db,
  workspaceId: string,
  userId: string,
): Promise<MemberVm | null> {
  return store.run((q) => memberVmForMemberSteps(q, workspaceId, userId));
}

export function* workspaceMemberVmsSteps(q: Q, workspaceId: string) {
  const { memberVm: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(columns(q))
      .from(m)
      .where(eq(m.workspaceId, workspaceId))
      .orderBy(m.createdAt, m.id),
  );
  return rows as MemberVm[];
}

export async function workspaceMemberVms(store: Db, workspaceId: string): Promise<MemberVm[]> {
  return store.run((q) => workspaceMemberVmsSteps(q, workspaceId));
}

export function* memberVmNameTakenSteps(q: Q, name: string) {
  const { memberVm: m } = q.t;
  return (yield* q.one(q.orm.select({ id: m.id }).from(m).where(eq(m.vmName, name)))) !== undefined;
}

export async function memberVmNameTaken(store: Db, name: string): Promise<boolean> {
  return store.run((q) => memberVmNameTakenSteps(q, name));
}

type NewMemberVm = {
  id: string;
  workspaceId: string;
  userId: string;
  vmName: string;
  pool: string | null;
  now: number;
};

export function* insertMemberVmSteps(q: Q, input: NewMemberVm) {
  const { now, ...row } = input;
  yield* q.exec(
    q.orm
      .insert(q.t.memberVm)
      .values({ ...row, step: "create", stepStartedAt: now, createdAt: now, updatedAt: now }),
  );
}

export async function insertMemberVm(store: Db, input: NewMemberVm): Promise<void> {
  await store.run((q) => insertMemberVmSteps(q, input));
}

export function* returnMemberVmToEnrollSteps(q: Q, id: string, now: number) {
  const { memberVm: m } = q.t;
  yield* q.exec(
    q.orm
      .update(m)
      .set({
        step: "enroll",
        stepStartedAt: now,
        tokenExpiresAt: null,
        enrollAt: now,
        healthAt: null,
        readyAt: null,
        updatedAt: now,
      })
      .where(eq(m.id, id)),
  );
}

export async function returnMemberVmToEnroll(store: Db, id: string, now: number): Promise<void> {
  await store.run((q) => returnMemberVmToEnrollSteps(q, id, now));
}

export function* retryMemberVmStepSteps(q: Q, id: string, now: number) {
  const { memberVm: m } = q.t;
  const unenrolled = sql`${m.step}='health' AND ${m.runnerId} IS NULL`;
  yield* q.exec(
    q.orm
      .update(m)
      .set({
        failure: null,
        stepStartedAt: now,
        updatedAt: now,
        enrollAt: sql`CASE WHEN ${unenrolled} THEN ${now} ELSE ${m.enrollAt} END`,
        healthAt: sql`CASE WHEN ${unenrolled} THEN NULL ELSE ${m.healthAt} END`,
        step: sql`CASE WHEN ${unenrolled} THEN 'enroll' ELSE ${m.step} END`,
        installStartedAt: sql`CASE WHEN ${m.step}='install' THEN NULL ELSE ${m.installStartedAt} END`,
      })
      .where(eq(m.id, id)),
  );
}

export async function retryMemberVmStep(store: Db, id: string, now: number): Promise<void> {
  await store.run((q) => retryMemberVmStepSteps(q, id, now));
}

export function* releaseRevokedMemberVmRunnerSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  now: number,
) {
  const { memberVm: m, runner: r } = q.t;
  yield* q.exec(
    q.orm
      .update(m)
      .set({ runnerId: null, updatedAt: now })
      .where(
        and(
          eq(m.workspaceId, workspaceId),
          eq(m.userId, userId),
          inArray(
            m.runnerId,
            q.orm
              .select({ id: r.id })
              .from(r)
              .where(or(eq(r.status, "revoked"), isNotNull(r.revokedAt))),
          ),
        ),
      ),
  );
}

export async function releaseRevokedMemberVmRunner(
  store: Db,
  workspaceId: string,
  userId: string,
  now: number,
): Promise<void> {
  await store.run((q) => releaseRevokedMemberVmRunnerSteps(q, workspaceId, userId, now));
}

export function* setMemberVmPoolSteps(q: Q, id: string, pool: string, now: number) {
  const { memberVm: m } = q.t;
  yield* q.exec(q.orm.update(m).set({ pool, updatedAt: now }).where(eq(m.id, id)));
}

export async function setMemberVmPool(
  store: Db,
  id: string,
  pool: string,
  now: number,
): Promise<void> {
  await store.run((q) => setMemberVmPoolSteps(q, id, pool, now));
}

export type MemberVmStepFields = {
  vmName?: string;
  createRequestedAt?: number | null;
  installStartedAt?: number;
  tokenExpiresAt?: number | null;
  runnerId?: string;
};

export function* updateMemberVmStepSteps(
  q: Q,
  input: { id: string; step: string; fields: MemberVmStepFields; now: number },
) {
  const { memberVm: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(m)
      .set({ ...input.fields, updatedAt: input.now })
      .where(and(eq(m.id, input.id), eq(m.step, input.step), isNull(m.failure)))
      .returning({ id: m.id }),
  );
  return rows.length;
}

export async function updateMemberVmStep(
  store: Db,
  input: { id: string; step: string; fields: MemberVmStepFields; now: number },
): Promise<number> {
  return store.run((q) => updateMemberVmStepSteps(q, input));
}

export function* restoreMemberVmCreateRequestSteps(q: Q, id: string, at: number | null) {
  const { memberVm: m } = q.t;
  yield* q.exec(
    q.orm
      .update(m)
      .set({ createRequestedAt: at })
      .where(and(eq(m.id, id), eq(m.step, "create"), isNull(m.failure))),
  );
}

export async function restoreMemberVmCreateRequest(
  store: Db,
  id: string,
  at: number | null,
): Promise<void> {
  await store.run((q) => restoreMemberVmCreateRequestSteps(q, id, at));
}

export function* advanceMemberVmStepSteps(
  q: Q,
  input: { id: string; from: string; to: Exclude<MemberVmStep, "create">; now: number },
) {
  const { memberVm: m } = q.t;
  const { id, from, to, now } = input;
  const rows = yield* q.all(
    q.orm
      .update(m)
      .set({ step: to, stepStartedAt: now, [STEP_AT[to]]: now, updatedAt: now })
      .where(and(eq(m.id, id), eq(m.step, from), isNull(m.failure)))
      .returning({ id: m.id }),
  );
  return rows.length;
}

export async function advanceMemberVmStep(
  store: Db,
  input: { id: string; from: string; to: Exclude<MemberVmStep, "create">; now: number },
): Promise<number> {
  return store.run((q) => advanceMemberVmStepSteps(q, input));
}

export function* failMemberVmStepSteps(
  q: Q,
  input: { id: string; step: string; failure: string; now: number },
) {
  const { memberVm: m } = q.t;
  yield* q.exec(
    q.orm
      .update(m)
      .set({ failure: input.failure, updatedAt: input.now })
      .where(and(eq(m.id, input.id), eq(m.step, input.step), isNull(m.deleteStep))),
  );
}

export async function failMemberVmStep(
  store: Db,
  input: { id: string; step: string; failure: string; now: number },
): Promise<void> {
  await store.run((q) => failMemberVmStepSteps(q, input));
}

export function* beginMemberVmDeleteSteps(
  q: Q,
  input: { id: string; requestedBy: string; force: number; now: number },
) {
  const { memberVm: m } = q.t;
  const { id, requestedBy, force, now } = input;
  yield* q.exec(
    q.orm
      .update(m)
      .set({
        deleteStep: "drain",
        deleteRunnerId: sql`${m.runnerId}`,
        deleteRequestedBy: requestedBy,
        deleteForce: force,
        deleteStepStartedAt: now,
        deleteAt: jsonValue(q, { drain: now }),
        deleteFailure: null,
        deleteBlocked: null,
        updatedAt: now,
      })
      .where(eq(m.id, id)),
  );
}

export async function beginMemberVmDelete(
  store: Db,
  input: { id: string; requestedBy: string; force: number; now: number },
): Promise<void> {
  await store.run((q) => beginMemberVmDeleteSteps(q, input));
}

export function* retryMemberVmDeleteSteps(q: Q, id: string, force: number, now: number) {
  const { memberVm: m } = q.t;
  const greatest = q.dialect === "sqlite" ? sql`MAX` : sql`GREATEST`;
  yield* q.exec(
    q.orm
      .update(m)
      .set({
        deleteFailure: null,
        deleteBlocked: null,
        deleteForce: sql`${greatest}(${m.deleteForce}, ${force})`,
        deleteStepStartedAt: now,
        updatedAt: now,
      })
      .where(eq(m.id, id)),
  );
}

export async function retryMemberVmDelete(
  store: Db,
  id: string,
  force: number,
  now: number,
): Promise<void> {
  await store.run((q) => retryMemberVmDeleteSteps(q, id, force, now));
}

export function* recordMemberVmEnrollmentSteps(
  q: Q,
  input: { tokenHash: string; memberVmId: string; now: number },
) {
  const { tokenHash, memberVmId, now } = input;
  yield* q.exec(
    q.orm
      .insert(q.t.memberVmEnrollment)
      .values({ tokenHash, memberVmId, createdAt: now })
      .onConflictDoNothing(),
  );
}

export async function recordMemberVmEnrollment(
  store: Db,
  input: { tokenHash: string; memberVmId: string; now: number },
): Promise<void> {
  await store.run((q) => recordMemberVmEnrollmentSteps(q, input));
}
