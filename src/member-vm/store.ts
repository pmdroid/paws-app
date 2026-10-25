import type { Database } from "bun:sqlite";
import { enqueueJob, immediate } from "../db";
import { isExeDevVmName } from "../provisioning";
import { workspaceId as mintId } from "../workspace";

export const MEMBER_VM_QUEUE = "member_vm.provision";

export const MEMBER_VM_STEPS = ["create", "install", "enroll", "health", "ready"] as const;
export type MemberVmStep = (typeof MEMBER_VM_STEPS)[number];

export type MemberVm = {
  id: string;
  workspaceId: string;
  userId: string;
  vmName: string;
  step: MemberVmStep;
  /** Why the current step stopped, or null while it runs or once ready. */
  failure: string | null;
  runnerId: string | null;
  stepStartedAt: number;
  /** Set once Paws has asked exe.dev to create the VM, so a later `conflict` is its own VM. */
  createRequestedAt: number | null;
  /** Set once `startInstall` has answered, so later claims poll `installStatus`. */
  installStartedAt: number | null;
  /** When the enrollment token staged on the VM expires, or null when none is staged. */
  tokenExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemberRef = { workspaceId: string; userId: string };

const COLUMNS = `id,workspace_id AS workspaceId,user_id AS userId,vm_name AS vmName,step,failure,
  runner_id AS runnerId,step_started_at AS stepStartedAt,create_requested_at AS createRequestedAt,
  install_started_at AS installStartedAt,token_expires_at AS tokenExpiresAt,
  created_at AS createdAt,updated_at AS updatedAt`;

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

/**
 * The member's VM row, inserted at `create` with its job on the first call. A later call returns
 * the existing row; when its runner was removed after enrollment it goes back to `enroll` on the
 * same VM. A row whose job was lost while it was neither failed nor ready gets its job back.
 */
export function startMemberVm(db: Database, input: MemberRef & { now?: number }): MemberVm {
  const now = input.now ?? Date.now();
  return immediate(db, () => {
    const existing = current(db, input, now);
    if (existing) {
      if (
        existing.failure === null &&
        existing.runnerId === null &&
        (existing.step === "health" || existing.step === "ready")
      ) {
        db.run(
          `UPDATE member_vm SET step='enroll',step_started_at=?,token_expires_at=NULL,updated_at=?
          WHERE id=?`,
          [now, now, existing.id],
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

/**
 * Rerun a failed step and the ones after it on the same row and VM. A row that has not failed is
 * returned unchanged.
 */
export function retryMemberVm(db: Database, input: MemberRef & { now?: number }): MemberVm {
  const now = input.now ?? Date.now();
  return immediate(db, () => {
    const existing = current(db, input, now);
    if (!existing) throw new Error("This member has no VM to retry.");
    if (existing.failure === null) return existing;
    requireOwner(db, input);
    db.run(
      `UPDATE member_vm SET failure=NULL,step_started_at=?,updated_at=?,
      step=CASE WHEN step='health' AND runner_id IS NULL THEN 'enroll' ELSE step END,
      install_started_at=CASE WHEN step='install' THEN NULL ELSE install_started_at END
      WHERE id=?`,
      [now, now, existing.id],
    );
    ensureJob(db, existing.id, now);
    return getMemberVm(db, existing.id)!;
  });
}

/** The member's row, with `runner_id` cleared when that runner was revoked by any path. */
function current(db: Database, member: MemberRef, now: number): MemberVm | null {
  db.run(
    `UPDATE member_vm SET runner_id=NULL,updated_at=? WHERE workspace_id=? AND user_id=?
    AND runner_id IN (SELECT id FROM runner WHERE status='revoked' OR revoked_at IS NOT NULL)`,
    [now, member.workspaceId, member.userId],
  );
  return findMemberVm(db, member);
}

/** One open job per row: the job carries the row through every step. */
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

/** `<member>-paws`, from the member's name or email, made unique among recorded VMs. */
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
