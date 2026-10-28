import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { workspaceMember } from "../db";
import type { ExeDevVmSize } from "../provisioning";
import type { WorkspacePrincipal } from "../workspace";
import {
  findMemberVm,
  listDeletableMemberVms,
  MEMBER_VM_DELETE_STEPS,
  MemberVmDeleteDenied,
  MemberVmMissing,
  retryMemberVm,
  startMemberVm,
  startMemberVmDelete,
  type MemberVm,
  type MemberVmBlockingTask,
  type MemberVmDeleteStep,
} from "./store";

/** The steps the Runners page shows. `ready` is the end of the last one, not a step of its own. */
export const MEMBER_VM_PROGRESS_STEPS = ["create", "install", "enroll", "health"] as const;
export type MemberVmProgressStep = (typeof MEMBER_VM_PROGRESS_STEPS)[number];

export type MemberVmStepView = {
  step: MemberVmProgressStep;
  state: "done" | "running" | "failed" | "pending";
  /** How long the step took, or has run so far. Null before it starts or when not recorded. */
  elapsedMs: number | null;
};

export type MemberVmDeleteStepView = {
  step: MemberVmDeleteStep;
  state: MemberVmStepView["state"];
  elapsedMs: number | null;
};

export type MemberVmDeleteView = {
  step: MemberVmDeleteStep;
  failure: string | null;
  blocked: MemberVmBlockingTask[];
  force: boolean;
  steps: MemberVmDeleteStepView[];
};

export type MemberVmView = {
  id: string;
  vmName: string;
  userId: string;
  ownerName: string | null;
  step: MemberVm["step"];
  failure: string | null;
  runnerId: string | null;
  steps: MemberVmStepView[];
  deleting: MemberVmDeleteView | null;
};

/** What `GET /api/runners/vm` and the two POST routes answer. */
export type MemberVmResponse =
  | { available: false }
  | {
      available: true;
      vm: MemberVmView | null;
      vms: MemberVmView[];
      /** The size Create VM asks exe.dev for. Absent when config.toml cannot be read. */
      size?: ExeDevVmSize;
    };

export function memberVmView(
  row: MemberVm,
  now: number,
  ownerName: string | null = null,
): MemberVmView {
  const began: Record<MemberVm["step"], number | null> = {
    create: row.createdAt,
    install: row.installAt,
    enroll: row.enrollAt,
    health: row.healthAt,
    ready: row.readyAt,
  };
  const order = ["create", "install", "enroll", "health", "ready"] as const;
  const current = order.indexOf(row.step);
  const steps = MEMBER_VM_PROGRESS_STEPS.map((step, index): MemberVmStepView => {
    if (index < current) {
      const start = began[step];
      const end = began[order[index + 1]!];
      return {
        step,
        state: "done",
        elapsedMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      };
    }
    if (index > current) return { step, state: "pending", elapsedMs: null };
    const failed = row.failure !== null;
    return {
      step,
      state: failed ? "failed" : "running",
      elapsedMs: Math.max(0, (failed ? row.updatedAt : now) - row.stepStartedAt),
    };
  });
  return {
    id: row.id,
    vmName: row.vmName,
    userId: row.userId,
    ownerName,
    step: row.step,
    failure: row.failure,
    runnerId: row.runnerId ?? row.deleteRunnerId,
    steps,
    deleting: deleteView(row, now),
  };
}

function deleteView(row: MemberVm, now: number): MemberVmDeleteView | null {
  if (row.deleteStep === null) return null;
  const began = parseRecord(row.deleteAt);
  const current = MEMBER_VM_DELETE_STEPS.indexOf(row.deleteStep);
  const failed = row.deleteFailure !== null;
  const steps = MEMBER_VM_DELETE_STEPS.map((step, index): MemberVmDeleteStepView => {
    if (index < current) {
      const start = began[step];
      const end = began[MEMBER_VM_DELETE_STEPS[index + 1]!];
      return {
        step,
        state: "done",
        elapsedMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : null,
      };
    }
    if (index > current) return { step, state: "pending", elapsedMs: null };
    const started = row.deleteStepStartedAt;
    return {
      step,
      state: failed ? "failed" : "running",
      elapsedMs: started === null ? null : Math.max(0, (failed ? row.updatedAt : now) - started),
    };
  });
  return {
    step: row.deleteStep,
    failure: row.deleteFailure,
    blocked: parseBlocked(row.deleteBlocked),
    force: row.deleteForce === 1,
    steps,
  };
}

function parseRecord(text: string | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(text ?? "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch (caughtError1) {
    journalCaught(caughtError1, "http.parseRecord.parse", null);
    return {};
  }
}

function parseBlocked(text: string | null): MemberVmBlockingTask[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? (value as MemberVmBlockingTask[]) : [];
  } catch (caughtError2) {
    journalCaught(caughtError2, "http.parseBlocked.parse", null);
    return [];
  }
}

const ROUTES = new Set(["/api/runners/vm", "/api/runners/vm/retry", "/api/runners/vm/delete"]);
const MAX_BODY = 4096;

/**
 * `GET /api/runners/vm`, `POST /api/runners/vm` and `POST /api/runners/vm/retry`. The server
 * checks the workspace session and CSRF before this runs; this refuses observers and inactive
 * members. Without an exe.dev token every route answers `{ available: false }`.
 */
export function createMemberVmHttp(options: {
  db: Database;
  available: () => boolean | Promise<boolean>;
  /** `[member_vm]` from config.toml. */
  size?: () => ExeDevVmSize;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  return async function memberVmHttp(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!ROUTES.has(path)) return null;
    const method = request.method;
    if (path === "/api/runners/vm" ? method !== "GET" && method !== "POST" : method !== "POST")
      return json({ error: "Method not allowed." }, 405);
    const current = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!current?.active || current.role === "observer")
      return json(
        {
          error:
            path === "/api/runners/vm/delete"
              ? "Observers cannot delete a VM."
              : "Only workspace members can create a VM.",
        },
        403,
      );
    const available = await Promise.resolve()
      .then(() => options.available())
      .catch((caughtError3) => {
        journalCaught(caughtError3, "http.createMemberVmHttp.then", null);
        return false;
      });
    if (!available) return json({ available: false } satisfies MemberVmResponse);
    const member = { workspaceId: principal.workspaceId, userId: principal.userId };
    const at = now();
    try {
      if (method === "POST" && path === "/api/runners/vm")
        startMemberVm(db, { ...member, now: at });
      else if (path === "/api/runners/vm/retry") retryMemberVm(db, { ...member, now: at });
      else if (path === "/api/runners/vm/delete") {
        const body = await deleteBody(request);
        if (body === null)
          return json({ error: "Send the VM id and an optional force flag as JSON." }, 400);
        startMemberVmDelete(db, { ...member, ...body, now: at });
      }
      const own = findMemberVm(db, member);
      const size = readSize(options.size);
      return json({
        available: true,
        vm: own === null ? null : memberVmView(own, at),
        vms: listDeletableMemberVms(db, member).map((row) =>
          memberVmView(row, at, memberName(db, row.userId)),
        ),
        ...(size === null ? {} : { size }),
      } satisfies MemberVmResponse);
    } catch (error) {
      journalCaught(error, "http.createMemberVmHttp.startMemberVm", null);
      if (error instanceof MemberVmDeleteDenied) return json({ error: error.message }, 403);
      if (error instanceof MemberVmMissing) return json({ error: error.message }, 404);
      const message = error instanceof Error ? error.message : "The VM request failed.";
      return json({ error: message }, /membership/i.test(message) ? 403 : 409);
    }
  };
}

function readSize(read: (() => ExeDevVmSize) | undefined): ExeDevVmSize | null {
  if (read === undefined) return null;
  try {
    return read();
  } catch (caughtError6) {
    journalCaught(caughtError6, "http.readSize", null, "Create VM reports the config error");
    return null;
  }
}

function memberName(db: Database, userId: string): string | null {
  return (
    db.query<{ name: string }, [string]>("SELECT name FROM workspace_user WHERE id=?").get(userId)
      ?.name ?? null
  );
}

async function deleteBody(request: Request): Promise<{ id: string; force: boolean } | null> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return null;
  const text = await request.text().catch((caughtError4) => {
    journalCaught(caughtError4, "http.deleteBody.text", null);
    return null;
  });
  if (text === null || text.length > MAX_BODY) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (caughtError5) {
    journalCaught(caughtError5, "http.deleteBody.parse", null);
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "id" && key !== "force")) return null;
  const { id, force } = record;
  if (typeof id !== "string" || id.length === 0 || id.length > 80) return null;
  if (force !== undefined && typeof force !== "boolean") return null;
  return { id, force: force === true };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
