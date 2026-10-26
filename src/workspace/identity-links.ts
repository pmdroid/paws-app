import { isWorkspaceAdmin } from "./eligibility";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  listWorkspaceMembers,
  saveWorkspaceIdentityLink,
  workspaceIdentityCandidates,
  workspaceIdentityLinks,
  workspaceMember,
  type WorkspaceSession,
} from "../db";
import type { SlackIdentityReads } from "../slack";
import { readWorkspaceJson } from "./administration";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export function createWorkspaceIdentityLinks(options: {
  db: Database;
  slack?: SlackIdentityReads | null;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  async function syncUser(workspaceId: string, userId: string) {
    const candidate = workspaceIdentityCandidates(options.db, workspaceId).find(
      (entry) => entry.userId === userId,
    );
    if (candidate === undefined || options.slack == null) return;
    const checkedAt = now();
    let externalId: string | null = null;
    let status: "linked" | "unmatched" | "error" = "error";
    try {
      externalId = await options.slack.lookup(candidate.email, AbortSignal.timeout(10_000));
      status = externalId === null ? "unmatched" : "linked";
    } catch (caughtError1) {
      journalCaught(caughtError1, "identity-links.syncUser.lookup", null);
    }
    if (!workspaceMember(options.db, workspaceId, userId)?.active) return;
    const input = {
      workspaceId,
      userId,
      provider: "slack" as const,
      installationId: options.slack.teamId,
      method: "email" as const,
      checkedAt,
    };
    try {
      saveWorkspaceIdentityLink(options.db, { ...input, externalId, status });
    } catch (caughtError2) {
      journalCaught(caughtError2, "identity-links.syncUser.saveWorkspaceIdentityLink", null);
      saveWorkspaceIdentityLink(options.db, { ...input, externalId: null, status: "error" });
    }
  }
  return {
    syncUser,
    async syncWorkspace(workspaceId: string) {
      for (const candidate of workspaceIdentityCandidates(options.db, workspaceId))
        await syncUser(workspaceId, candidate.userId);
    },
    async handle(
      request: Request,
      context: {
        principal: WorkspacePrincipal;
        session: WorkspaceSession;
        origin: string;
        now: number;
      },
    ): Promise<Response | null> {
      if (new URL(request.url).pathname !== "/api/workspaces/identity-links") return null;
      const principal = context.principal;
      function deny(message: string) {
        auditWorkspaceAccess(options.db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "access.denied",
          subject: "/api/workspaces/identity-links",
          now: context.now,
        });
        return reply({ error: message }, 403);
      }
      if (!isWorkspaceAdmin(principal.role)) return deny("Workspace administration is required.");
      if (request.method === "GET")
        return reply({
          slackTeamId: options.slack?.teamId ?? null,
          links: workspaceIdentityLinks(options.db, principal.workspaceId),
          members: listWorkspaceMembers(options.db, principal.workspaceId),
        });
      if (request.method !== "PUT") return reply({ error: "Method not allowed" }, 405);
      if (
        request.headers.get("origin") !== context.origin ||
        !validWorkspaceCsrf(request, context.session)
      )
        return deny("CSRF token required.");
      try {
        const body = await readWorkspaceJson(request);
        const actor = workspaceMember(options.db, principal.workspaceId, principal.userId);
        if (!actor?.active || !isWorkspaceAdmin(actor.role))
          return deny("Workspace administration is required.");
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 3 ||
          !("userId" in body) ||
          !("provider" in body) ||
          !("externalId" in body) ||
          typeof body.userId !== "string" ||
          (body.provider !== "slack" && body.provider !== "github") ||
          (body.externalId !== null && typeof body.externalId !== "string")
        )
          throw new Error("Choose a member, provider and identity.");
        const externalId = body.externalId;
        if (
          externalId !== null &&
          (body.provider === "slack"
            ? options.slack == null || !/^[UW][A-Z0-9]+$/.test(externalId)
            : !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(externalId))
        )
          throw new Error("Enter a valid account identity.");
        saveWorkspaceIdentityLink(options.db, {
          workspaceId: principal.workspaceId,
          actorId: principal.userId,
          userId: body.userId,
          provider: body.provider,
          externalId: body.provider === "github" ? (externalId?.toLowerCase() ?? null) : externalId,
          installationId: body.provider === "slack" ? (options.slack?.teamId ?? null) : null,
          method: body.provider === "slack" && externalId === null ? "email" : "manual",
          status: externalId === null ? "unmatched" : "linked",
          checkedAt: context.now,
        });
        return reply({ ok: true });
      } catch (error) {
        journalCaught(error, "identity-links.handle.readWorkspaceJson", null);
        const actor = workspaceMember(options.db, principal.workspaceId, principal.userId);
        if (!actor?.active || !isWorkspaceAdmin(actor.role))
          return deny("Workspace administration is required.");
        return reply(
          { error: error instanceof Error ? error.message : "Identity link could not be saved." },
          400,
        );
      }
    },
  };
}

function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
