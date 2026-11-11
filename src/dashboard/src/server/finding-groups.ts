import { z } from "zod";
import {
  workspaceMemberUsable,
  acceptedImprovementsForFindings,
  auditWorkspaceAccessSteps,
  claimFindingGroupAction,
  closeFindingGroupSteps,
  enqueueJobOnce,
  findingGroupingEnabled,
  firstWorkspaceId,
  reviewFindingsByIdsSteps,
  getFindingGroup,
  lastFindingGroupRun,
  listFindingGroups,
  markReviewFindingFiledSteps,
  releaseFindingGroupAction,
  reviewFindingItemsSteps,
  setReviewFindingStatusSteps,
  workspaceMemberSteps,
  type FindingGroup,
  type Q,
  type ReviewFindingItem,
  type ReviewFindingRecord,
  type Steps,
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
type Snapshot = {
  rows: Map<number, ReviewFindingRecord>;
  items: Map<number, ReviewFindingItem[]>;
};
function* snapshotSteps(q: Q, ids: readonly number[]): Steps<Snapshot> {
  const rows = yield* reviewFindingsByIdsSteps(q, ids);
  return {
    rows: new Map(rows.map((f) => [f.id, f])),
    items: yield* reviewFindingItemsSteps(q, ids),
  };
}
function members(
  group: FindingGroup,
  snapshot: Snapshot,
  sessions?: readonly string[],
): { rows: ReviewFindingRecord[]; items: Map<number, ReviewFindingItem[]> } | null {
  const rows = group.memberIds.map((id) => snapshot.rows.get(id));
  if (rows.some((r) => r === undefined)) return null;
  const { items } = snapshot;
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
  const { principal } = options;
  const { store } = options;
  const workspaceId = principal?.workspaceId ?? (await firstWorkspaceId(store)) ?? undefined;
  const member = principal
    ? await store.run((q) => workspaceMemberSteps(q, principal.workspaceId, principal.userId))
    : null;
  if (request.method === "GET") {
    const enabled = !workspaceId || (await findingGroupingEnabled(store, workspaceId));
    const data: FindingGroupsResponse = {
      groups: [],
      lastRun: null,
      canRun: enabled && workspaceMemberUsable(member) && ["admin", "owner"].includes(member.role),
      enabled,
    };
    if (workspaceId && (!principal || workspaceMemberUsable(member))) {
      const groups = await listFindingGroups(store, workspaceId, 200);
      const snapshot = await store.run((q) =>
        snapshotSteps(
          q,
          groups.flatMap((g) => g.memberIds),
        ),
      );
      data.groups = groups.flatMap((group) => {
        const accessible = members(group, snapshot, options.sessionIds);
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
      data.lastRun = await lastFindingGroupRun(store, workspaceId);
    }
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  }
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  if (!principal) return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  if (!workspaceMemberUsable(member) || !["admin", "member"].includes(member.role))
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
    if (!(await findingGroupingEnabled(store, principal.workspaceId)))
      return Response.json(
        { error: "Daily grouping is off. Turn it on in Settings → Findings." },
        { status: 409 },
      );
    const day = new Date(now).toISOString().slice(0, 10);
    const last = await lastFindingGroupRun(store, principal.workspaceId);
    if (last && new Date(last.startedAt).toISOString().slice(0, 10) === day)
      return Response.json(
        { error: "Grouping already ran today. The next helper turn is available tomorrow UTC." },
        { status: 409 },
      );
    await enqueueJobOnce(store, {
      queue: "findings.group",
      jobKey: `findings.group.manual:${principal.workspaceId}:${day}`,
      payload: { workspaceId: principal.workspaceId },
      now,
    });
    return Response.json({ queued: true }, { status: 202 });
  }
  const group = await getFindingGroup(store, principal.workspaceId, action.id);
  if (!group) return Response.json({ error: "Group not found." }, { status: 404 });
  const accessible = members(
    group,
    await store.run((q) => snapshotSteps(q, group.memberIds)),
    options.sessionIds,
  );
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
  if (
    (
      await acceptedImprovementsForFindings(
        store,
        principal.workspaceId,
        rows.map((f) => f.id),
      )
    ).length
  )
    return Response.json(
      {
        error: "The improvement inbox already accepted these findings. Its issue delivery stands.",
      },
      { status: 409 },
    );
  if (activeActions.has(group.id))
    return Response.json({ error: "This group action is still running." }, { status: 409 });
  // Store the chosen action before the network write. Stable Linear ids make retries safe.
  const claimed = await claimFindingGroupAction(
    store,
    group.id,
    action.action,
    rows.map((f) => f.id),
  );
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
    await store.transaction(function* (q) {
      for (const finding of rows) {
        if (action.action === "dismiss") {
          const changed = yield* setReviewFindingStatusSteps(q, {
            id: finding.id,
            status: "dismissed",
            reason: action.reason,
            by,
            now,
          });
          if (!changed)
            throw Object.assign(
              new Error("A finding changed. Refresh the group before dismissing."),
              { noFindingWrite: true, findingConflict: true },
            );
        } else
          yield* markReviewFindingFiledSteps(q, {
            key: finding.key,
            issue: identifier!,
            by,
            now,
          });
      }
      yield* closeFindingGroupSteps(q, {
        id: group.id,
        status:
          action.action === "file" ? "filed" : action.action === "add" ? "added" : "dismissed",
        reason: action.action === "dismiss" ? action.reason : null,
        by,
        now,
        filedIssue: identifier,
      });
      yield* auditWorkspaceAccessSteps(q, {
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
      await releaseFindingGroupAction(store, group.id, action.action);
    if (error instanceof Error && "findingConflict" in error)
      return Response.json({ error: error.message }, { status: 409 });
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
