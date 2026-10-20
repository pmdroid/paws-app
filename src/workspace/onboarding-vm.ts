import type { Database } from "bun:sqlite";
import {
  healthyOnboardingRunners,
  readMemberVm,
  type MemberVmRecord,
  type OnboardingVmScope,
  type WorkspaceSession,
} from "../db";
import type { WorkspaceAssignments } from "./assignments";
import { readWorkspaceJson } from "./administration";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export const VM_STEPS = ["create", "install", "pair", "health"] as const;
export type VmStepName = (typeof VM_STEPS)[number];

export type OnboardingVmProvisioning = {
  available(): boolean;
  retry(input: {
    sessionId: string;
    generation: number;
    principal: WorkspacePrincipal;
    revision: number;
    step: VmStepName;
  }): "ok" | "missing" | "conflict";
};

export type OnboardingVmProjection = {
  revision: number;
  state: "unavailable" | "provisioning" | "failed" | "ready";
  ready: boolean;
  detail: string;
  machine: { name: string; reused: boolean } | null;
  steps: { name: VmStepName; state: "waiting" | "running" | "done" | "failed"; detail: string }[];
  retry: VmStepName | null;
  runner: { id: string; name: string } | null;
};

export const RUNNER_HEALTH_MS = 60_000;
export const PERMANENT_VM_FAILURES = new Set(["conflict", "missing"]);

const FAILURES: Record<string, string> = {
  conflict:
    "A VM with the name Paws reserved for you already exists and was not created by Paws. Ask your Paws operator to resolve it.",
  missing: "The VM Paws created for you is no longer listed by exe.dev. Ask your Paws operator.",
  unresolved: "exe.dev did not confirm the new VM. Retry to check again.",
  credentials: "Paws could not authenticate with exe.dev.",
  rejected: "exe.dev rejected the request.",
  provider: "exe.dev could not be reached.",
  timeout: "This step did not finish in time.",
  install: "Installing the Paws runner on your VM failed.",
  pair: "Pairing your VM with this workspace failed.",
  runner: "The Paws runner on your VM did not report healthy.",
};

const RUNNING: Record<VmStepName, string> = {
  create: "Creating your VM on exe.dev.",
  install: "Installing tools and the Paws runner.",
  pair: "Pairing the runner with this workspace.",
  health: "Waiting for the runner to report healthy.",
};

const DONE: Record<VmStepName, string> = {
  create: "VM created.",
  install: "Paws runner installed.",
  pair: "Runner paired with this workspace.",
  health: "Runner reported healthy.",
};

const BOOTING = "Waiting for your VM to boot.";

export function selectedOnboardingRunner(db: Database, scope: OnboardingVmScope, now: number) {
  const provision = readMemberVm(db, scope.workspaceId, scope.userId);
  const found =
    provision?.step === "ready" && provision.state === "ready" && provision.runnerId
      ? healthyOnboardingRunners(db, scope, now - RUNNER_HEALTH_MS, now).find(
          (entry) => entry.id === provision.runnerId,
        )
      : undefined;
  const runner =
    found && provision
      ? { ...found, provision: { id: provision.id, run: provision.run } }
      : undefined;
  return { provision, runner };
}

function booting(record: MemberVmRecord | null) {
  return (
    record?.step === "install" &&
    record.state === "pending" &&
    record.createOutcome === "created" &&
    record.vm?.status !== "running"
  );
}

function step(name: VmStepName, state: OnboardingVmProjection["steps"][number]["state"]) {
  return {
    name,
    state,
    detail: state === "done" ? DONE[name] : state === "running" ? RUNNING[name] : "",
  };
}

function automaticSteps(record: MemberVmRecord | null, healthy: boolean) {
  if (!record) return VM_STEPS.map((name) => step(name, "waiting"));
  if (record.step === "ready")
    return VM_STEPS.map((name) => step(name, name === "health" && !healthy ? "running" : "done"));
  const current = VM_STEPS.indexOf(record.step);
  return VM_STEPS.map((name, index) => {
    if (index < current) return step(name, "done");
    if (index > current) return step(name, "waiting");
    if (record.state === "failed")
      return {
        name,
        state: "failed" as const,
        detail: FAILURES[record.failure ?? ""] ?? "This step failed.",
      };
    if (booting(record)) return { name, state: "waiting" as const, detail: BOOTING };
    return step(name, record.state === "running" ? "running" : "waiting");
  });
}

export function onboardingVmState(
  db: Database,
  scope: OnboardingVmScope,
  now: number,
  available = false,
): OnboardingVmProjection {
  const { provision, runner } = selectedOnboardingRunner(db, scope, now);
  const revision = provision?.revision ?? 0;
  const selected = runner ? { id: runner.id, name: runner.name } : null;
  const steps = automaticSteps(provision, runner !== undefined);
  const machine = provision
    ? {
        name: provision.providerName,
        reused:
          provision.originSessionId !== scope.sessionId ||
          provision.originGeneration !== scope.generation,
      }
    : null;
  const ready = runner !== undefined && steps.every((entry) => entry.state === "done");
  const failed = provision?.state === "failed" && provision.step !== "ready";
  const state = ready
    ? "ready"
    : failed
      ? "failed"
      : available || provision?.step === "ready"
        ? "provisioning"
        : "unavailable";
  return {
    revision,
    state,
    ready,
    detail: ready
      ? `Your VM ${runner!.name} is ready.`
      : failed
        ? "Setting up your VM stopped."
        : state === "provisioning"
          ? provision?.step === "ready"
            ? "Waiting for your VM to report healthy again."
            : booting(provision)
              ? BOOTING
              : "Paws is setting up your VM."
          : "Automatic VM setup is not configured for this workspace.",
    machine,
    steps: state === "unavailable" && !provision ? [] : steps,
    retry:
      failed && available && !PERMANENT_VM_FAILURES.has(provision.failure ?? "")
        ? (provision.step as VmStepName)
        : null,
    runner: ready ? selected : null,
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

type RouteOptions = {
  db: Database;
  assignments: Pick<WorkspaceAssignments, "onboardingContext">;
  principal: WorkspacePrincipal;
  session: WorkspaceSession;
  origin: string;
  provisioning?: OnboardingVmProvisioning;
  now?: () => number;
};

async function readRequest(request: Request, options: RouteOptions, extra: readonly string[]) {
  const url = new URL(request.url);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (
    url.origin !== options.origin ||
    request.headers.get("origin") !== options.origin ||
    !validWorkspaceCsrf(request, options.session) ||
    options.session.workspaceId !== options.principal.workspaceId ||
    options.session.userId !== options.principal.userId
  )
    return json({ error: "CSRF token required." }, 403);
  const selectedWorkspace =
    url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
  if (selectedWorkspace !== null && selectedWorkspace !== options.principal.workspaceId)
    return json({ error: "Workspace access denied." }, 403);
  const body = await readWorkspaceJson(request).catch(() => null);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== ["generation", "session", ...extra].sort().join(",") ||
    !("session" in body) ||
    typeof body.session !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.session) ||
    !("generation" in body) ||
    typeof body.generation !== "number" ||
    !Number.isSafeInteger(body.generation) ||
    body.generation < 0 ||
    body.generation > 9_999_999_999
  )
    return null;
  return body as { session: string; generation: number } & Record<string, unknown>;
}

export async function handleOnboardingVm(
  request: Request,
  options: RouteOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/workspaces/onboarding/vm/retry") return null;
  return handleOnboardingVmRetry(request, options);
}

async function handleOnboardingVmRetry(request: Request, options: RouteOptions): Promise<Response> {
  const body = await readRequest(request, options, ["revision", "step"]);
  if (body instanceof Response) return body;
  if (
    !body ||
    typeof body.revision !== "number" ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !VM_STEPS.some((name) => name === body.step)
  )
    return json({ error: "Choose the failed step of the current assignment." }, 400);
  if (!options.provisioning?.available())
    return json({ error: "Automatic VM setup is not available." }, 503);
  const outcome = options.provisioning.retry({
    sessionId: body.session,
    generation: body.generation,
    principal: options.principal,
    revision: body.revision,
    step: body.step as VmStepName,
  });
  if (outcome === "missing") return json({ error: "Onboarding is unavailable." }, 404);
  if (outcome === "conflict") return json({ error: "This step cannot be retried now." }, 409);
  const scope = options.assignments.onboardingContext(
    body.session,
    body.generation,
    options.principal,
  );
  if (!scope) return json({ error: "Onboarding is unavailable." }, 404);
  return json(onboardingVmState(options.db, scope, (options.now ?? Date.now)(), true));
}
