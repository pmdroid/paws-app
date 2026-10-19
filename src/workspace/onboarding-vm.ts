import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  immediate,
  listOnboardingRunners,
  readOnboardingVm,
  saveOnboardingVm,
  type OnboardingVmScope,
  type WorkspaceSession,
} from "../db";
import type { WorkspaceAssignments } from "./assignments";
import { readWorkspaceJson } from "./administration";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export function onboardingVmState(db: Database, scope: OnboardingVmScope, now: number) {
  const candidates = listOnboardingRunners(db, scope, now);
  const saved = readOnboardingVm(db, scope);
  const selected = saved
    ? candidates.find((runner) => runner.id === saved.runnerId && runner.fence === saved.fence)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  const runners = candidates.map(({ id, name }) => ({ id, name }));
  return {
    state: selected ? "ready" : runners.length ? "choice_required" : "not_linked",
    detail: selected
      ? `VM linked: ${selected.name}`
      : runners.length
        ? "Choose one of your paired runners for this assignment."
        : "Pair your own runner to continue setting up this assignment.",
    runners,
    selectedRunner: selected ? { id: selected.id, name: selected.name } : null,
  };
}

export async function handleOnboardingVm(
  request: Request,
  options: {
    db: Database;
    assignments: Pick<WorkspaceAssignments, "onboardingContext">;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
    now?: () => number;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/workspaces/onboarding/vm") return null;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
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
    Object.keys(body).sort().join(",") !== "generation,runnerId,session" ||
    !("session" in body) ||
    typeof body.session !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.session) ||
    !("generation" in body) ||
    typeof body.generation !== "number" ||
    !Number.isSafeInteger(body.generation) ||
    body.generation < 0 ||
    body.generation > 9_999_999_999 ||
    !("runnerId" in body) ||
    typeof body.runnerId !== "string" ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(body.runnerId)
  )
    return json({ error: "Choose a runner for the current assignment." }, 400);
  const { session, generation, runnerId } = body;
  return immediate(options.db, () => {
    const scope = options.assignments.onboardingContext(session, generation, options.principal);
    if (!scope) return json({ error: "Onboarding is unavailable." }, 404);
    const at = (options.now ?? Date.now)();
    const runner = listOnboardingRunners(options.db, scope, at).find(
      (entry) => entry.id === runnerId,
    );
    if (!runner)
      return json({ error: "This runner is no longer available for this assignment." }, 409);
    const previous = readOnboardingVm(options.db, scope);
    if (previous?.runnerId !== runner.id || previous.fence !== runner.fence) {
      saveOnboardingVm(options.db, scope, runner, at);
      auditWorkspaceAccess(options.db, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        action: "assignment.vm_selected",
        subject: scope.sessionId,
        now: at,
      });
    }
    return json(onboardingVmState(options.db, scope, at));
  });
}
