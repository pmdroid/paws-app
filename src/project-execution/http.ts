import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  auditWorkspaceAccess,
  getWorkspace,
  listWorkspaceMembers,
  listWorkspaceRepositories,
  workspaceMember,
} from "../db";
import type { TrackerAdapter } from "../linear";
import { ExternalBlockerPolicySchema } from "../intake";
import type { WorkspacePrincipal } from "../workspace";
import { assertProjectAuthority, assertProjectTeamAccess, type ProjectApproval } from "./approval";
import type { createApprovedProjects } from "./runtime";

const text = z.string().trim().min(1).max(200);
const selection = z
  .object({
    projectId: text,
    issueIds: z.array(text).min(1).max(200),
    repository: text,
    targetBranch: z.literal("main"),
    leadUserId: text,
    steeringRoles: z
      .array(z.enum(["owner", "admin", "member"]))
      .min(1)
      .max(3),
    blockers: z.array(ExternalBlockerPolicySchema).max(200).optional(),
  })
  .strict();
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), selection }).strict(),
  z
    .object({
      action: z.literal("approve"),
      id: text,
      generation: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ action: z.enum(["pause", "resume", "stop"]), id: text }).strict(),
]);

export function createProjectHttp(input: {
  db: Database;
  tracker: TrackerAdapter;
  projects: ReturnType<typeof createApprovedProjects>;
}) {
  return async (request: Request, principal: WorkspacePrincipal): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/projects") return null;
    const actor = { workspaceId: principal.workspaceId, userId: principal.userId };
    const member = workspaceMember(input.db, actor.workspaceId, actor.userId);
    const deny = () => {
      auditWorkspaceAccess(input.db, {
        ...actor,
        action: "access.denied",
        subject: "projects",
        now: Date.now(),
      });
      return json({ error: "An active workspace member is required." }, 403);
    };
    if (!member?.active || member.role === "observer") return deny();
    function visible(approval: ProjectApproval) {
      const current = assertProjectTeamAccess(input.db, actor, approval.preview).member;
      let lastError = approval.lastError;
      if (approval.stoppedAt === null) {
        try {
          assertProjectAuthority(input.db, actor, approval.preview, approval.source);
        } catch {
          lastError =
            "Execution access changed. Restore lead and repository access before resuming.";
        }
      }
      const issues = approval.preview.project.issues.filter((issue) =>
        current.teamIds.includes(issue.teamId),
      );
      return {
        ...approval,
        lastError,
        preview: {
          ...approval.preview,
          project: { ...approval.preview.project, issues },
          excludedIssueIds: approval.preview.excludedIssueIds.filter((id) =>
            issues.some((issue) => issue.linearIssueId === id),
          ),
        },
        progress: input.projects.progress(approval.id),
      };
    }
    if (request.method === "GET") {
      const id = url.searchParams.get("projectId");
      if (id !== null) {
        if (!text.safeParse(id).success)
          return json({ error: "Enter a Linear project URL or ID." }, 400);
        if (!input.tracker.loadProject)
          return json({ error: "Linear project reads are not ready." }, 503);
        try {
          const project = await input.tracker.loadProject(id, {
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
          });
          if (project.organizationId !== getWorkspace(input.db, actor.workspaceId)?.organizationId)
            return deny();
          const current = workspaceMember(input.db, actor.workspaceId, actor.userId);
          if (!current?.active || current.role === "observer") return deny();
          const issues = project.issues.filter((issue) => current.teamIds.includes(issue.teamId));
          if (!issues.length) return deny();
          return json({ project: { ...project, issues } });
        } catch {
          return json(
            {
              error: "This Linear project could not be loaded. Check its URL or ID and try again.",
            },
            503,
          );
        }
      }
      const approvals = input.projects.list(actor.workspaceId).flatMap((approval) => {
        try {
          return [visible(approval)];
        } catch {
          return [];
        }
      });
      return json({
        approvals,
        userId: actor.userId,
        repositories: listWorkspaceRepositories(input.db, actor.workspaceId).filter((entry) =>
          member.teamIds.includes(entry.teamId),
        ),
        members: listWorkspaceMembers(input.db, actor.workspaceId).filter(
          (entry) => entry.active && entry.role !== "observer",
        ),
      });
    }
    if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    let parsed: z.infer<typeof action>;
    try {
      const reader = request.body?.getReader();
      if (!reader || !request.headers.get("content-type")?.startsWith("application/json"))
        throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 64_000) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      parsed = action.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return json({ error: "Send a bounded project selection or approval action." }, 400);
    }
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      if (parsed.action === "preview")
        return json({
          approval: visible(await input.projects.preview(actor, parsed.selection, signal)),
        });
      if (parsed.action === "approve")
        return json({
          approval: visible(
            await input.projects.approve(actor, parsed.id, parsed.generation, signal),
          ),
        });
      await input.projects.control(actor, parsed.id, parsed.action);
      return json({ applied: true });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "Project action could not be completed.",
        },
        409,
      );
    }
  };
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
