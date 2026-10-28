import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  enqueueJobOnce,
  reviewFindingsByIds,
  getFindingGroup,
  immediate,
  lastFindingGroupRun,
  listFindingGroups,
  markReviewFindingFiled,
  reviewFindingItems,
  setReviewFindingStatus,
  workspaceMember,
  type FindingGroup,
  type ReviewFindingRecord,
} from "../../../db";
import { journalCaught } from "../journal";
import { findingView, type FindingsOptions } from "./findings";
import { FINDING_GROUPS_API_PATH, type FindingGroupsResponse } from "../finding-groups";

/** Linear writes are injected by process composition; the dashboard owns no tracker client. */
export type FindingGroupServices = {
  issues: {
    file(input: {
      key: string;
      teamId: string;
      title: string;
      description: string;
    }): Promise<string>;
    add(input: { key: string; teamId: string; identifier: string; body: string }): Promise<void>;
  };
};
const activeActions = new Set<string>();
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("run") }),
  z.strictObject({ action: z.literal("file"), id: z.string().uuid() }),
  z.strictObject({ action: z.literal("add"), id: z.string().uuid() }),
  z.strictObject({
    action: z.literal("dismiss"),
    id: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
]);
function members(
  db: Database,
  group: FindingGroup,
  sessions?: readonly string[],
  snapshot?: {
    rows: Map<number, ReviewFindingRecord>;
    items: ReturnType<typeof reviewFindingItems>;
  },
): { rows: ReviewFindingRecord[]; items: ReturnType<typeof reviewFindingItems> } | null {
  const available =
    snapshot?.rows ?? new Map(reviewFindingsByIds(db, group.memberIds).map((f) => [f.id, f]));
  const rows = group.memberIds.map((id) => available.get(id));
  if (rows.some((r) => r === undefined)) return null;
  const items = snapshot?.items ?? reviewFindingItems(db, group.memberIds);
  if (
    sessions !== undefined &&
    group.memberIds.some(
      (id) =>
        !(items.get(id) ?? []).some(
          (i) => i.sessionKey !== null && sessions.includes(i.sessionKey),
        ),
    )
  )
    return null;
  return { rows: rows as ReviewFindingRecord[], items };
}
export async function handleFindingGroupsRequest(
  request: Request,
  options: FindingsOptions & {
    services?: FindingGroupServices;
  },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== FINDING_GROUPS_API_PATH) return null;
  const { db, principal } = options;
  const workspaceId =
    principal?.workspaceId ??
    db.query<{ id: string }, []>("SELECT id FROM workspace ORDER BY id LIMIT 1").get()?.id;
  const member = principal ? workspaceMember(db, principal.workspaceId, principal.userId) : null;
  if (request.method === "GET") {
    const data: FindingGroupsResponse = {
      groups: [],
      lastRun: null,
      canRun: !!member?.active && ["admin", "owner"].includes(member.role),
    };
    if (workspaceId && (!principal || member?.active)) {
      const groups = listFindingGroups(db, workspaceId, 200);
      const snapshot = {
        rows: new Map(
          reviewFindingsByIds(
            db,
            groups.flatMap((g) => g.memberIds),
          ).map((f) => [f.id, f]),
        ),
        items: reviewFindingItems(
          db,
          groups.flatMap((g) => g.memberIds),
        ),
      };
      data.groups = groups.flatMap((group) => {
        const accessible = members(db, group, options.sessionIds, snapshot);
        if (!accessible) return [];
        const { items } = accessible;
        const rows =
          group.status === "open" && !group.action
            ? accessible.rows.filter((f) => f.status === "open")
            : accessible.rows;
        if (!rows.length) return [];
        return [
          {
            ...group,
            memberIds: rows.map((f) => f.id),
            findings: rows.map((f) =>
              findingView(
                f,
                (items.get(f.id) ?? []).filter(
                  (i) =>
                    options.sessionIds === undefined ||
                    (i.sessionKey !== null && options.sessionIds.includes(i.sessionKey)),
                ),
              ),
            ),
          },
        ];
      });
      data.lastRun = lastFindingGroupRun(db, workspaceId);
    }
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  }
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  if (!principal) return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  if (!member?.active || member.role === "observer")
    return Response.json({ error: "You cannot change finding groups." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    journalCaught(error, "finding-groups.json", null);
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "Choose a group action and include a reason when dismissing." },
      { status: 400 },
    );
  const action = parsed.data;
  const now = (options.now ?? Date.now)();
  if (action.action === "run") {
    if (!["admin", "owner"].includes(member.role))
      return Response.json({ error: "Only admins can run grouping." }, { status: 403 });
    if (!options.services)
      return Response.json({ error: "Finding grouping is unavailable." }, { status: 503 });
    const day = new Date(now).toISOString().slice(0, 10);
    const last = lastFindingGroupRun(db, principal.workspaceId);
    if (last && new Date(last.startedAt).toISOString().slice(0, 10) === day)
      return Response.json(
        { error: "Grouping already ran today. The next helper turn is available tomorrow UTC." },
        { status: 409 },
      );
    enqueueJobOnce(db, {
      queue: "findings.group",
      jobKey: `findings.group.manual:${principal.workspaceId}:${day}`,
      payload: { workspaceId: principal.workspaceId },
      now,
    });
    return Response.json({ queued: true }, { status: 202 });
  }
  const group = getFindingGroup(db, principal.workspaceId, action.id);
  if (!group) return Response.json({ error: "Group not found." }, { status: 404 });
  const accessible = members(db, group, options.sessionIds);
  if (!accessible)
    return Response.json(
      { error: "You cannot access every finding in this group." },
      { status: 403 },
    );
  const rows = group.action ? accessible.rows : accessible.rows.filter((f) => f.status === "open");
  if (group.status !== "open" || (group.action && group.action !== action.action))
    return Response.json(
      { error: "This group has already been acted on. Refresh the page." },
      { status: 409 },
    );
  if (!rows.length)
    return Response.json(
      { error: "No open findings remain in this group. Refresh the page." },
      { status: 409 },
    );
  if (action.action === "add" && !group.suggestedIssue)
    return Response.json({ error: "No existing issue was suggested." }, { status: 400 });
  if (action.action !== "dismiss" && !options.services)
    return Response.json({ error: "Linear is unavailable." }, { status: 503 });
  if (activeActions.has(group.id))
    return Response.json({ error: "This group action is still running." }, { status: 409 });
  // Store the chosen action before the network write. Stable Linear ids make retries safe.
  const claimed = db.run(
    "UPDATE finding_group SET action=?,member_ids=? WHERE id=? AND status='open' AND (action IS NULL OR action=?)",
    [action.action, JSON.stringify(rows.map((f) => f.id)), group.id, action.action],
  ).changes;
  if (!claimed)
    return Response.json({ error: "The group changed. Refresh the page." }, { status: 409 });
  activeActions.add(group.id);
  const by = member.name || member.email || principal.userId;
  let identifier: string | null = null;
  try {
    if (action.action === "file")
      identifier = await options.services!.issues.file({
        key: group.id,
        teamId: group.teamId,
        title: group.title,
        description: groupDescription(group, rows),
      });
    if (action.action === "add") {
      await options.services!.issues.add({
        key: group.id,
        teamId: group.teamId,
        identifier: group.suggestedIssue!,
        body: groupDescription(group, rows),
      });
      identifier = group.suggestedIssue;
    }
    immediate(db, () => {
      for (const finding of rows) {
        if (action.action === "dismiss")
          setReviewFindingStatus(db, {
            id: finding.id,
            status: "dismissed",
            reason: action.reason,
            by,
            now,
          });
        else markReviewFindingFiled(db, { key: finding.key, issue: identifier!, by, now });
      }
      db.run(
        "UPDATE finding_group SET status=?,status_reason=?,status_by=?,status_at=?,filed_issue=? WHERE id=?",
        [
          action.action === "file" ? "filed" : action.action === "add" ? "added" : "dismissed",
          action.action === "dismiss" ? action.reason : null,
          by,
          now,
          identifier,
          group.id,
        ],
      );
      auditWorkspaceAccess(db, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: `finding-group.${action.action}`,
        subject: group.id,
        now,
      });
    });
    return Response.json({ ok: true, identifier });
  } catch (error) {
    journalCaught(error, "finding-groups.action", null);
    // The adapter checks the stable Linear id before a definitive refusal, including on retries.
    if (error instanceof Error && "noFindingWrite" in error && error.noFindingWrite === true)
      db.run("UPDATE finding_group SET action=NULL WHERE id=? AND status='open' AND action=?", [
        group.id,
        action.action,
      ]);
    return Response.json(
      { error: "Linear could not finish this action. Retry the same action safely." },
      { status: 502 },
    );
  } finally {
    activeActions.delete(group.id);
  }
}

function groupDescription(
  group: Pick<FindingGroup, "summary" | "scope">,
  findings: readonly ReviewFindingRecord[],
): string {
  return `${group.summary}\n\nScope: ${group.scope}\n\n## Review findings\n\n${findings.map((f) => `- ${f.repository} ${f.path}${f.lines ? `:${f.lines}` : ""} (${f.severity}, ${f.review}): ${f.text}`).join("\n")}`;
}
