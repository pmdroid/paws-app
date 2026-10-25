import type { Database } from "bun:sqlite";
import { workspaceMember } from "../db";
import type { WorkspacePrincipal } from "../workspace";
import { findMemberVm, retryMemberVm, startMemberVm, type MemberVm } from "./store";

/** The steps the Runners page shows. `ready` is the end of the last one, not a step of its own. */
export const MEMBER_VM_PROGRESS_STEPS = ["create", "install", "enroll", "health"] as const;
export type MemberVmProgressStep = (typeof MEMBER_VM_PROGRESS_STEPS)[number];

export type MemberVmStepView = {
  step: MemberVmProgressStep;
  state: "done" | "running" | "failed" | "pending";
  /** How long the step took, or has run so far. Null before it starts or when not recorded. */
  elapsedMs: number | null;
};

export type MemberVmView = {
  id: string;
  vmName: string;
  step: MemberVm["step"];
  failure: string | null;
  runnerId: string | null;
  steps: MemberVmStepView[];
};

/** What `GET /api/runners/vm` and the two POST routes answer. */
export type MemberVmResponse = { available: false } | { available: true; vm: MemberVmView | null };

export function memberVmView(row: MemberVm, now: number): MemberVmView {
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
    step: row.step,
    failure: row.failure,
    runnerId: row.runnerId,
    steps,
  };
}

/**
 * `GET /api/runners/vm`, `POST /api/runners/vm` and `POST /api/runners/vm/retry`. The server
 * checks the workspace session and CSRF before this runs; this refuses observers and inactive
 * members. Without an exe.dev token every route answers `{ available: false }`.
 */
export function createMemberVmHttp(options: {
  db: Database;
  available: () => boolean | Promise<boolean>;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  return async function memberVmHttp(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path !== "/api/runners/vm" && path !== "/api/runners/vm/retry") return null;
    const method = request.method;
    if (path === "/api/runners/vm" ? method !== "GET" && method !== "POST" : method !== "POST")
      return json({ error: "Method not allowed." }, 405);
    const current = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!current?.active || current.role === "observer")
      return json({ error: "Only workspace members can create a VM." }, 403);
    const available = await Promise.resolve()
      .then(() => options.available())
      .catch(() => false);
    if (!available) return json({ available: false } satisfies MemberVmResponse);
    const member = { workspaceId: principal.workspaceId, userId: principal.userId };
    const at = now();
    try {
      const row =
        method === "GET"
          ? findMemberVm(db, member)
          : path === "/api/runners/vm"
            ? startMemberVm(db, { ...member, now: at })
            : retryMemberVm(db, { ...member, now: at });
      return json({
        available: true,
        vm: row === null ? null : memberVmView(row, at),
      } satisfies MemberVmResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The VM request failed.";
      return json({ error: message }, /membership/i.test(message) ? 403 : 409);
    }
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
