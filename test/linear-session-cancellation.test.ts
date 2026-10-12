import { describe, expect, test } from "bun:test";
import {
  createFakeTracker,
  createLinearTracker,
  type LinearClient,
  type LinearSessionAdapter,
  type TrackerRequestOptions,
} from "../src/linear";

const progress = { sessionId: "session", kind: "thought" as const, body: "Working" };
const question = { sessionId: "session", body: "Continue?" };
const methods: {
  name: string;
  invoke: (tracker: LinearSessionAdapter, options: TrackerRequestOptions) => Promise<unknown>;
}[] = [
  { name: "postProgress", invoke: (tracker, options) => tracker.postProgress(progress, options) },
  { name: "askQuestion", invoke: (tracker, options) => tracker.askQuestion(question, options) },
  {
    name: "createActivity",
    invoke: (tracker, options) => tracker.createActivity(progress, options),
  },
  {
    name: "createElicitation",
    invoke: (tracker, options) => tracker.createElicitation(question, options),
  },
  {
    name: "updateSession",
    invoke: (tracker, options) =>
      tracker.updateSession({ sessionId: "session", summary: "Task" }, options),
  },
  {
    name: "createSessionOnIssue",
    invoke: (tracker, options) => tracker.createSessionOnIssue({ issueId: "ENG-1" }, options),
  },
  {
    name: "createSessionOnComment",
    invoke: (tracker, options) => tracker.createSessionOnComment({ commentId: "comment" }, options),
  },
  {
    name: "setStatus",
    invoke: (tracker, options) =>
      tracker.setStatus({ linearIssueId: "issue", stateType: "started" }, options),
  },
];

describe("Linear adapter cancellation", () => {
  test.each(methods)("$name passes cancellation to the active query", async ({ invoke }) => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const client: LinearClient = {
      query(_query, _variables, options) {
        requestSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const pending = invoke(createLinearTracker(client), { signal: controller.signal });
    expect(requestSignal).toBeDefined();
    controller.abort(new Error("stopped"));
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(controller.signal.reason);
    await expect(pending).rejects.toThrow("stopped");
  });

  test.each(methods)("$name rejects already stopped work without a query", async ({ invoke }) => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    let calls = 0;
    const tracker = createLinearTracker({
      async query() {
        calls++;
        return {};
      },
    });
    await expect(invoke(tracker, { signal: controller.signal })).rejects.toThrow("already stopped");
    expect(calls).toBe(0);
  });

  test("does not update issue status after cancellation during state lookup", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const tracker = createLinearTracker({
      async query(query, _variables, options) {
        calls.push(query);
        expect(options?.signal).toBe(controller.signal);
        controller.abort(new Error("stop during lookup"));
        return {
          issue: {
            team: { states: { nodes: [{ id: "started", name: "In Progress", type: "started" }] } },
          },
        };
      },
    });
    await expect(
      tracker.setStatus(
        { linearIssueId: "issue", stateType: "started" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("stop during lookup");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("IssueStates");
  });

  test("passes the same signal to both status lookup and mutation", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const tracker = createLinearTracker({
      async query(query, _variables, options) {
        signals.push(options?.signal);
        if (query.includes("IssueStates"))
          return {
            issue: {
              team: {
                states: { nodes: [{ id: "started", name: "In Progress", type: "started" }] },
              },
            },
          };
        return { issueUpdate: { success: true } };
      },
    });
    await tracker.setStatus(
      { linearIssueId: "issue", stateType: "started" },
      { signal: controller.signal },
    );
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  test("the fake rejects stopped operations without recording publication", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped fake"));
    const tracker = createFakeTracker();
    for (const { invoke } of methods)
      await expect(invoke(tracker, { signal: controller.signal })).rejects.toThrow("stopped fake");
    expect(tracker.progress).toEqual([]);
    expect(tracker.questions).toEqual([]);
    expect(tracker.statuses).toEqual([]);
    expect(tracker.sessionUpdates).toEqual([]);
    expect(tracker.issueSessions).toEqual([]);
    expect(tracker.commentSessions).toEqual([]);
  });
});
