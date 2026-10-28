import { workspaceMemberUsable } from "../db";
import { isWorkspaceAdmin } from "./eligibility";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  enqueueJob,
  immediate,
  listWorkspaceRepositories,
  workspaceMember,
  type WorkspaceSession,
} from "../db";
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
  const permitted = () => {
    const member = workspaceMember(options.db, principal.workspaceId, principal.userId);
    return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
  };
  const audit = (action: string) =>
    auditWorkspaceAccess(options.db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject: "github-integration",
      now: options.now(),
    });
  const deny = () => {
    audit("access.denied");
    return Response.json(
      { error: "Workspace administration and a valid CSRF token are required." },
      { status: 403 },
    );
  };
  if (!permitted()) return deny();
  if (!["GET", "POST"].includes(request.method))
    return Response.json({ error: "Use GET or POST." }, { status: 405 });
  const repositories = listWorkspaceRepositories(options.db, principal.workspaceId);
  if (request.method === "GET")
    return Response.json(
      {
        authority: "github-app-installation",
        repositories,
        recovery: "POST /api/workspaces/github-integration",
      },
      { headers: { "cache-control": "no-store" } },
    );
  const authorized = () =>
    permitted() &&
    request.headers.get("origin") === options.origin &&
    validWorkspaceCsrf(request, options.session);
  if (!authorized()) return deny();
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
  return immediate(options.db, () => {
    if (
      !authorized() ||
      JSON.stringify(listWorkspaceRepositories(options.db, principal.workspaceId)) !== snapshot
    )
      return deny();
    if (!ready || signal.aborted) {
      audit("github.integration.unavailable");
      return Response.json(
        {
          error:
            "Restore the configured GitHub App installation and approved repository permissions, then retry.",
        },
        { status: 409 },
      );
    }
    audit("github.integration.revalidated");
    enqueueJob(options.db, { queue: "github.auth.recover", priority: 0, now: options.now() });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  });
}
