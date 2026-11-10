import {
  workspaceMemberUsable,
  auditWorkspaceAccessSteps,
  emitJobReady,
  enqueueJobSteps,
  listWorkspaceRepositoriesSteps,
  sqliteDb,
  workspaceMemberSteps,
  type Q,
  type Steps,
  type WorkspaceSession,
} from "../db";
import { isWorkspaceAdmin } from "./eligibility";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export async function handleWorkspaceGitHubIntegration(
  request: Request,
  options: {
    db: Database;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
    now: () => number;
    check: (repository: string, signal: AbortSignal) => Promise<boolean>;
  },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/workspaces/github-integration") return null;
  const principal = options.principal;
  const store = sqliteDb(options.db);
  function* permittedSteps(q: Q) {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
  }
  const auditSteps = (q: Q, action: string) =>
    auditWorkspaceAccessSteps(q, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject: "github-integration",
      now: options.now(),
    });
  function* denySteps(q: Q) {
    yield* auditSteps(q, "access.denied");
    return Response.json(
      { error: "Workspace administration and a valid CSRF token are required." },
      { status: 403 },
    );
  }
  const deny = () => store.run(denySteps);
  if (!(await store.run(permittedSteps))) return deny();
  if (!["GET", "POST"].includes(request.method))
    return Response.json({ error: "Use GET or POST." }, { status: 405 });
  const repositories = await store.run((q) =>
    listWorkspaceRepositoriesSteps(q, principal.workspaceId),
  );
  if (request.method === "GET")
    return Response.json(
      {
        authority: "github-app-installation",
        repositories,
        recovery: "POST /api/workspaces/github-integration",
      },
      { headers: { "cache-control": "no-store" } },
    );
  function* authorizedSteps(q: Q) {
    return (
      (yield* permittedSteps(q)) &&
      request.headers.get("origin") === options.origin &&
      validWorkspaceCsrf(request, options.session)
    );
  }
  if (!(await store.run(authorizedSteps))) return deny();
  const snapshot = JSON.stringify(repositories);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  let ready = repositories.length > 0;
  try {
    for (const repository of new Set(repositories.map((entry) => entry.repository))) {
      if (!(await options.check(repository, signal))) ready = false;
    }
  } catch (caughtError1) {
    journalCaught(caughtError1, "github-integration.handleWorkspaceGitHubIntegration.map", null);
    ready = false;
  }
  const { response, queued } = await store.transaction(function* (q): Steps<{
    response: Response;
    queued: boolean;
  }> {
    if (
      !(yield* authorizedSteps(q)) ||
      JSON.stringify(yield* listWorkspaceRepositoriesSteps(q, principal.workspaceId)) !== snapshot
    )
      return { response: yield* denySteps(q), queued: false };
    if (!ready || signal.aborted) {
      yield* auditSteps(q, "github.integration.unavailable");
      return {
        response: Response.json(
          {
            error:
              "Restore the configured GitHub App installation and approved repository permissions, then retry.",
          },
          { status: 409 },
        ),
        queued: false,
      };
    }
    yield* auditSteps(q, "github.integration.revalidated");
    yield* enqueueJobSteps(q, { queue: "github.auth.recover", priority: 0, now: options.now() });
    return {
      response: Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }),
      queued: true,
    };
  });
  // Wake the job loop once the recovery job is committed.
  if (queued) emitJobReady(store);
  return response;
}
