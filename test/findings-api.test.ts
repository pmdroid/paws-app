import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  bindWorkItemRepository,
  insertQueuedItem,
  putWorkspaceUser,
  recordReviewFindings,
  syncWorkspaceMember,
  type ReviewFindingReport,
} from "../src/db";
import { handleFindingsRequest, type FindingsResponse } from "../src/web";
import { tempDb } from "./helpers";

const URL_BASE = "http://127.0.0.1:8787/api/findings";

function finding(patch: Partial<ReviewFindingReport>): ReviewFindingReport {
  return {
    review: "independent-review",
    severity: "P2",
    location: "src/a.ts:1",
    text: "naming: reads backwards",
    bugClass: "naming",
    why: "below failOn",
    ...patch,
  };
}

function seed(role: "member" | "observer" = "member"): Database {
  const db = tempDb();
  for (const [id, repo] of [
    ["item-a", "platform"],
    ["item-b", "web"],
  ] as const) {
    insertQueuedItem(db, { id, sessionKey: `session-${id}`, now: 1, title: `Title ${id}` });
    bindWorkItemRepository(db, id, {
      owner: "acme",
      repo,
      remoteUrl: `https://github.com/acme/${repo}`,
    });
  }
  recordReviewFindings(db, {
    itemId: "item-a",
    repository: "acme/platform",
    head: "a".repeat(40),
    seenAt: 1000,
    findings: [
      finding({ severity: "P1", location: "src/auth/token.ts:4", why: "pre-existing" }),
      finding({ location: "docs/readme.md:2", review: "security-review" }),
    ],
    reviewed: [],
  });
  recordReviewFindings(db, {
    itemId: "item-b",
    repository: "acme/web",
    head: "c".repeat(40),
    seenAt: 2000,
    findings: [finding({ severity: "P3", location: "src/view.tsx:9" })],
    reviewed: [],
  });
  const userId = putWorkspaceUser(db, {
    id: "user-ada",
    linearUserId: "linear-ada",
    name: "Ada",
    email: "ada@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 1]);
  syncWorkspaceMember(db, { workspaceId: "ws-1", userId, role, active: true, teamIds: [], now: 1 });
  return db;
}

async function list(db: Database, query = "", sessionIds?: string[]): Promise<FindingsResponse> {
  const response = await handleFindingsRequest(new Request(`${URL_BASE}${query}`), {
    db,
    ...(sessionIds ? { sessionIds } : {}),
  });
  expect(response!.status).toBe(200);
  return (await response!.json()) as FindingsResponse;
}

function post(db: Database, body: unknown, signedIn = true) {
  return handleFindingsRequest(
    new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      db,
      now: () => 5000,
      ...(signedIn ? { principal: { workspaceId: "ws-1", userId: "user-ada" } } : {}),
    },
  );
}

test("the list is newest last seen first, filters, and counts severities over the other filters", async () => {
  const db = seed();
  try {
    const all = await list(db);
    expect(all.findings.map((entry) => entry.path)).toEqual([
      "src/view.tsx",
      "docs/readme.md",
      "src/auth/token.ts",
    ]);
    expect(all.counts).toEqual({ P0: 0, P1: 1, P2: 1, P3: 1 });
    expect(all.repositories).toEqual(["acme/platform", "acme/web"]);
    expect(all.reviews).toEqual(["independent-review", "security-review"]);
    expect(all.findings[0]).toMatchObject({
      repository: "acme/web",
      lines: "9",
      itemCount: 1,
      items: [{ id: "item-b", title: "Title item-b" }],
      lastSeenAt: new Date(2000).toISOString(),
    });

    const platform = await list(db, "?repository=acme/platform&severity=P1");
    expect(platform.findings.map((entry) => entry.path)).toEqual(["src/auth/token.ts"]);
    expect(platform.total).toBe(1);
    expect(platform.counts).toEqual({ P0: 0, P1: 1, P2: 1, P3: 0 });
    expect((await list(db, "?review=security-review")).findings).toHaveLength(1);
    expect((await list(db, "?path=./src/auth")).findings.map((entry) => entry.path)).toEqual([
      "src/auth/token.ts",
    ]);
    expect((await list(db, "?status=dismissed")).findings).toEqual([]);

    // Only findings of items in the reader's sessions show.
    const mine = await list(db, "", ["session-item-b"]);
    expect(mine.findings.map((entry) => entry.path)).toEqual(["src/view.tsx"]);
    expect(mine.repositories).toEqual(["acme/web"]);
  } finally {
    db.close();
  }
});

test("a member dismisses with a reason and reopens; others and bad requests are refused", async () => {
  const db = seed();
  try {
    const [first] = (await list(db)).findings;
    expect((await post(db, { id: first!.id, action: "dismiss", reason: "x" }, false))!.status).toBe(
      401,
    );
    expect((await post(db, { id: first!.id, action: "dismiss", reason: "  " }))!.status).toBe(400);
    expect((await post(db, { id: first!.id, action: "reopen" }))!.status).toBe(409);
    expect((await post(db, { id: 999, action: "reopen" }))!.status).toBe(404);

    const dismissed = await post(db, {
      id: first!.id,
      action: "dismiss",
      reason: "Known, tracked.",
    });
    expect(dismissed!.status).toBe(200);
    expect(((await dismissed!.json()) as { finding: unknown }).finding).toMatchObject({
      status: "dismissed",
      statusBy: "Ada",
      statusReason: "Known, tracked.",
      statusAt: new Date(5000).toISOString(),
    });
    expect((await list(db)).findings.map((entry) => entry.id)).not.toContain(first!.id);
    expect((await list(db, "?status=dismissed")).findings.map((entry) => entry.id)).toEqual([
      first!.id,
    ]);

    const reopened = await post(db, { id: first!.id, action: "reopen" });
    expect(((await reopened!.json()) as { finding: unknown }).finding).toMatchObject({
      status: "open",
      statusBy: "Ada",
    });
    expect(
      db
        .query(
          "SELECT action FROM workspace_access_audit WHERE action LIKE 'finding.%' ORDER BY id",
        )
        .all(),
    ).toEqual([{ action: "finding.dismiss" }, { action: "finding.reopen" }]);
  } finally {
    db.close();
  }
});

test("an observer cannot change a finding", async () => {
  const db = seed("observer");
  try {
    const [first] = (await list(db)).findings;
    expect((await post(db, { id: first!.id, action: "dismiss", reason: "no" }))!.status).toBe(403);
  } finally {
    db.close();
  }
});
