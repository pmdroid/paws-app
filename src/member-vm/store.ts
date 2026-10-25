import { isWorkspaceAdmin } from "../workspace";
import type { Database } from "bun:sqlite";
import { enqueueJob, immediate } from "../db";
import { isExeDevVmName } from "../provisioning";
import { workspaceId as mintId } from "../workspace";

export const MEMBER_VM_QUEUE = "member_vm.provision";
export const MEMBER_VM_DELETE_QUEUE = "member_vm.delete";

export const MEMBER_VM_DELETE_STEPS = ["drain", "tailnet", "revoke", "destroy", "clear"] as const;
export type MemberVmDeleteStep = (typeof MEMBER_VM_DELETE_STEPS)[number];

export type MemberVmBlockingTask = { itemId: string; identifier: string; title: string };

export const MEMBER_VM_STEPS = ["create", "install", "enroll", "health", "ready"] as const;
export type MemberVmStep = (typeof MEMBER_VM_STEPS)[number];

export type MemberVm = {
  id: string;
  workspaceId: string;
  userId: string;
  vmName: string;
  step: MemberVmStep;
  failure: string | null;
  runnerId: string | null;
  stepStartedAt: number;
  createRequestedAt: number | null;
  installStartedAt: number | null;
  tokenExpiresAt: number | null;
  /** When each later step began; create begins at `createdAt`. */
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

export type MemberRef = { workspaceId: string; userId: string };

/** The column that records when each step after create began. */
export const STEP_AT = {
  install: "install_at",
  enroll: "enroll_at",
  health: "health_at",
  ready: "ready_at",
} as const satisfies Record<Exclude<MemberVmStep, "create">, string>;

const COLUMNS = `id,workspace_id AS workspaceId,user_id AS userId,vm_name AS vmName,step,failure,
  runner_id AS runnerId,step_started_at AS stepStartedAt,create_requested_at AS createRequestedAt,
  install_started_at AS installStartedAt,token_expires_at AS tokenExpiresAt,
  install_at AS installAt,enroll_at AS enrollAt,health_at AS healthAt,ready_at AS readyAt,
  created_at AS createdAt,updated_at AS updatedAt,delete_step AS deleteStep,
  delete_runner_id AS deleteRunnerId,delete_requested_by AS deleteRequestedBy,
  delete_force AS deleteForce,delete_step_started_at AS deleteStepStartedAt,delete_at AS deleteAt,
  delete_failure AS deleteFailure,delete_blocked AS deleteBlocked,
  enrollments_tracked AS enrollmentsTracked`;

export function getMemberVm(db: Database, id: string): MemberVm | null {
  return db.query<MemberVm, [string]>(`SELECT ${COLUMNS} FROM member_vm WHERE id=?`).get(id);
}

export function findMemberVm(db: Database, member: MemberRef): MemberVm | null {
  return db
    .query<MemberVm, [string, string]>(
      `SELECT ${COLUMNS} FROM member_vm WHERE workspace_id=? AND user_id=?`,
    )
    .get(member.workspaceId, member.userId);
}

export function startMemberVm(db: Database, input: MemberRef & { now?: number }): MemberVm {
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
        db.run(
          `UPDATE member_vm SET step='enroll',step_started_at=?,token_expires_at=NULL,enroll_at=?,
          health_at=NULL,ready_at=NULL,updated_at=? WHERE id=?`,
          [now, now, now, existing.id],
        );
        ensureJob(db, existing.id, now);
        return getMemberVm(db, existing.id)!;
      }
      if (existing.failure === null && existing.step !== "ready") ensureJob(db, existing.id, now);
      return existing;
    }
    requireOwner(db, input);
    const id = mintId(now);
    db.run(
      `INSERT INTO member_vm(id,workspace_id,user_id,vm_name,step,step_started_at,created_at,updated_at)
      VALUES(?,?,?,?,'create',?,?,?)`,
      [id, input.workspaceId, input.userId, freeVmName(db, input), now, now, now],
    );
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
    db.run(
      `UPDATE member_vm SET failure=NULL,step_started_at=?,updated_at=?,
      enroll_at=CASE WHEN step='health' AND runner_id IS NULL THEN ? ELSE enroll_at END,
      health_at=CASE WHEN step='health' AND runner_id IS NULL THEN NULL ELSE health_at END,
      step=CASE WHEN step='health' AND runner_id IS NULL THEN 'enroll' ELSE step END,
      install_started_at=CASE WHEN step='install' THEN NULL ELSE install_started_at END
      WHERE id=?`,
      [now, now, now, existing.id],
    );
    ensureJob(db, existing.id, now);
    return getMemberVm(db, existing.id)!;
  });
}

export class MemberVmDeleteDenied extends Error {
  constructor() {
    super("Only the VM's owner or a workspace owner or admin can delete this VM.");
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
  const member = db
    .query<{ role: string; active: number }, [string, string]>(
      "SELECT role,active FROM workspace_member WHERE workspace_id=? AND user_id=?",
    )
    .get(requester.workspaceId, requester.userId);
  if (!member?.active || member.role === "observer") return false;
  return row.userId === requester.userId || isWorkspaceAdmin(member.role);
}

export function listDeletableMemberVms(db: Database, requester: MemberRef): MemberVm[] {
  return db
    .query<MemberVm, [string]>(
      `SELECT ${COLUMNS} FROM member_vm WHERE workspace_id=? ORDER BY created_at,id`,
    )
    .all(requester.workspaceId)
    .filter((row) => mayDeleteMemberVm(db, row, requester));
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
      db.run(
        `UPDATE member_vm SET delete_step='drain',delete_runner_id=runner_id,delete_requested_by=?,
        delete_force=?,delete_step_started_at=?,delete_at=json_object('drain',?),delete_failure=NULL,
        delete_blocked=NULL,updated_at=? WHERE id=?`,
        [input.userId, force, now, now, now, row.id],
      );
      db.run(
        `UPDATE job SET status='cancelled',finished_at=?,locked_by=NULL,locked_until=NULL,
        last_error='member VM deleted' WHERE queue=? AND status='pending'
        AND json_extract(payload,'$.memberVmId')=?`,
        [now, MEMBER_VM_QUEUE, row.id],
      );
    } else if (row.deleteFailure !== null || force > row.deleteForce) {
      db.run(
        `UPDATE member_vm SET delete_failure=NULL,delete_blocked=NULL,delete_force=MAX(delete_force,?),
        delete_step_started_at=?,updated_at=? WHERE id=?`,
        [force, now, now, row.id],
      );
    }
    ensureDeleteJob(db, row.id, now);
    return getMemberVm(db, row.id)!;
  });
}

function ensureDeleteJob(db: Database, id: string, now: number): void {
  const open = db
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM job WHERE queue=? AND status IN ('pending','running')
      AND json_extract(payload,'$.memberVmId')=? LIMIT 1`,
    )
    .get(MEMBER_VM_DELETE_QUEUE, id);
  if (open) return;
  enqueueJob(db, { queue: MEMBER_VM_DELETE_QUEUE, payload: { memberVmId: id }, now });
}

function current(db: Database, member: MemberRef, now: number): MemberVm | null {
  db.run(
    `UPDATE member_vm SET runner_id=NULL,updated_at=? WHERE workspace_id=? AND user_id=?
    AND runner_id IN (SELECT id FROM runner WHERE status='revoked' OR revoked_at IS NOT NULL)`,
    [now, member.workspaceId, member.userId],
  );
  return findMemberVm(db, member);
}

function ensureJob(db: Database, id: string, now: number): void {
  const open = db
    .query<{ id: number }, [string, string]>(
      `SELECT id FROM job WHERE queue=? AND status IN ('pending','running')
      AND json_extract(payload,'$.memberVmId')=? LIMIT 1`,
    )
    .get(MEMBER_VM_QUEUE, id);
  if (open) return;
  enqueueJob(db, { queue: MEMBER_VM_QUEUE, payload: { memberVmId: id }, now });
}

function requireOwner(db: Database, member: MemberRef): void {
  const row = db
    .query<{ role: string; active: number }, [string, string]>(
      "SELECT role,active FROM workspace_member WHERE workspace_id=? AND user_id=?",
    )
    .get(member.workspaceId, member.userId);
  if (!row?.active || row.role === "observer")
    throw new Error("Active workspace membership is required to own a runner.");
}

function freeVmName(db: Database, member: MemberRef): string {
  const user = db
    .query<{ name: string; email: string }, [string]>(
      "SELECT name,email FROM workspace_user WHERE id=?",
    )
    .get(member.userId);
  const base =
    slug(user?.name ?? "") || slug(user?.email.split("@")[0] ?? "") || slug(member.userId);
  const taken = (name: string) =>
    db.query<{ one: number }, [string]>("SELECT 1 AS one FROM member_vm WHERE vm_name=?").get(name);
  for (let index = 1; index < 1000; index++) {
    const suffix = index === 1 ? "-paws" : `-paws-${index}`;
    const name = `${(base || "member").slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (isExeDevVmName(name) && !taken(name)) return name;
  }
  throw new Error("No free VM name for this member.");
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
