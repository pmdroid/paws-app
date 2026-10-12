import { describe, expect, test } from "bun:test";
import { createLinearIssueLifecycle, type LinearClient } from "../src/linear";

function fixture() {
  const issue = {
    id: "issue",
    team: { id: "team" },
    state: { type: "unstarted" },
    assignee: { id: "human-assignee" },
    delegate: null as { id: string } | null,
  };
  const mutations: Record<string, unknown>[] = [];
  const cursors: unknown[] = [];
  const states = [
    [
      { id: "review", position: 20 },
      { id: "progress", position: 10 },
    ],
    [{ id: "implementation", position: 2 }],
  ];
  let reads = 0;
  let beforeRead = (_count: number) => {};
  let accepted = true;
  const client: LinearClient = {
    async query(query, variables, options) {
      options?.signal?.throwIfAborted();
      if (query.includes("IssueOwnership")) {
        beforeRead(++reads);
        return { issue: structuredClone(issue) };
      }
      if (query.includes("StartedWorkflowStates")) {
        expect(query).toContain('filter: { type: { eq: "started" } }');
        expect(variables?.["id"]).toBe("team");
        cursors.push(variables?.["after"]);
        const page = variables?.["after"] === null ? 0 : 1;
        return {
          team: {
            states: {
              nodes: states[page],
              pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? "next" : null },
            },
          },
        };
      }
      if (query.includes("StartDelegatedIssue")) {
        mutations.push(variables?.["input"] as Record<string, unknown>);
        return { issueUpdate: { success: accepted } };
      }
      throw new Error("Unexpected Linear query");
    },
  };
  return {
    lifecycle: createLinearIssueLifecycle(client),
    issue,
    mutations,
    cursors,
    beforeRead: (callback: typeof beforeRead) => {
      beforeRead = callback;
    },
    reject: () => {
      accepted = false;
    },
    states,
  };
}

const input = { issueId: "issue", appUserId: "paws-app", actorId: "requesting-human" };

describe("Linear code issue delegation", () => {
  test("selects the lowest-position started state across pages and preserves the human assignee", async () => {
    const f = fixture();
    const result = await f.lifecycle.startCodeIssue(input);
    expect(f.cursors).toEqual([null, "next"]);
    expect(f.mutations).toEqual([{ stateId: "implementation", delegateId: "paws-app" }]);
    expect(result).toEqual({
      eligible: true,
      issue: {
        id: "issue",
        teamId: "team",
        stateType: "started",
        assigneeId: "human-assignee",
        delegateId: "paws-app",
      },
    });
    expect(f.issue.assignee.id).toBe("human-assignee");
  });

  test.each([null, "paws-app", " "])(
    "automation and app actors preserve triage and assignment",
    async (actorId) => {
      const f = fixture();
      f.issue.state.type = "triage";
      expect((await f.lifecycle.startCodeIssue({ ...input, actorId })).eligible).toBe(false);
      expect(f.mutations).toEqual([]);
      expect(f.cursors).toEqual([]);
      expect(f.issue.state.type).toBe("triage");
    },
  );

  test.each(["started", "completed", "canceled", "duplicate"])(
    "preserves existing %s workflow state",
    async (state) => {
      const f = fixture();
      f.issue.state.type = state;
      f.issue.delegate = { id: "paws-app" };
      await f.lifecycle.startCodeIssue(input);
      expect(f.mutations).toEqual([]);
      expect(f.cursors).toEqual([]);
    },
  );

  test("sets an absent implementation delegate on already-started work", async () => {
    const f = fixture();
    f.issue.state.type = "started";
    await f.lifecycle.startCodeIssue(input);
    expect(f.mutations).toEqual([{ delegateId: "paws-app" }]);
  });

  test("never replaces another delegate", async () => {
    const f = fixture();
    f.issue.delegate = { id: "other-agent" };
    expect((await f.lifecycle.startCodeIssue(input)).eligible).toBe(false);
    expect(f.mutations).toEqual([]);
  });

  test("missing ownership data cannot be treated as an unassigned issue", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.issue, "delegate");
    await expect(f.lifecycle.startCodeIssue(input)).rejects.toThrow("incomplete issue ownership");
    expect(f.mutations).toEqual([]);
  });

  test.each(["cancellation", "delegation"])(
    "rechecks authoritative %s after loading workflow pages",
    async (change) => {
      const f = fixture();
      f.beforeRead((count) => {
        if (count !== 2) return;
        if (change === "cancellation") f.issue.state.type = "canceled";
        else f.issue.delegate = { id: "other-agent" };
      });
      expect((await f.lifecycle.startCodeIssue(input)).eligible).toBe(false);
      expect(f.mutations).toEqual([]);
    },
  );

  test("checks mutation success and refuses missing started states", async () => {
    const f = fixture();
    f.reject();
    await expect(f.lifecycle.startCodeIssue(input)).rejects.toThrow("did not accept");
    f.states[0] = [];
    f.states[1] = [];
    await expect(f.lifecycle.startCodeIssue(input)).rejects.toThrow("no started");
    expect(f.mutations).toHaveLength(1);
  });

  test("honors cancellation before any provider request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.lifecycle.startCodeIssue(input, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(f.cursors).toEqual([]);
  });
});
