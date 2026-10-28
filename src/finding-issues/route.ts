import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  getReviewFindingIssue,
  getWorkItemRepository,
  listWorkItems,
  reviewFindingKey,
  reviewFindingPlace,
  saveReviewFindingIssue,
  workspaceMember,
  type ReviewFindingIssue,
  type WorkItemRecord,
  type WorkspaceSession,
} from "../db";
import { journalCaught } from "../journal";
import type { FiledFindingIssue, FindingIssueRequest } from "../linear";
import { FINDING_ISSUE_PATH, type StatusReview } from "../web";
import { validWorkspaceCsrf } from "../workspace";
import { findingIssueDescription, findingIssueTitle } from "./body";

const MAX_TEXT = 100_000;

export const FINDING_ISSUE_FILERS =
  "Only an active member of this Paws workspace can file an issue from a finding.";

export type FileFindingIssue = (
  request: FindingIssueRequest,
  options?: { signal?: AbortSignal },
) => Promise<FiledFindingIssue>;

export type FindingIssueRouteOptions = {
  db: Database;
  /** Each review of a work item, as the issue page shows it. */
  reviews: (itemId: string) => StatusReview[];
  /** Linear's issue filer. Absent without a Linear connection. */
  file: FileFindingIssue | undefined;
  now?: () => number;
};

export type FindingIssueAccess = {
  principal: { workspaceId: string; userId: string };
  session: WorkspaceSession;
  /** The workspace origin: an unsafe request must come from it, and links back point to it. */
  origin: string;
  /** Sessions the signed-in person can see. */
  sessionIds: readonly string[];
};

/**
 * `POST /api/review-findings/issues` with `{ itemId, reviewId, location, explanation }`: file
 * the pre-existing finding as a Linear issue, or show the issue already filed for it. Any active
 * workspace member may file; the finding is read from the item's reviews, never from the body.
 */
export function createFindingIssueRoute(options: FindingIssueRouteOptions) {
  const now = options.now ?? Date.now;
  const filing = new Map<string, Promise<ReviewFindingIssue>>();
  return async function handleFindingIssueRequest(
    request: Request,
    access: FindingIssueAccess | undefined,
  ): Promise<Response | null> {
    if (new URL(request.url).pathname !== FINDING_ISSUE_PATH) return null;
    if (access === undefined) return Response.json({ error: "Sign in to Paws." }, { status: 401 });
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    const { db } = options;
    const { principal } = access;
    const refuse = (subject: string, error: string) => {
      auditWorkspaceAccess(db, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: "access.denied",
        subject,
        now: now(),
      });
      return Response.json({ error }, { status: 403 });
    };
    if (
      request.headers.get("origin") !== access.origin ||
      !validWorkspaceCsrf(request, access.session)
    )
      return refuse(FINDING_ISSUE_PATH, "A valid CSRF token is required.");
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!member?.active || member.role === "observer")
      return refuse(FINDING_ISSUE_PATH, FINDING_ISSUE_FILERS);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const { itemId, reviewId, location, explanation } = body ?? {};
    if (
      typeof itemId !== "string" ||
      typeof reviewId !== "string" ||
      typeof location !== "string" ||
      typeof explanation !== "string" ||
      explanation.length > MAX_TEXT
    )
      return Response.json(
        { error: "Send the issue, the review, and the finding's location and text." },
        { status: 400 },
      );
    const item = visibleItem(db, itemId, access.sessionIds);
    if (item === null) return Response.json({ error: "Issue not found." }, { status: 404 });
    const found = latestPreExisting(options.reviews(item.id), reviewId, location, explanation);
    if (found === null)
      return Response.json(
        { error: "That pre-existing finding is not on this issue. Refresh the issue." },
        { status: 409 },
      );
    const bound = getWorkItemRepository(db, item.id);
    if (bound === null)
      return Response.json(
        { error: "Paws does not know this issue's repository." },
        { status: 409 },
      );
    const repository = `${bound.owner}/${bound.repo}`;
    const key = reviewFindingKey({ repository, location, text: explanation });
    const place = reviewFindingPlace(location);
    if (key === null || place === null)
      return Response.json({ error: "The finding names no line." }, { status: 409 });
    const stored = getReviewFindingIssue(db, key);
    if (stored) return Response.json(reply(stored, false));
    if (options.file === undefined)
      return Response.json({ error: "Linear is not connected." }, { status: 503 });
    let pending = filing.get(key);
    let filed = false;
    if (pending === undefined) {
      filed = true;
      const file = options.file;
      pending = (async () => {
        const issue = await file(
          {
            key,
            relatedIssueId: item.linearIssueId,
            title: findingIssueTitle(explanation),
            description: findingIssueDescription({
              finding: found.finding,
              reviewId,
              headSha: found.headSha,
              repository,
              identifier: item.linearIdentifier || item.id,
              pageUrl: `${access.origin.replace(/\/+$/, "")}/status/issues/${encodeURIComponent(item.linearIdentifier || item.id)}`,
            }),
          },
          { signal: request.signal },
        );
        return saveReviewFindingIssue(db, {
          key,
          repository,
          path: place.path,
          lines: place.lines,
          linearIssueId: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          itemId: item.id,
          filedBy: principal.userId,
          filedAt: now(),
        });
      })().finally(() => filing.delete(key));
      filing.set(key, pending);
    }
    try {
      return Response.json(reply(await pending, filed));
    } catch (error) {
      journalCaught(error, "finding-issues.file", item.id);
      const message = error instanceof Error && error.message ? error.message : String(error);
      return Response.json({ error: `Linear did not file the issue: ${message}` }, { status: 502 });
    }
  };
}

function reply(issue: ReviewFindingIssue, filed: boolean) {
  return { identifier: issue.identifier, url: issue.url, filed };
}

/** The newest visible work item with public id `id`. */
function visibleItem(
  db: Database,
  id: string,
  sessionIds: readonly string[],
): WorkItemRecord | null {
  const matches = listWorkItems(db).filter(
    (item) =>
      (item.linearIdentifier === id || item.id === id) &&
      item.sessionKey !== null &&
      sessionIds.includes(item.sessionKey),
  );
  return matches.at(-1) ?? null;
}

/** The latest round's copy of the pre-existing finding, and the commit that round reviewed. */
function latestPreExisting(
  reviews: readonly StatusReview[],
  reviewId: string,
  location: string,
  explanation: string,
) {
  const review = reviews.find((entry) => entry.id === reviewId);
  for (const round of [...(review?.rounds ?? [])].reverse()) {
    const finding = round.findings.find(
      (entry) =>
        entry.preExisting && entry.location === location && entry.explanation === explanation,
    );
    if (finding) return { finding, headSha: round.headSha };
  }
  return null;
}
