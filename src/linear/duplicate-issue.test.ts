import { expect, test } from "bun:test";
import { CLOSED_ISSUE_EVENT, parseLinearIssueClosed } from "./administration";
import { createIntakePollSource } from "./catchup";
import { parseAgentEvent } from "./webhook";

const canceledAt = "2026-11-02T01:00:00.000Z";

test("a webhook moving an issue to Duplicate is a canceled close at canceledAt", () => {
  const payload = {
    organizationId: "org",
    type: "Issue",
    action: "update",
    createdAt: "2026-11-02T01:00:05.000Z",
    data: { id: "issue", identifier: "ENG-1", state: { type: "duplicate" }, canceledAt },
    updatedFrom: { stateId: "old" },
  };
  const event = parseAgentEvent(JSON.stringify(payload), "delivery", Date.now())!;
  expect(parseLinearIssueClosed(event)).toEqual({
    issueId: "issue",
    organizationId: "org",
    identifier: "ENG-1",
    stateType: "canceled",
    closedAtMs: Date.parse(canceledAt),
  });
});

test("a polled closed event with a Duplicate state is a canceled close", () => {
  const closed = parseLinearIssueClosed({
    dedupeKey: "issue:issue:closed",
    deliveryId: null,
    source: "poll",
    action: "other",
    sessionId: null,
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({
      kind: CLOSED_ISSUE_EVENT,
      stateType: "duplicate",
      closedAtMs: 7,
      identifier: "ENG-1",
    }),
  });
  expect(closed).toMatchObject({ issueId: "issue", stateType: "canceled", closedAtMs: 7 });
});

test("catch-up reads a Duplicate issue as canceled at canceledAt", async () => {
  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const source = createIntakePollSource(
    {
      async query() {
        return {
          viewer: { id: "app" },
          issues: {
            nodes: [
              {
                id: "issue",
                identifier: "ENG-1",
                updatedAt: "2026-11-02T01:00:05.000Z",
                completedAt: null,
                canceledAt,
                state: { type: "duplicate" },
                delegate: null,
                labels: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          comments: empty,
          agentActivities: empty,
          agentSessions: empty,
        };
      },
    },
    { teamId: "team" },
  );
  const sighting = await source.poll(0);
  expect(sighting.issues.map((issue) => issue.closed)).toEqual([
    { stateType: "canceled", closedAtMs: Date.parse(canceledAt) },
  ]);
});
