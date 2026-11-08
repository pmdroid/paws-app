import {
  beginMemberVmDelete,
  cancelMemberVmJobs,
  enqueueJob,
  immediate,
  insertMemberVm,
  memberVmById,
  memberVmForMember,
  memberVmNameTaken,
  openMemberVmJob,
  releaseRevokedMemberVmRunner,
  retryMemberVmDelete,
  retryMemberVmStep,
  returnMemberVmToEnroll,
  workspaceMember,
  workspaceMemberUsable,
  workspaceMemberVms,
  workspaceUserContact,
  type MemberVm,
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
export function startMemberVm(
  db: Database,
  input: MemberRef & { now?: number; pool?: string | null },
): MemberVm {
  const now = input.now ?? Date.now();
  return immediate(db, () => {
    const existing = current(db, input, now);
    if (existing?.deleteStep != null) return existing;
    if (existing) {
      if (
        existing.failure === null &&
        existing.runnerId === null &&
        (existing.step === "health" || existing.step === "ready")
      ) {
        returnMemberVmToEnroll(db, existing.id, now);
        ensureJob(db, existing.id, now);
        return getMemberVm(db, existing.id)!;
      }
      if (existing.failure === null && existing.step !== "ready") ensureJob(db, existing.id, now);
      return existing;
    }
    requireOwner(db, input);
    const id = mintId(now);
    insertMemberVm(db, {
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      vmName: freeVmName(db, input),
      pool: input.pool ?? null,
      now,
    });
    ensureJob(db, id, now);
    return getMemberVm(db, id)!;
  });
}

export function retryMemberVm(db: Database, input: MemberRef & { now?: number }): MemberVm {
  const now = input.now ?? Date.now();
  return immediate(db, () => {
    const existing = current(db, input, now);
    if (!existing) throw new Error("This member has no VM to retry.");
    if (existing.deleteStep !== null) throw new Error("This VM is being deleted.");
    if (existing.failure === null) return existing;
    requireOwner(db, input);
    retryMemberVmStep(db, existing.id, now);
    ensureJob(db, existing.id, now);
    return getMemberVm(db, existing.id)!;
  });
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

export function mayDeleteMemberVm(db: Database, row: MemberVm, requester: MemberRef): boolean {
  if (row.workspaceId !== requester.workspaceId) return false;
  const member = memberAccess(db, requester);
  if (!workspaceMemberUsable(member)) return false;
  return row.userId === requester.userId || isWorkspaceAdmin(member.role);
}

export function listDeletableMemberVms(db: Database, requester: MemberRef): MemberVm[] {
  return workspaceMemberVms(db, requester.workspaceId).filter((row) =>
    mayDeleteMemberVm(db, row, requester),
  );
}

export function startMemberVmDelete(
  db: Database,
  input: MemberRef & { id: string; force?: boolean; now?: number },
): MemberVm {
  const now = input.now ?? Date.now();
  const force = input.force === true ? 1 : 0;
  return immediate(db, () => {
    const row = getMemberVm(db, input.id);
    if (row === null || row.workspaceId !== input.workspaceId) throw new MemberVmMissing();
    if (!mayDeleteMemberVm(db, row, input)) throw new MemberVmDeleteDenied();
    if (row.deleteStep === null) {
      beginMemberVmDelete(db, { id: row.id, requestedBy: input.userId, force, now });
      cancelMemberVmJobs(db, {
        queue: MEMBER_VM_QUEUE,
        memberVmId: row.id,
        statuses: ["pending"],
        now,
      });
    } else if (row.deleteFailure !== null || force > row.deleteForce) {
      retryMemberVmDelete(db, row.id, force, now);
    }
    ensureDeleteJob(db, row.id, now);
    return getMemberVm(db, row.id)!;
  });
}

function ensureDeleteJob(db: Database, id: string, now: number): void {
  if (openMemberVmJob(db, MEMBER_VM_DELETE_QUEUE, id)) return;
  enqueueJob(db, { queue: MEMBER_VM_DELETE_QUEUE, payload: { memberVmId: id }, now });
}

function current(db: Database, member: MemberRef, now: number): MemberVm | null {
  releaseRevokedMemberVmRunner(db, member.workspaceId, member.userId, now);
  return findMemberVm(db, member);
}

function ensureJob(db: Database, id: string, now: number): void {
  if (openMemberVmJob(db, MEMBER_VM_QUEUE, id)) return;
  enqueueJob(db, { queue: MEMBER_VM_QUEUE, payload: { memberVmId: id }, now });
}

function memberAccess(db: Database, member: MemberRef) {
  return workspaceMember(db, member.workspaceId, member.userId);
}

function requireOwner(db: Database, member: MemberRef): void {
  if (!workspaceMemberUsable(memberAccess(db, member)))
    throw new Error("Active workspace membership is required to own a runner.");
}

/** The first name Paws has not used, after `after` when exe.dev refused that one. */
export function freeVmName(db: Database, member: MemberRef, after?: string): string {
  const user = workspaceUserContact(db, member.userId);
  const base =
    slug(user?.name ?? "") || slug(user?.email.split("@")[0] ?? "") || slug(member.userId);
  const names = Array.from({ length: 999 }, (_, index) => {
    const suffix = index === 0 ? "-paws" : `-paws-${index + 1}`;
    return `${(base || "member").slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
  });
  for (const name of names.slice(after === undefined ? 0 : names.indexOf(after) + 1))
    if (name !== after && isExeDevVmName(name) && !memberVmNameTaken(db, name)) return name;
  throw new Error("No free VM name for this member.");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
