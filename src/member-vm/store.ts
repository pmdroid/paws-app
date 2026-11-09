import {
  beginMemberVmDeleteSteps,
  cancelMemberVmJobsSteps,
  emitJobReady,
  enqueueJobSteps,
  insertMemberVmSteps,
  memberVmById,
  memberVmByIdSteps,
  memberVmForMember,
  memberVmForMemberSteps,
  memberVmNameTakenSteps,
  openMemberVmJobSteps,
  releaseRevokedMemberVmRunnerSteps,
  retryMemberVmDeleteSteps,
  retryMemberVmStepSteps,
  returnMemberVmToEnrollSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceMemberVmsSteps,
  workspaceUserContactSteps,
  type Db,
  type MemberVm,
  type Q,
  type Steps,
} from "../db";
import { isWorkspaceAdmin, workspaceId as mintId } from "../workspace";
import type { Database } from "bun:sqlite";
import { isExeDevVmName } from "../provisioning";

export const MEMBER_VM_QUEUE = "member_vm.provision";
export const MEMBER_VM_DELETE_QUEUE = "member_vm.delete";

export type MemberVmBlockingTask = { itemId: string; identifier: string; title: string };

export { MEMBER_VM_DELETE_STEPS, MEMBER_VM_STEPS } from "../db";
export type { MemberVm, MemberVmDeleteStep, MemberVmStep } from "../db";

export type MemberRef = { workspaceId: string; userId: string };

export function getMemberVm(db: Database, id: string): MemberVm | null {
  return memberVmById(db, id);
}

export function findMemberVm(db: Database, member: MemberRef): MemberVm | null {
  return memberVmForMember(db, member.workspaceId, member.userId);
}

/** `pool` applies to a new VM only; an existing one keeps where it is. */
export async function startMemberVm(
  store: Db,
  input: MemberRef & { now?: number; pool?: string | null },
): Promise<MemberVm> {
  const now = input.now ?? Date.now();
  const { vm, enqueued } = await store.transaction(function* (q) {
    const existing = yield* currentSteps(q, input, now);
    if (existing?.deleteStep != null) return { vm: existing, enqueued: false };
    if (existing) {
      if (
        existing.failure === null &&
        existing.runnerId === null &&
        (existing.step === "health" || existing.step === "ready")
      ) {
        yield* returnMemberVmToEnrollSteps(q, existing.id, now);
        const enqueued = yield* ensureJobSteps(q, existing.id, now);
        return { vm: (yield* memberVmByIdSteps(q, existing.id))!, enqueued };
      }
      const enqueued =
        existing.failure === null && existing.step !== "ready"
          ? yield* ensureJobSteps(q, existing.id, now)
          : false;
      return { vm: existing, enqueued };
    }
    yield* requireOwnerSteps(q, input);
    const id = mintId(now);
    yield* insertMemberVmSteps(q, {
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      vmName: yield* freeVmNameSteps(q, input),
      pool: input.pool ?? null,
      now,
    });
    const enqueued = yield* ensureJobSteps(q, id, now);
    return { vm: (yield* memberVmByIdSteps(q, id))!, enqueued };
  });
  if (enqueued) emitJobReady(store);
  return vm;
}

export async function retryMemberVm(
  store: Db,
  input: MemberRef & { now?: number },
): Promise<MemberVm> {
  const now = input.now ?? Date.now();
  const { vm, enqueued } = await store.transaction(function* (q) {
    const existing = yield* currentSteps(q, input, now);
    if (!existing) throw new Error("This member has no VM to retry.");
    if (existing.deleteStep !== null) throw new Error("This VM is being deleted.");
    if (existing.failure === null) return { vm: existing, enqueued: false };
    yield* requireOwnerSteps(q, input);
    yield* retryMemberVmStepSteps(q, existing.id, now);
    const enqueued = yield* ensureJobSteps(q, existing.id, now);
    return { vm: (yield* memberVmByIdSteps(q, existing.id))!, enqueued };
  });
  if (enqueued) emitJobReady(store);
  return vm;
}

export class MemberVmDeleteDenied extends Error {
  constructor() {
    super("Only the VM's owner or a workspace admin can delete this VM.");
    this.name = "MemberVmDeleteDenied";
  }
}

export class MemberVmMissing extends Error {
  constructor() {
    super("This VM no longer exists.");
    this.name = "MemberVmMissing";
  }
}

export function* mayDeleteMemberVmSteps(q: Q, row: MemberVm, requester: MemberRef): Steps<boolean> {
  if (row.workspaceId !== requester.workspaceId) return false;
  const member = yield* memberAccessSteps(q, requester);
  if (!workspaceMemberUsable(member)) return false;
  return row.userId === requester.userId || isWorkspaceAdmin(member.role);
}

export function listDeletableMemberVms(store: Db, requester: MemberRef): Promise<MemberVm[]> {
  return store.run(function* (q) {
    const deletable: MemberVm[] = [];
    for (const row of yield* workspaceMemberVmsSteps(q, requester.workspaceId))
      if (yield* mayDeleteMemberVmSteps(q, row, requester)) deletable.push(row);
    return deletable;
  });
}

export async function startMemberVmDelete(
  store: Db,
  input: MemberRef & { id: string; force?: boolean; now?: number },
): Promise<MemberVm> {
  const now = input.now ?? Date.now();
  const force = input.force === true ? 1 : 0;
  const { vm, enqueued } = await store.transaction(function* (q) {
    const row = yield* memberVmByIdSteps(q, input.id);
    if (row === null || row.workspaceId !== input.workspaceId) throw new MemberVmMissing();
    if (!(yield* mayDeleteMemberVmSteps(q, row, input))) throw new MemberVmDeleteDenied();
    if (row.deleteStep === null) {
      yield* beginMemberVmDeleteSteps(q, { id: row.id, requestedBy: input.userId, force, now });
      yield* cancelMemberVmJobsSteps(q, {
        queue: MEMBER_VM_QUEUE,
        memberVmId: row.id,
        statuses: ["pending"],
        now,
      });
    } else if (row.deleteFailure !== null || force > row.deleteForce) {
      yield* retryMemberVmDeleteSteps(q, row.id, force, now);
    }
    const enqueued = yield* ensureDeleteJobSteps(q, row.id, now);
    return { vm: (yield* memberVmByIdSteps(q, row.id))!, enqueued };
  });
  if (enqueued) emitJobReady(store);
  return vm;
}

/** True when it added a job; the caller wakes the job loop after the transaction commits. */
function* ensureDeleteJobSteps(q: Q, id: string, now: number): Steps<boolean> {
  if (yield* openMemberVmJobSteps(q, MEMBER_VM_DELETE_QUEUE, id)) return false;
  yield* enqueueJobSteps(q, { queue: MEMBER_VM_DELETE_QUEUE, payload: { memberVmId: id }, now });
  return true;
}

function* currentSteps(q: Q, member: MemberRef, now: number): Steps<MemberVm | null> {
  yield* releaseRevokedMemberVmRunnerSteps(q, member.workspaceId, member.userId, now);
  return yield* memberVmForMemberSteps(q, member.workspaceId, member.userId);
}

/** True when it added a job; the caller wakes the job loop after the transaction commits. */
function* ensureJobSteps(q: Q, id: string, now: number): Steps<boolean> {
  if (yield* openMemberVmJobSteps(q, MEMBER_VM_QUEUE, id)) return false;
  yield* enqueueJobSteps(q, { queue: MEMBER_VM_QUEUE, payload: { memberVmId: id }, now });
  return true;
}

function memberAccessSteps(q: Q, member: MemberRef) {
  return workspaceMemberSteps(q, member.workspaceId, member.userId);
}

function* requireOwnerSteps(q: Q, member: MemberRef): Steps<void> {
  if (!workspaceMemberUsable(yield* memberAccessSteps(q, member)))
    throw new Error("Active workspace membership is required to own a runner.");
}

/** The first name Paws has not used, after `after` when exe.dev refused that one. */
export function* freeVmNameSteps(q: Q, member: MemberRef, after?: string): Steps<string> {
  const user = yield* workspaceUserContactSteps(q, member.userId);
  const base =
    slug(user?.name ?? "") || slug(user?.email.split("@")[0] ?? "") || slug(member.userId);
  const names = Array.from({ length: 999 }, (_, index) => {
    const suffix = index === 0 ? "-paws" : `-paws-${index + 1}`;
    return `${(base || "member").slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
  });
  for (const name of names.slice(after === undefined ? 0 : names.indexOf(after) + 1))
    if (name !== after && isExeDevVmName(name) && !(yield* memberVmNameTakenSteps(q, name)))
      return name;
  throw new Error("No free VM name for this member.");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
