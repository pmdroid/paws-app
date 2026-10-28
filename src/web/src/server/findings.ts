import {
  workspaceMemberUsable,
  auditWorkspaceAccess,
  listReviewFindings,
  reviewFindingItems,
  setReviewFindingStatus,
  workspaceMember,
  type ReviewFindingItem,
  type ReviewFindingRecord,
} from "../../../db";
import type { Database } from "bun:sqlite";
import { journalCaught } from "../journal";
import {
  DISMISS_REASON_LIMIT,
  FINDING_SEVERITIES,
  FINDINGS_API_PATH,
  FINDINGS_LIMIT,
  parseFindingQuery,
  type FindingAction,
  type FindingSeverity,
  type FindingsResponse,
  type FindingView,
} from "../findings";

export type FindingsOptions = {
  db: Database;
  /** The signed-in reader. Without one the list is read-only. */
  principal?: { workspaceId: string; userId: string };
  /** The sessions the reader may open. Undefined reads every item. */
  sessionIds?: readonly string[];
  now?: () => number;
};

const NO_STORE = { "cache-control": "no-store" };

/**
 * `GET /api/findings` lists the findings that match the query, and `POST /api/findings` dismisses
 * or reopens one. A finding shows when the reader can open an item that reported it. The engine
 * checks the origin and CSRF token of a POST before it reaches this handler.
 */
export async function handleFindingsRequest(
  request: Request,
  options: FindingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== FINDINGS_API_PATH) return null;
  if (request.method === "GET") return Response.json(list(options, url), { headers: NO_STORE });
  if (request.method === "POST") return change(request, options);
  return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
}

function list(options: FindingsOptions, url: URL): FindingsResponse {
  const filter = parseFindingQuery(url.searchParams);
  const pathPrefix = filter.path.replace(/^(\.\/|\/)+/, "");
  const rows = visible(
    options,
    listReviewFindings(options.db, {
      ...(filter.repository ? { repository: filter.repository } : {}),
      ...(filter.review ? { review: filter.review } : {}),
      ...(filter.status === "all" ? {} : { status: filter.status }),
      ...(pathPrefix ? { pathPrefix } : {}),
    }),
  );
  const counts = Object.fromEntries(FINDING_SEVERITIES.map((severity) => [severity, 0])) as Record<
    FindingSeverity,
    number
  >;
  for (const { row } of rows) counts[row.severity]++;
  const matching = rows.filter(({ row }) => !filter.severity || row.severity === filter.severity);
  const every = visible(options, listReviewFindings(options.db));
  return {
    findings: matching.slice(0, FINDINGS_LIMIT).map(({ row, items }) => view(row, items)),
    total: matching.length,
    counts,
    repositories: [...new Set(every.map(({ row }) => row.repository))].sort(),
    reviews: [...new Set(every.map(({ row }) => row.review))].sort(),
  };
}

/** The rows the reader can open an item of, each with those items. */
function visible(
  options: FindingsOptions,
  rows: ReviewFindingRecord[],
): { row: ReviewFindingRecord; items: ReviewFindingItem[] }[] {
  const items = reviewFindingItems(
    options.db,
    rows.map((row) => row.id),
  );
  const sessions = options.sessionIds === undefined ? null : new Set(options.sessionIds);
  return rows.flatMap((row) => {
    const open = (items.get(row.id) ?? []).filter(
      (item) => sessions === null || (item.sessionKey !== null && sessions.has(item.sessionKey)),
    );
    return open.length === 0 ? [] : [{ row, items: open }];
  });
}

async function change(request: Request, options: FindingsOptions): Promise<Response> {
  const { db, principal } = options;
  if (principal === undefined) return Response.json({ error: "Sign in to Paws." }, { status: 401 });
  const member = workspaceMember(db, principal.workspaceId, principal.userId);
  if (!workspaceMemberUsable(member))
    return Response.json({ error: "Your membership can't change findings." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch (caughtError) {
    journalCaught(caughtError, "findings.change.json", null);
    return Response.json({ error: "Send the change as JSON." }, { status: 400 });
  }
  const action = parseAction(body);
  if (typeof action === "string") return Response.json({ error: action }, { status: 400 });
  const shown = visible(
    options,
    listReviewFindings(db).filter((row) => row.id === action.id),
  );
  if (shown.length === 0) return Response.json({ error: "Finding not found." }, { status: 404 });
  const now = (options.now ?? Date.now)();
  const by = member.name || member.email || principal.userId;
  const changed =
    action.action === "dismiss"
      ? setReviewFindingStatus(db, {
          id: action.id,
          status: "dismissed",
          reason: action.reason,
          by,
          now,
        })
      : setReviewFindingStatus(db, { id: action.id, status: "open", by, now });
  if (changed === null)
    return Response.json(
      {
        error:
          action.action === "dismiss"
            ? "Only an open finding can be dismissed. Refresh the page."
            : "Only a dismissed finding can be reopened. Refresh the page.",
      },
      { status: 409 },
    );
  auditWorkspaceAccess(db, {
    workspaceId: principal.workspaceId,
    userId: principal.userId,
    action: `finding.${action.action}`,
    subject: String(action.id),
    now,
  });
  return Response.json({ finding: view(changed, shown[0]!.items) }, { headers: NO_STORE });
}

function parseAction(body: unknown): FindingAction | string {
  if (typeof body !== "object" || body === null) return "Send a finding and an action.";
  const { id, action, reason } = body as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return "Send the finding's id.";
  if (action === "reopen") return { id, action };
  if (action !== "dismiss") return "The action is dismiss or reopen.";
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text === "") return "Say why the finding is dismissed.";
  if (text.length > DISMISS_REASON_LIMIT)
    return `Keep the reason under ${DISMISS_REASON_LIMIT} characters.`;
  return { id, action, reason: text };
}

function view(row: ReviewFindingRecord, items: readonly ReviewFindingItem[]): FindingView {
  return {
    id: row.id,
    repository: row.repository,
    path: row.path,
    lines: row.lines,
    severity: row.severity,
    review: row.review,
    text: row.text,
    bugClass: row.bugClass,
    why: row.why,
    firstSeenAt: new Date(row.first.at).toISOString(),
    lastSeenAt: new Date(row.last.at).toISOString(),
    itemCount: row.itemCount,
    items: items.map((item) => ({ id: item.identifier || item.itemId, title: item.title })),
    status: row.status,
    statusBy: row.statusBy,
    statusAt: row.statusAt === null ? null : new Date(row.statusAt).toISOString(),
    statusReason: row.statusReason,
    filedIssue: row.filedIssue,
  };
}
