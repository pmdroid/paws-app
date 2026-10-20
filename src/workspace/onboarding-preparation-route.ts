import type { Database } from "bun:sqlite";
import type { WorkspaceSession } from "../db";
import type { WorkspaceAssignments } from "./assignments";
import { readWorkspaceJson } from "./administration";
import { PREPARATION_MODES, type createOnboardingPreparation } from "./onboarding-preparation";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

type Preparation = Pick<ReturnType<typeof createOnboardingPreparation>, "read" | "answer">;

export async function handleOnboardingPreparation(
  request: Request,
  options: {
    db: Database;
    assignments: Pick<WorkspaceAssignments, "onboardingContext">;
    preparation: Preparation;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/workspaces/onboarding/preparation") return null;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  const mutation = request.method === "POST";
  if (
    mutation &&
    (url.origin !== options.origin ||
      request.headers.get("origin") !== options.origin ||
      !validWorkspaceCsrf(request, options.session) ||
      options.session.workspaceId !== options.principal.workspaceId ||
      options.session.userId !== options.principal.userId)
  )
    return json({ error: "CSRF token required." }, 403);
  const selectedWorkspace =
    url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
  if (selectedWorkspace !== null && selectedWorkspace !== options.principal.workspaceId)
    return json({ error: "Workspace access denied." }, 403);
  const body = mutation
    ? await readWorkspaceJson(request).catch(() => null)
    : Object.fromEntries(url.searchParams);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ error: "Choose the current assignment." }, 400);
  const value = body as Record<string, unknown>;
  const required = mutation ? ["session", "generation", "revision"] : ["session", "generation"];
  const allowed = mutation ? [...required, "mode", "repository"] : required;
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.session !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.session)
  )
    return json({ error: "Choose the current assignment." }, 400);
  const generation = mutation ? value.generation : Number(value.generation);
  if (
    (mutation && typeof value.generation !== "number") ||
    (!mutation &&
      (typeof value.generation !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value.generation))) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 9_999_999_999
  )
    return json({ error: "Choose the current assignment." }, 400);
  const context = { sessionId: value.session, generation };
  const scope = options.assignments.onboardingContext(
    context.sessionId,
    generation,
    options.principal,
  );
  if (!scope) return json({ error: "Onboarding is unavailable." }, 404);
  if (!mutation) {
    const current = options.preparation.read(context);
    return current ? json(current) : json({ error: "Assignment preparation is unavailable." }, 404);
  }
  if (
    (value.mode !== undefined &&
      (typeof value.mode !== "string" ||
        !PREPARATION_MODES.includes(value.mode as (typeof PREPARATION_MODES)[number]))) ||
    (value.repository !== undefined && typeof value.repository !== "string") ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    return json({ error: "Choose an offered task mode." }, 400);
  try {
    return json(
      options.preparation.answer(
        context,
        {
          workspaceId: options.principal.workspaceId,
          userId: options.principal.userId,
        },
        {
          revision: value.revision,
          ...(value.mode !== undefined
            ? { mode: value.mode as (typeof PREPARATION_MODES)[number] }
            : {}),
          ...(value.repository !== undefined ? { repository: value.repository } : {}),
        },
      ),
    );
  } catch {
    return json({ error: "Assignment preparation changed." }, 409);
  }
}
