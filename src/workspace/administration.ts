import { isWorkspaceAdmin } from "./eligibility";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  changeWorkspaceRole,
  changeWorkspaceRevocation,
  getWorkspace,
  listWorkspaceMembers,
  listWorkspaceAudit,
  listWorkspaceRepositories,
  replaceWorkspaceRepositories,
  workspaceMember,
  type WorkspaceRole,
  type WorkspaceSession,
} from "../db";
import type { LinearMembershipReads } from "../linear";
import { validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export async function handleWorkspaceAdministration(
  request: Request,
  options: {
    db: Database;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
    now: number;
    memberships: LinearMembershipReads;
    interruptItem?: (itemId: string) => Promise<void>;
    verifyTeam?: (id: string, signal: AbortSignal) => Promise<boolean>;
  },
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    path !== "/api/workspaces/members" &&
    path !== "/api/workspaces/repositories" &&
    path !== "/api/workspaces/audit"
  )
    return null;
  const principal = options.principal;
  const deny = (message: string) => {
    auditWorkspaceAccess(options.db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "access.denied",
      subject: path,
      now: options.now,
    });
    return Response.json(
      { error: message },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  };
  if (!isWorkspaceAdmin(principal.role)) return deny("Workspace administration is required.");
  if (path === "/api/workspaces/audit") {
    if (request.method !== "GET")
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    const cursor = new URL(request.url).searchParams.get("before");
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
    if (
      (cursor !== null && !/^[1-9][0-9]*$/.test(cursor)) ||
      !Number.isSafeInteger(before) ||
      before < 1
    )
      return Response.json({ error: "Invalid audit cursor." }, { status: 400 });
    return Response.json(listWorkspaceAudit(options.db, principal.workspaceId, before), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (request.method === "GET")
    return Response.json(
      path.endsWith("/members")
        ? { members: listWorkspaceMembers(options.db, principal.workspaceId) }
        : { repositories: listWorkspaceRepositories(options.db, principal.workspaceId) },
      { headers: { "cache-control": "no-store" } },
    );
  if (request.method !== "PUT")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (
    request.headers.get("origin") !== options.origin ||
    !validWorkspaceCsrf(request, options.session)
  )
    return deny("CSRF token required.");
  let body: unknown;
  try {
    body = await readWorkspaceJson(request);
  } catch (caughtError1) {
    journalCaught(
      caughtError1,
      "administration.handleWorkspaceAdministration.readWorkspaceJson",
      null,
    );
    return Response.json({ error: "Expected a JSON body of at most 16 KiB." }, { status: 400 });
  }
  if (!record(body))
    return Response.json({ error: "Invalid workspace settings." }, { status: 400 });
  try {
    if (path.endsWith("/members")) {
      if (
        Object.keys(body).length !== 2 ||
        typeof body["userId"] !== "string" ||
        !(
          typeof body["revoked"] === "boolean" ||
          (typeof body["role"] === "string" && ["admin", "member"].includes(body["role"]))
        )
      )
        throw new Error("Choose a workspace member and role.");
      const member = workspaceMember(options.db, principal.workspaceId, body["userId"]);
      const workspace = getWorkspace(options.db, principal.workspaceId);
      if (member === null || workspace === null) throw new Error("Choose a workspace member.");
      if (typeof body["revoked"] === "boolean") {
        const stopped = changeWorkspaceRevocation(options.db, {
          workspaceId: principal.workspaceId,
          actorId: principal.userId,
          userId: member.userId,
          revoked: body["revoked"],
          now: options.now,
        });
        // The durable stop is already committed. Interrupt the attached execution as well.
        for (const itemId of stopped) {
          try {
            await options.interruptItem?.(itemId);
          } catch (error) {
            journalCaught(error, "administration.revoke.interruptItem", itemId);
          }
        }
        return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      }
      const verified = await options.memberships.member(
        workspace.organizationId,
        member.linearUserId,
        AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      );
      if (
        verified.organizationId !== workspace.organizationId ||
        verified.userId !== member.linearUserId
      )
        throw new Error("Linear membership could not be verified.");
      changeWorkspaceRole(options.db, {
        workspaceId: principal.workspaceId,
        actorId: principal.userId,
        userId: body["userId"],
        role: body["role"] as WorkspaceRole,
        now: options.now,
        verified,
      });
    } else {
      if (
        Object.keys(body).length !== 1 ||
        !Array.isArray(body["repositories"]) ||
        body["repositories"].length > 100
      )
        throw new Error("Choose repositories and their Linear teams.");
      const repositories: { repository: string; teamId: string }[] = [];
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      for (const entry of body["repositories"]) {
        if (
          !record(entry) ||
          Object.keys(entry).length !== 2 ||
          typeof entry["repository"] !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry["repository"]) ||
          typeof entry["teamId"] !== "string" ||
          entry["teamId"].trim() === "" ||
          entry["teamId"].length > 200
        )
          throw new Error("Choose a repository and its Linear team.");
        if (
          options.verifyTeam === undefined ||
          !(await options.verifyTeam(entry["teamId"], signal))
        )
          throw new Error("The Linear team could not be verified.");
        repositories.push({
          repository: entry["repository"].toLowerCase(),
          teamId: entry["teamId"],
        });
      }
      const current = getWorkspace(options.db, principal.workspaceId);
      if (current === null) throw new Error("Workspace no longer exists.");
      replaceWorkspaceRepositories(options.db, {
        workspaceId: principal.workspaceId,
        actorId: principal.userId,
        repositories,
        now: options.now,
      });
    }
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    journalCaught(error, "administration.handleWorkspaceAdministration.endsWith", null);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Workspace settings could not be changed.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function readWorkspaceJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new Error("Expected JSON");
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      length += result.value.byteLength;
      if (length > 16 * 1024) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
