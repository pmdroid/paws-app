import { configFromSections, issueVmSettings } from "../config";
import {
  activeIssueVmGrantsSteps,
  auditWorkspaceAccessSteps,
  insertIssueVmGrantSteps,
  issueVmStateCountsSteps,
  listWorkspaceMembersSteps,
  readSettingSectionsSteps,
  revokeIssueVmGrantSteps,
  saveIssueVmSpendSettingsSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type IssueVmGrant,
  type IssueVmSpendSettings,
  type Q,
} from "../db";
import { journalCaught } from "../journal";
import { json, localRequest, readJson, sameToken } from "../settings";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import { ISSUE_VM_DRIVER_MISSING } from "./dispatch";
import { DEFAULT_MONTHLY_LIMIT_USD, issueVmSpendSteps } from "./spend";

function* spendViewSteps(q: Q, workspaceId: string, at: number) {
  const unavailable = { boat: ISSUE_VM_DRIVER_MISSING, instabox: ISSUE_VM_DRIVER_MISSING };
  return { ...(yield* issueVmSpendSteps(q, { workspaceId, at })), unavailable };
}

export const ISSUE_VM_MEMBERS_PATH = "/api/settings/issue-vm/members";
export const ISSUE_VM_GRANTS_PATH = "/api/settings/issue-vm/grants";
export const ISSUE_VM_SPEND_PATH = "/api/settings/issue-vm/spend";
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
  return (
    path === ISSUE_VM_MEMBERS_PATH ||
    path === ISSUE_VM_GRANTS_PATH ||
    path === ISSUE_VM_SPEND_PATH ||
    GRANT_PATH.test(path)
  );
}

function view({ workspaceId: _workspaceId, ...grant }: IssueVmGrant): IssueVmGrantView {
  return grant;
}

function* membersSteps(q: Q, workspaceId: string, at: number) {
  const sections = yield* readSettingSectionsSteps(q, ["issue_vm"]);
  const defaultLimit = issueVmSettings(configFromSections(sections).issueVm).perMember;
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

const MAX_USD = 1_000_000;

type SpendChanges = Partial<IssueVmSpendSettings>;

function amount(value: unknown, name: string): number | string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USD)
    return `${name} must be a number of US dollars from 0 to ${MAX_USD}`;
  return value;
}

function parseSpend(body: unknown): SpendChanges | string {
  if (typeof body !== "object" || body === null) return "Expected a JSON object";
  const { monthlyLimitUsd, prices } = body as Record<string, unknown>;
  const changes: SpendChanges = {};
  if (monthlyLimitUsd !== undefined) {
    const limit = amount(monthlyLimitUsd, "monthlyLimitUsd");
    if (typeof limit === "string") return limit;
    changes.monthlyLimitUsd = limit;
  }
  if (prices !== undefined) {
    if (typeof prices !== "object" || prices === null) return "prices must be an object";
    for (const [provider, value] of Object.entries(prices)) {
      if (provider !== "boat" && provider !== "instabox")
        return "prices takes only boat and instabox";
      const price = amount(value, `prices.${provider}`);
      if (typeof price === "string") return price;
      changes[provider === "boat" ? "boatHourlyUsd" : "instaboxHourlyUsd"] = price;
    }
  }
  if (Object.keys(changes).length === 0) return "Expected monthlyLimitUsd or prices";
  return changes;
}

async function handleSpend(request: Request, options: IssueVmHttpOptions, now: number) {
  const { db, principal } = options;
  const workspaceId = principal.workspaceId;
  if (request.method === "GET")
    return json(await db.run((q) => spendViewSteps(q, workspaceId, now)));
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let changes: SpendChanges | string;
  try {
    changes = parseSpend(await readJson(request));
  } catch (error) {
    journalCaught(error, "issue-vm.handleSpend.parse", null);
    changes = "Expected a JSON body";
  }
  if (typeof changes === "string") return json({ error: changes }, 400);
  const update = changes;
  const saved = await db.transaction(function* (q) {
    yield* saveIssueVmSpendSettingsSteps(q, {
      workspaceId,
      changes: update,
      defaultLimitUsd: DEFAULT_MONTHLY_LIMIT_USD,
      updatedBy: principal.userId,
      now,
    });
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId,
      userId: principal.userId,
      action: "settings.issue_vm_spend",
      subject: `Set issue VM spend: ${JSON.stringify(update)}`,
      now,
    });
    return yield* spendViewSteps(q, workspaceId, now);
  });
  return json(saved);
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
  if (path === ISSUE_VM_SPEND_PATH && request.method === "GET")
    return handleSpend(request, options, now);
  if (!admin) return json({ error: "Only workspace admins can see and grant issue VMs." }, 403);
  if (path === ISSUE_VM_SPEND_PATH) return handleSpend(request, options, now);
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
