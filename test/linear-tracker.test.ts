import { describe, expect, test } from "bun:test";
import { UserFacingError } from "../src/core";
import { FIRST_ACTIVITY_BODY, acknowledgeNewSession, createLinearTracker } from "../src/linear";
import { createFakeTracker, type LinearClient } from "../src/linear";

describe("linear tracker", () => {
  test("loads sub-issues in sort order and maps blocks relations", async () => {
    const calls: string[] = [];
    const client: LinearClient = {
      async query(query, variables) {
        calls.push(query);
        if (query.includes("IssueSnapshot")) {
          return {
            issue: {
              id: "parent",
              identifier: "ENG-1",
              title: "Export",
              description: null,
              children: {
                nodes: [
                  {
                    id: "b",
                    identifier: "ENG-3",
                    title: "b",
                    subIssueSortOrder: 2,
                    state: { type: "completed" },
                  },
                  { id: "a", identifier: "ENG-2", title: "a", subIssueSortOrder: 1 },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        if (query.includes("IssueStates")) {
          return {
            issue: {
              team: {
                states: {
                  nodes: [
                    { id: "st_review", name: "In Review", type: "started" },
                    { id: "st_progress", name: "In Progress", type: "started" },
                  ],
                },
              },
            },
          };
        }
        if (query.includes("issueUpdate")) {
          expect(variables?.["input"]).toEqual({ stateId: "st_progress" });
          return { issueUpdate: { success: true } };
        }
        if (query.includes("agentActivityCreate")) {
          return { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } };
        }
        return {
          issue: {
            id: "a",
            relations: {
              nodes: [
                { type: "related", issue: { id: "a" }, relatedIssue: { id: "z" } },
                { type: "blocks", issue: { id: "a" }, relatedIssue: { id: "b" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            inverseRelations: {
              nodes: [{ type: "blocks", issue: { id: "a" }, relatedIssue: { id: "b" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    };
    const tracker = createLinearTracker(client);
    const epic = await tracker.loadEpic("parent");
    expect(epic.subIssues.map((issue) => issue.identifier)).toEqual(["ENG-2", "ENG-3"]);
    expect(epic.subIssues.map((issue) => issue.stateType)).toEqual([null, "completed"]);
    expect(await tracker.listDeps("a")).toEqual([
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
    ]);
    await tracker.setStatus({ linearIssueId: "a", stateType: "started" });
    await tracker.postProgress({ sessionId: "ses_1", kind: "thought", body: "hello" });
    expect(calls.some((query) => query.includes("agentActivityCreate"))).toBe(true);
  });

  test("askQuestion sends a select signal and keeps the body as free text", async () => {
    const inputs: unknown[] = [];
    const client: LinearClient = {
      async query(_query, variables) {
        inputs.push(variables?.["input"]);
        return { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } };
      },
    };
    const tracker = createLinearTracker(client);
    await tracker.askQuestion({
      sessionId: "ses_1",
      body: "Include archived rows?\n\nReply with one of the options, or answer in your own words.",
      options: ["yes", "no"],
    });
    expect(inputs[0]).toEqual({
      agentSessionId: "ses_1",
      content: {
        type: "elicitation",
        body: "Include archived rows?\n\nReply with one of the options, or answer in your own words.",
      },
      signal: "select",
      signalMetadata: {
        options: [
          { label: "yes", value: "yes" },
          { label: "no", value: "no" },
        ],
      },
    });
  });

  test("posts the first activity before a slow follow-up", async () => {
    const tracker = createFakeTracker();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = acknowledgeNewSession(
      tracker,
      {
        dedupeKey: "session:ses_1:created",
        deliveryId: "del",
        source: "webhook",
        action: "created",
        sessionId: "ses_1",
        issueId: "iss_1",
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: 1,
        payload: "{}",
      },
      () => gate,
    );
    await Bun.sleep(10);
    expect(tracker.progress.map((update) => update.body)).toEqual([FIRST_ACTIVITY_BODY]);
    release();
    await pending;
    const prompted = acknowledgeNewSession(tracker, {
      dedupeKey: "activity:act",
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: "ses_1",
      issueId: "iss_1",
      activityId: "act",
      body: "yes",
      signal: "stop",
      updatedAtMs: 2,
      payload: "{}",
    });
    await prompted;
    expect(tracker.progress).toHaveLength(1);
  });

  const created = (deliveryId: string) => ({
    dedupeKey: `session:ses_2:created:${deliveryId}`,
    deliveryId,
    source: "webhook" as const,
    action: "created" as const,
    sessionId: "ses_2",
    issueId: "iss_2",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  });

  test("a session delivered twice is picked up once", async () => {
    const tracker = createFakeTracker();
    const acknowledged = new Set<string>();
    await acknowledgeNewSession(tracker, created("webhook"), async () => {}, undefined, {
      acknowledged,
    });
    await acknowledgeNewSession(tracker, created("poll"), async () => {}, undefined, {
      acknowledged,
    });
    expect(tracker.progress.map((update) => update.body)).toEqual([FIRST_ACTIVITY_BODY]);
  });

  test("a refused session says why nothing starts", async () => {
    const tracker = createFakeTracker();
    expect(await acknowledgeNewSession(tracker, created("webhook"), async () => false)).toBe(false);
    expect(tracker.progress.map((update) => [update.kind, update.body])).toEqual([
      ["thought", FIRST_ACTIVITY_BODY],
      [
        "error",
        "Paws did not start this work. Only an active member of the Paws workspace can delegate issues to Paws.",
      ],
    ]);
  });

  test("a start failure with a user-facing reason reports that reason", async () => {
    const tracker = createFakeTracker();
    await expect(
      acknowledgeNewSession(tracker, created("webhook"), async () => {
        throw new UserFacingError("No paired runner can run claude for this issue.");
      }),
    ).rejects.toThrow();
    expect(tracker.progress.at(-1)?.body).toBe(
      "Paws could not start work on this issue: No paired runner can run claude for this issue.",
    );
  });
});
