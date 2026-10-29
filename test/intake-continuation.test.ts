import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getWorkItem } from "../src/db";
import { openPullRequest, readBranchWork, type GitHubClient } from "../src/github";
import {
  asksForFreshStart,
  intakeDelegatedIssue,
  type EarlierAttempt,
  type EarlierBranch,
} from "../src/intake";
import { createFakeTracker } from "../src/linear";
import { implementPrompt, worktreeBranch } from "../src/loop";
import { tempDb } from "./helpers";

const issue = {
  linearIssueId: "only",
  identifier: "ENG-9",
  title: "Fix the header",
  description: null,
  subIssues: [],
};

const tokenProvider = { mode: "token" as const, tokenFor: async () => "token" };

type Call = { method: string; path: string; body?: unknown };

/** A GitHub client that answers from `routes` by method and path prefix and records each call. */
function fakeClient(
  routes: Record<string, { status: number; body: unknown }>,
): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body });
      const key = Object.keys(routes).find((route) => {
        const [method, prefix] = route.split(" ");
        return method === input.method && input.path.startsWith(prefix!);
      });
      if (key === undefined) throw new Error(`unexpected ${input.method} ${input.path}`);
      return { status: routes[key]!.status, body: routes[key]!.body, headers: new Headers() };
    },
  } as GitHubClient & { calls: Call[] };
}

/** The first delegation's item ran on its own branch and then ended with `state`. */
async function earlierAttempt(db: Database, state: string): Promise<string> {
  const tracker = createFakeTracker([issue]);
  const first = await intakeDelegatedIssue(db, tracker, {
    linearIssueId: "only",
    sessionId: "ses_1",
    taskKey: "session:ses_1",
  });
  if (!first.ok) throw new Error("expected intake");
  const item = first.items[0]!;
  const branch = `paws/eng-9-${item.id.toLowerCase()}`;
  db.run("UPDATE work_item SET state = ?, branch_name = ? WHERE id = ?", [state, branch, item.id]);
  db.run(
    "INSERT INTO run (id, item_id, kind, agent, status, created_at, updated_at) VALUES (?, ?, 'implement', 'claude', 'ended', 1, 1)",
    [`run-${item.id}`, item.id],
  );
  return item.id;
}

async function redelegate(
  db: Database,
  branch: EarlierBranch,
  options: { startFresh?: boolean } = {},
) {
  const inspected: EarlierAttempt[] = [];
  const result = await intakeDelegatedIssue(db, createFakeTracker([issue]), {
    linearIssueId: "only",
    sessionId: "ses_2",
    taskKey: "session:ses_2",
    ...(options.startFresh ? { startFresh: true } : {}),
    inspectBranch: async (earlier) => {
      inspected.push(earlier);
      return branch;
    },
  });
  if (!result.ok) throw new Error("expected intake");
  expect(result.alreadyExisted).toBe(false);
  expect(result.items).toHaveLength(1);
  return { item: getWorkItem(db, result.items[0]!.id)!, inspected };
}

describe("re-delegating an issue", () => {
  test("with an open pull request reuses that pull request and its branch", async () => {
    const db = tempDb();
    const earlierId = await earlierAttempt(db, "cancelled");
    const earlierBranch = getWorkItem(db, earlierId)!.branchName;
    const { item, inspected } = await redelegate(db, { pull: "open", commits: 6 });
    expect(inspected).toEqual([
      {
        itemId: earlierId,
        linearIssueId: "only",
        linearIdentifier: "ENG-9",
        branchName: earlierBranch,
      },
    ]);
    expect(item.continuesItemId).toBe(earlierId);
    expect(item.continuesBranch).toBe(earlierBranch);
    expect(item.branchName).toBe(earlierBranch);
    // The new item's own key would be a new branch; the continued branch wins.
    expect(worktreeBranch(item)).toBe(earlierBranch);
    const prompt = implementPrompt({
      identifier: "ENG-9",
      title: "Fix the header",
      continuesBranch: item.continuesBranch!,
    });
    expect(prompt).toContain("This continues earlier work on this issue.");
    expect(prompt).toContain(`\`${earlierBranch}\``);
    expect(implementPrompt({ identifier: "ENG-9", title: "Fix the header" })).not.toContain(
      "continues earlier work",
    );

    // GitHub refuses a second pull request for the branch, so Paws updates the open one.
    const client = fakeClient({
      "POST /repos/o/r/pulls": { status: 422, body: {} },
      "GET /repos/o/r/pulls?": { status: 200, body: [{ number: 1056 }] },
      "PATCH /repos/o/r/pulls/1056": {
        status: 200,
        body: { number: 1056, html_url: "https://github.com/o/r/pull/1056", body: "" },
      },
    });
    const pull = await openPullRequest({
      issue: "ENG-9",
      branchKey: worktreeBranch(item).slice("paws/".length),
      owner: "o",
      repo: "r",
      evidence: "",
      client,
      tokenProvider,
    });
    expect(pull.number).toBe(1056);
    expect(client.calls[0]).toMatchObject({ method: "POST", body: { head: earlierBranch } });
    expect(client.calls.map((call) => call.method)).toEqual(["POST", "GET", "PATCH"]);
    db.close();
  });

  test("with a closed pull request but a branch with commits continues the branch and opens a pull request from it", async () => {
    const db = tempDb();
    const earlierId = await earlierAttempt(db, "cancelled");
    const earlierBranch = getWorkItem(db, earlierId)!.branchName;
    const { item } = await redelegate(db, { pull: "closed", commits: 5 });
    expect(item.continuesItemId).toBe(earlierId);
    expect(worktreeBranch(item)).toBe(earlierBranch);

    const client = fakeClient({
      "POST /repos/o/r/pulls": {
        status: 201,
        body: { number: 1065, html_url: "https://github.com/o/r/pull/1065", body: "" },
      },
    });
    const pull = await openPullRequest({
      issue: "ENG-9",
      branchKey: worktreeBranch(item).slice("paws/".length),
      owner: "o",
      repo: "r",
      evidence: "",
      client,
      tokenProvider,
    });
    expect(pull.number).toBe(1065);
    expect(client.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ head: earlierBranch }),
      }),
    ]);
    db.close();
  });

  test("that asks to start fresh makes a new branch", async () => {
    expect(asksForFreshStart("@paws start fresh please")).toBe(true);
    expect(asksForFreshStart("Starting over fresh on this one")).toBe(true);
    expect(asksForFreshStart("A fresh start, please.")).toBe(true);
    expect(asksForFreshStart("Work on ENG-9")).toBe(false);
    expect(asksForFreshStart(null)).toBe(false);

    const db = tempDb();
    const earlierId = await earlierAttempt(db, "cancelled");
    const { item, inspected } = await redelegate(
      db,
      { pull: "open", commits: 6 },
      { startFresh: true },
    );
    expect(inspected).toEqual([]);
    expect(item.continuesItemId).toBeNull();
    expect(item.continuesBranch).toBeNull();
    expect(worktreeBranch(item)).toBe(`paws/eng-9-${item.id.toLowerCase()}`);
    expect(worktreeBranch(item)).not.toBe(getWorkItem(db, earlierId)!.branchName);
    db.close();
  });

  test.each([
    ["a closed pull request and no commits", { pull: "closed", commits: 0 }],
    ["a merged pull request", { pull: "merged", commits: 4 }],
    ["no pull request and no branch", { pull: null, commits: 0 }],
  ] as const)("with %s starts fresh", async (_label, branch) => {
    const db = tempDb();
    await earlierAttempt(db, "cancelled");
    const { item } = await redelegate(db, branch);
    expect(item.continuesItemId).toBeNull();
    expect(worktreeBranch(item)).toBe(`paws/eng-9-${item.id.toLowerCase()}`);
    db.close();
  });

  test("an earlier item that never ran leaves nothing to continue", async () => {
    const db = tempDb();
    const earlierId = await earlierAttempt(db, "cancelled");
    db.run("DELETE FROM run WHERE item_id = ?", [earlierId]);
    const { item, inspected } = await redelegate(db, { pull: "open", commits: 1 });
    expect(inspected).toEqual([]);
    expect(item.continuesItemId).toBeNull();
    db.close();
  });

  test("while the earlier item is still running does not start a second item", async () => {
    const db = tempDb();
    const earlierId = await earlierAttempt(db, "running");
    const tracker = createFakeTracker([issue]);
    let inspected = 0;
    await expect(
      intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_2",
        taskKey: "session:ses_2",
        inspectBranch: async () => {
          inspected++;
          return { pull: "open", commits: 6 };
        },
      }),
    ).rejects.toThrow("ENG-9 has an unfinished attempt in another Paws session.");
    expect(inspected).toBe(0);
    expect(db.query<{ id: string }, []>("SELECT id FROM work_item").all()).toEqual([
      { id: earlierId },
    ]);
    expect(getWorkItem(db, earlierId)?.state).toBe("running");
    db.close();
  });
});

describe("readBranchWork", () => {
  test("reads the latest pull request state and the commits main lacks", async () => {
    const read = (pulls: unknown[], compare: { status: number; body: unknown }) =>
      readBranchWork({
        client: fakeClient({
          "GET /repos/o/r/pulls?": { status: 200, body: pulls },
          "GET /repos/o/r/compare/": compare,
        }),
        owner: "o",
        repo: "r",
        branch: "paws/eng-9",
        tokenProvider,
      });
    expect(await read([{ state: "open" }], { status: 200, body: { ahead_by: 6 } })).toEqual({
      pull: "open",
      commits: 6,
    });
    expect(
      await read([{ state: "closed", merged_at: null }], { status: 200, body: { ahead_by: 2 } }),
    ).toEqual({ pull: "closed", commits: 2 });
    expect(
      await read([{ state: "closed", merged_at: "2026-10-28T00:00:00Z" }], {
        status: 200,
        body: { ahead_by: 3 },
      }),
    ).toEqual({ pull: "merged", commits: 3 });
    expect(await read([], { status: 404, body: {} })).toEqual({ pull: null, commits: 0 });
  });
});
