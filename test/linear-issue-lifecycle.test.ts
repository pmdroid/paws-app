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
  let actor: unknown = { id: "requesting-human", app: false };
  let readActor = async () => actor;
  const client: LinearClient = {
    async query(query, variables, options) {
      options?.signal?.throwIfAborted();
      if (query.includes("IssueOwnership")) {
        beforeRead(++reads);
        return { issue: structuredClone(issue) };
      }
      if (query.includes("CodeTaskActor")) {
        expect(variables?.["id"]).toBe("requesting-human");
        expect(query).toContain("user(id: $id) { id app }");
        return { user: await readActor() };
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
    actor: (value: unknown) => {
      actor = value;
    },
    readActor: (callback: () => Promise<unknown>) => {
      readActor = callback;
    },
  };
}

const input = { issueId: "issue", appUserId: "paws-app", actorId: "requesting-human" };

describe("Linear code issue delegation", () => {
  test.each([
    { id: "requesting-human", app: true },
    { id: "requesting-human" },
    { id: "other-human", app: false },
    { id: "requesting-human", app: "false" },
    null,
  ])("only the exact verified human actor may change workflow or delegation", async (actor) => {
    const f = fixture();
    f.actor(actor);
    f.issue.state.type = "triage";
    expect((await f.lifecycle.startCodeIssue(input)).eligible).toBe(false);
    expect(f.cursors).toEqual([]);
    expect(f.mutations).toEqual([]);
    expect(f.issue.assignee.id).toBe("human-assignee");
    expect(f.issue.state.type).toBe("triage");
  });

  test("Stop during actor verification prevents workflow reads and mutation", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<unknown>();
    f.readActor(async () => {
      started.resolve();
      return released.promise;
    });
    const controller = new AbortController();
    const pending = f.lifecycle.startCodeIssue(input, { signal: controller.signal });
    await started.promise;
    controller.abort();
    released.resolve({ id: "requesting-human", app: false });
    await expect(pending).rejects.toThrow();
    expect(f.cursors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });
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

  test("starts from the ownership it read first, without rereading before the mutation", async () => {
    const f = fixture();
    let reads = 0;
    f.beforeRead(() => {
      reads += 1;
    });
    expect((await f.lifecycle.startCodeIssue(input)).eligible).toBe(true);
    expect(reads).toBe(1);
    expect(f.mutations).toEqual([{ stateId: "implementation", delegateId: "paws-app" }]);
  });

  test("checks mutation success and refuses missing started states", async () => {
    const f = fixture();
    f.reject();
    await expect(f.lifecycle.startCodeIssue(input)).rejects.toThrow("did not accept");
    f.states[0] = [];
    f.states[1] = [];
    await expect(f.lifecycle.startCodeIssue(input)).rejects.toThrow("no started");
    expect(f.mutations).toHaveLength(1);
  });

  test("a known issue for a verified actor and team starts with the mutation alone", async () => {
    const f = fixture();
    await f.lifecycle.startCodeIssue(input);
    f.beforeRead(() => {
      throw new Error("The known issue must not be reread");
    });
    f.readActor(async () => {
      throw new Error("The verified actor must not be reread");
    });
    f.cursors.length = 0;
    const known = {
      id: "issue",
      teamId: "team",
      stateType: "unstarted",
      assigneeId: "human-assignee",
      delegateId: null,
    };
    expect((await f.lifecycle.startCodeIssue(input, { issue: known })).eligible).toBe(true);
    expect(f.cursors).toEqual([]);
    expect(f.mutations).toEqual([
      { stateId: "implementation", delegateId: "paws-app" },
      { stateId: "implementation", delegateId: "paws-app" },
    ]);
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
