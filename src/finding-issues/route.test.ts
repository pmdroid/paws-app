import { expect, test } from "bun:test";
import {
  bindWorkItemRepository,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  type WorkspaceRole,
} from "../db";
import { createFakeTracker, REVIEW_FINDING_LABEL } from "../linear";
import type { StatusReview, StatusReviewFinding } from "../web";
import { issueWorkspaceSession } from "../workspace";
import { createFindingIssueRoute } from "./route";

const NOW = 1_700_000_000_000;
const ORIGIN = "https://paws.example";
const PATH = "/api/review-findings/issues";

const OLD: StatusReviewFinding = {
  severity: "P2",
  location: "src/retention/legacy.ts:7-9",
  explanation:
    "unchecked null: @alice see https://evil.example and PAS-1 — the legacy reader skips the guard\nwhen the row is empty",
  evidence: "legacy.ts:7 reads row.id with no check [click](https://evil.example)",
  preExisting: true,
  blocking: false,
  since: "new",
};

const BLOCKING: StatusReviewFinding = {
  ...OLD,
  severity: "P1",
  location: "src/retention/job.ts:44",
  explanation: "Deletes rows before the export finishes",
  preExisting: false,
  blocking: true,
};

function review(id = "independent-review"): StatusReview {
  return {
    id,
    rounds: [
      {
        attempt: 1,
        baseSha: "a1c9e07",
        headSha: "91fd0c4e5b2a",
        failOn: "P1",
        findings: [BLOCKING, OLD],
        fixed: [],
      },
    ],
  };
}

function setup(role: WorkspaceRole = "member") {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const id of ["PAS-633", "PAS-700"]) {
    insertQueuedItem(db, { id, sessionKey: `ses_${id}` });
    bindWorkItemRepository(db, id, {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    });
  }
  db.run("INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES (?,?,?,?)", [
    "ws",
    "org",
    "Kyku",
    NOW,
  ]);
  putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "linear-1",
    name: "Sam",
    email: "sam@example.com",
  });
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "user-1",
    role,
    active: true,
    teamIds: [],
    now: NOW,
  });
  const { session } = issueWorkspaceSession(db, { workspaceId: "ws", userId: "user-1", now: NOW });
  const tracker = createFakeTracker();
  for (const id of ["PAS-633", "PAS-700"])
    tracker.findingIssueTargets.set(`lin-item-${id}`, {
      teamId: "team-pas",
      projectId: "project-fixes",
      states: [
        { id: "state-backlog", type: "backlog", position: 0 },
        { id: "state-triage", type: "triage", position: 1 },
        { id: "state-todo", type: "unstarted", position: 2 },
      ],
    });
  const handle = createFindingIssueRoute({
    db,
    reviews: () => [review()],
    file: (request, options) => tracker.fileFindingIssue(request, options),
    now: () => NOW + 5,
  });
  const access = {
    principal: { workspaceId: "ws", userId: "user-1" },
    session,
    origin: ORIGIN,
    sessionIds: ["ses_PAS-633", "ses_PAS-700"],
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`${ORIGIN}${PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-paws-csrf": session.csrfToken,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      access,
    );
  const stored = () => db.query("SELECT * FROM review_finding_issue").all();
  return { db, tracker, post, stored };
}

const fileOld = (itemId = "PAS-633") => ({
  itemId,
  reviewId: "independent-review",
  location: OLD.location,
  explanation: OLD.explanation,
});

test("filing creates one issue in the item's team and project, in Triage, labelled and related", async () => {
  const { tracker, post, stored } = setup();
  const response = await post(fileOld());
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({
    identifier: "FAKE-1",
    url: "https://linear.app/fake/issue/FAKE-1",
    filed: true,
  });
  expect(tracker.findingIssues).toHaveLength(1);
  const issue = tracker.findingIssues[0]!;
  expect(issue.teamId).toBe("team-pas");
  expect(issue.projectId).toBe("project-fixes");
  expect(issue.stateId).toBe("state-triage");
  expect(tracker.labels).toEqual([
    { id: issue.labelIds[0]!, name: REVIEW_FINDING_LABEL, teamId: "team-pas" },
  ]);
  expect(issue.relations).toEqual([{ type: "related", relatedIssueId: "lin-item-PAS-633" }]);
  expect(issue.title).toBe(
    "unchecked null: @alice see https://evil.example and PAS-1 — the legacy reader skips the guard when the row is empty",
  );
  const body = issue.description;
  expect(body).toContain("- **Severity:** P2");
  expect(body).toContain("- **Location:** `src/retention/legacy.ts:7-9`");
  expect(body).toContain("- **Class of bug:** `unchecked null`");
  expect(body).toContain("- **Review:** `independent-review`");
  expect(body).toContain("- **Found at:** `91fd0c4e5b2a` in `acme/widgets`");
  expect(body).toContain(`- **Paws issue:** [PAS-633 in Paws](${ORIGIN}/status/issues/PAS-633)`);
  // Model text sits in code blocks, where Linear makes no mention or link of it.
  expect(body).toContain(`\`\`\`text\n${OLD.explanation}\n\`\`\``);
  expect(body).toContain(`\`\`\`text\n${OLD.evidence}\n\`\`\``);
  expect(body.replace(/```text\n[\s\S]*?\n```/g, "")).not.toMatch(/@alice|evil\.example|PAS-1\b/);
  // Not delegated: the request carries no assignee or delegate.
  expect(Object.keys(tracker.findingIssueRequests[0]!).sort()).toEqual([
    "description",
    "key",
    "relatedIssueId",
    "title",
  ]);
  expect(stored()).toEqual([
    expect.objectContaining({
      repository: "acme/widgets",
      path: "src/retention/legacy.ts",
      lines: "7-9",
      identifier: "FAKE-1",
      item_id: "PAS-633",
      filed_by: "user-1",
      filed_at: NOW + 5,
    }),
  ]);
});

test("a team without Triage files into Backlog", async () => {
  const { tracker, post } = setup();
  tracker.findingIssueTargets.set("lin-item-PAS-633", {
    teamId: "team-pas",
    projectId: null,
    states: [
      { id: "state-todo", type: "unstarted", position: 0 },
      { id: "state-backlog", type: "backlog", position: 1 },
    ],
  });
  expect((await post(fileOld()))?.status).toBe(200);
  expect(tracker.findingIssues[0]).toMatchObject({ stateId: "state-backlog", projectId: null });
});

test("a second click, or the same finding on another item, returns the issue and files nothing", async () => {
  const { tracker, post, stored } = setup();
  await post(fileOld());
  const again = await post(fileOld());
  expect(await again!.json()).toEqual({
    identifier: "FAKE-1",
    url: "https://linear.app/fake/issue/FAKE-1",
    filed: false,
  });
  const other = await post(fileOld("PAS-700"));
  expect(await other!.json()).toMatchObject({ identifier: "FAKE-1", filed: false });
  expect(tracker.findingIssueRequests).toHaveLength(1);
  expect(stored()).toHaveLength(1);
});

test("two clicks at once file one issue", async () => {
  const { tracker, post } = setup();
  const [first, second] = await Promise.all([post(fileOld()), post(fileOld())]);
  expect(await first!.json()).toMatchObject({ identifier: "FAKE-1" });
  expect(await second!.json()).toMatchObject({ identifier: "FAKE-1" });
  expect(tracker.findingIssueRequests).toHaveLength(1);
});

test("a guest or a revoked member gets 403 and nothing is filed", async () => {
  const guest = setup("observer");
  expect((await guest.post(fileOld()))?.status).toBe(403);
  expect(guest.tracker.findingIssueRequests).toEqual([]);

  const revoked = setup();
  syncWorkspaceMember(revoked.db, {
    workspaceId: "ws",
    userId: "user-1",
    role: "member",
    active: false,
    teamIds: [],
    now: NOW + 1,
  });
  expect((await revoked.post(fileOld()))?.status).toBe(403);
  expect(revoked.tracker.findingIssueRequests).toEqual([]);
  expect(
    revoked.db
      .query("SELECT action, subject FROM workspace_access_audit WHERE subject = ?")
      .all(PATH),
  ).toEqual([{ action: "access.denied", subject: PATH }]);
});

test("a missing CSRF token or another origin is refused", async () => {
  const { tracker, post, stored } = setup();
  expect((await post(fileOld(), { "x-paws-csrf": "" }))?.status).toBe(403);
  expect((await post(fileOld(), { origin: "https://evil.example" }))?.status).toBe(403);
  expect(tracker.findingIssueRequests).toEqual([]);
  expect(stored()).toEqual([]);
});

test("a Linear error shows its message and stores nothing", async () => {
  const { tracker, post, stored } = setup();
  tracker.findingIssueFailures.push(new Error("Linear rate limit reached"));
  const response = await post(fileOld());
  expect(response?.status).toBe(502);
  expect(await response!.json()).toEqual({
    error: "Linear did not file the issue: Linear rate limit reached",
  });
  expect(stored()).toEqual([]);
  expect(tracker.findingIssues).toEqual([]);
});

test("only a pre-existing finding of a visible item can be filed", async () => {
  const { tracker, post } = setup();
  const blocking = await post({
    ...fileOld(),
    location: BLOCKING.location,
    explanation: BLOCKING.explanation,
  });
  expect(blocking?.status).toBe(409);
  const invented = await post({ ...fileOld(), explanation: "Something the page never showed" });
  expect(invented?.status).toBe(409);
  expect((await post(fileOld("PAS-999")))?.status).toBe(404);
  expect((await post({ itemId: "PAS-633" }))?.status).toBe(400);
  expect(tracker.findingIssueRequests).toEqual([]);
});

test("signed out is 401, and other paths are not this route's", async () => {
  const handle = createFindingIssueRoute({
    db: openDatabase(":memory:"),
    reviews: () => [],
    file: undefined,
  });
  expect(
    (await handle(new Request(`${ORIGIN}${PATH}`, { method: "POST" }), undefined))?.status,
  ).toBe(401);
  expect(await handle(new Request(`${ORIGIN}/api/other`), undefined)).toBeNull();
});
