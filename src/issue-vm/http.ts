import { issueVmSettings, parseConfigToml } from "../config";
import {
  activeIssueVmGrantsSteps,
  auditWorkspaceAccessSteps,
  CONFIG_SETTINGS_KEY,
  insertIssueVmGrantSteps,
  issueVmStateCountsSteps,
  listWorkspaceMembersSteps,
  readSettingSteps,
  revokeIssueVmGrantSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type IssueVmGrant,
  type Q,
} from "../db";
import { journalCaught } from "../journal";
import { json, localRequest, readJson, sameToken } from "../settings";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";

export const ISSUE_VM_MEMBERS_PATH = "/api/settings/issue-vm/members";
export const ISSUE_VM_GRANTS_PATH = "/api/settings/issue-vm/grants";
const GRANT_PATH = /^\/api\/settings\/issue-vm\/grants\/([0-9A-Za-z]+)$/;

const DAY = 86_400_000;
const MAX_GRANT_DAYS = 90;

export type IssueVmGrantView = Omit<IssueVmGrant, "workspaceId">;

export type IssueVmMemberView = {
  userId: string;
  name: string | null;
  role: string;
  inUse: { creating: number; awake: number; asleep: number; total: number };
  limit: number;
  grant: IssueVmGrantView | null;
};

export type IssueVmHttpOptions = {
  db: Db;
  principal: WorkspacePrincipal;
  csrfToken: string;
  trustedOrigin?: string;
  now?: () => number;
};

export function isIssueVmGrantPath(path: string): boolean {
  return path === ISSUE_VM_MEMBERS_PATH || path === ISSUE_VM_GRANTS_PATH || GRANT_PATH.test(path);
}

function view({ workspaceId: _workspaceId, ...grant }: IssueVmGrant): IssueVmGrantView {
  return grant;
}

function* membersSteps(q: Q, workspaceId: string, at: number) {
  const text = yield* readSettingSteps(q, CONFIG_SETTINGS_KEY);
  const defaultLimit = issueVmSettings(
    text === null ? undefined : parseConfigToml(text).issueVm,
  ).perMember;
  const members = (yield* listWorkspaceMembersSteps(q, workspaceId)).filter(workspaceMemberUsable);
  const grants = yield* activeIssueVmGrantsSteps(q, { workspaceId, at });
  const counts = yield* issueVmStateCountsSteps(q, workspaceId);
  return {
    defaultLimit,
    members: members.map((member): IssueVmMemberView => {
      const inUse = { creating: 0, awake: 0, asleep: 0, total: 0 };
      for (const row of counts.filter((count) => count.memberUserId === member.id)) {
        if (row.state === "creating" || row.state === "awake" || row.state === "asleep")
          inUse[row.state] += row.vms;
        inUse.total += row.vms;
      }
      const grant = grants.find((candidate) => candidate.memberUserId === member.id);
      return {
        userId: member.id,
        name: member.name,
        role: member.role,
        inUse,
        limit: grant?.limit ?? defaultLimit,
        grant: grant === undefined ? null : view(grant),
      };
    }),
  };
}

type GrantInput = { memberUserId: string; limit: number; endsAt: number };

function parseGrant(body: unknown, now: number): GrantInput | string {
  if (typeof body !== "object" || body === null) return "Expected a JSON object";
  const { memberUserId, limit, endsAt } = body as Record<string, unknown>;
  if (typeof memberUserId !== "string" || memberUserId === "") return "memberUserId is required";
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    return "limit must be a whole number from 1 to 50";
  const ends = typeof endsAt === "string" ? Date.parse(endsAt) : endsAt;
  if (typeof ends !== "number" || !Number.isSafeInteger(ends))
    return "endsAt must be a time in milliseconds or an ISO date";
  if (ends <= now) return "endsAt must be in the future";
  if (ends > now + MAX_GRANT_DAYS * DAY)
    return `endsAt must be at most ${MAX_GRANT_DAYS} days ahead`;
  return { memberUserId, limit, endsAt: ends };
}

function describe(name: string | null, userId: string, grant: { limit: number; endsAt: number }) {
  return `${name ?? userId} (${userId}): ${grant.limit} issue VMs until ${new Date(grant.endsAt).toISOString()}`;
}

export async function handleIssueVmGrantRequest(
  request: Request,
  options: IssueVmHttpOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!isIssueVmGrantPath(path)) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Issue VM grants are only available on the local Paws origin" }, 403);
  const { db, principal } = options;
  const admin = isWorkspaceAdmin(principal.role);
  const now = (options.now ?? Date.now)();
  if (path === ISSUE_VM_MEMBERS_PATH) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const listing = await db.run((q) => membersSteps(q, principal.workspaceId, now));
    if (admin) return json(listing);
    return json({
      defaultLimit: listing.defaultLimit,
      members: listing.members.filter((member) => member.userId === principal.userId),
    });
  }
  if (!admin) return json({ error: "Only workspace admins can grant issue VMs." }, 403);
  const revoking = GRANT_PATH.exec(path)?.[1];
  if (request.method !== (revoking === undefined ? "POST" : "DELETE"))
    return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  if (revoking !== undefined) {
    const revoked = await db.transaction(function* (q) {
      const grant = yield* revokeIssueVmGrantSteps(q, {
        workspaceId: principal.workspaceId,
        id: revoking,
        now,
      });
      if (grant === null) return null;
      const member = yield* workspaceMemberSteps(q, principal.workspaceId, grant.memberUserId);
      yield* auditWorkspaceAccessSteps(q, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: "settings.issue_vm_grant_revoked",
        subject: `Revoked issue VM grant for ${describe(member?.name ?? null, grant.memberUserId, grant)}`,
        now,
      });
      return grant;
    });
    if (revoked === null) return json({ error: "No active issue VM grant with that id" }, 404);
    return json({ grant: view(revoked) });
  }
  let input: GrantInput | string;
  try {
    input = parseGrant(await readJson(request), now);
  } catch (error) {
    journalCaught(error, "issue-vm.handleIssueVmGrantRequest.parse", null);
    input = "Expected a JSON body";
  }
  if (typeof input === "string") return json({ error: input }, 400);
  const grant = input;
  const created = await db.transaction(function* (q) {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, grant.memberUserId);
    if (!workspaceMemberUsable(member)) return null;
    const id = yield* insertIssueVmGrantSteps(q, {
      workspaceId: principal.workspaceId,
      grantedBy: principal.userId,
      now,
      ...grant,
    });
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "settings.issue_vm_grant",
      subject: `Granted ${describe(member.name, grant.memberUserId, grant)}`,
      now,
    });
    return { id, ...grant, grantedBy: principal.userId, createdAt: now, revokedAt: null };
  });
  if (created === null) return json({ error: "That person is not a workspace member" }, 404);
  return json({ grant: created }, 201);
}
