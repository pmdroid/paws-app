import { expect, test } from "bun:test";
import {
  createLinearTracker,
  parseLinearSessionContext,
  renderLinearSessionContext,
  type LinearClient,
} from "../src/linear";
import {
  getLinearSessionContext,
  saveLinearSessionContext,
  saveLinearSessionSnapshotContext,
  hasLinearSessionSnapshotContext,
  saveLinearActivitySnapshot,
  listLinearActivitySnapshots,
} from "../src/db";
import { tempDb } from "./helpers";

const date = "2026-10-11T00:00:00.000Z";
const activity = (id: string, type = "prompt", body = "Request") => ({
  id,
  createdAt: date,
  updatedAt: date,
  user: { id: "human" },
  ephemeral: false,
  content: { type, body },
});

test("preserves initiating comment, earlier thread and guidance provenance with formatted context", () => {
  const context = parseLinearSessionContext(
    JSON.stringify({
      promptContext: "Mentioned request 雪",
      agentSession: {
        comment: { id: "c1", body: "Use the blue version" },
        issue: { id: "issue", description: "Issue detail" },
      },
      previousComments: [{ id: "c0", body: "Earlier decision" }],
      guidance: [
        { body: "Use workspace rules", origin: { type: "organization", id: "org" } },
        { body: "Use team rules", origin: { type: "team", id: "team" } },
      ],
    }),
  );
  const rendered = renderLinearSessionContext(context);
  for (const body of [
    "Mentioned request 雪",
    "Use the blue version",
    "Issue detail",
    "Earlier decision",
    "workspace rules",
    "team rules",
    '"id":"team"',
    "nearest team-specific",
  ])
    expect(rendered).toContain(body);
  expect(renderLinearSessionContext(parseLinearSessionContext("{}"))).toBe("");
});

test("thin polling context cannot erase richer webhook context and activity snapshots are immutable", () => {
  const db = tempDb();
  try {
    saveLinearSessionContext(db, "session", "poll issue", 0);
    saveLinearSessionContext(db, "session", "rich mention", 2);
    saveLinearSessionContext(db, "session", "later thin poll", 0);
    expect(hasLinearSessionSnapshotContext(db, "session")).toBe(false);
    saveLinearSessionSnapshotContext(db, "session", "API source thread and issue details");
    expect(hasLinearSessionSnapshotContext(db, "session")).toBe(true);
    expect(getLinearSessionContext(db, "session")).toBe(
      "rich mention\n\nAPI source thread and issue details",
    );
    saveLinearSessionContext(db, "session", "sparse webhook", 1);
    expect(getLinearSessionContext(db, "session")).toContain("API source thread and issue details");
    saveLinearActivitySnapshot(db, {
      id: "a",
      sessionId: "session",
      createdAt: date,
      snapshot: JSON.stringify(activity("a")),
    });
    saveLinearActivitySnapshot(db, {
      id: "a",
      sessionId: "session",
      createdAt: date,
      snapshot: JSON.stringify(activity("a", "prompt", "Edited comment")),
    });
    expect(JSON.parse(listLinearActivitySnapshots(db, "session")[0]!)).toEqual(activity("a"));
  } finally {
    db.close();
  }
});

test("reads nullable session context, source thread, all public statuses and links", async () => {
  const calls: string[] = [];
  const tracker = createLinearTracker({
    async query(query) {
      calls.push(query);
      return {
        agentSession: {
          id: "session",
          status: "stopping",
          createdAt: date,
          updatedAt: date,
          appUser: { id: "app" },
          creator: null,
          issue: null,
          comment: { id: "root", body: "Root", createdAt: date },
          sourceComment: { id: "mention", body: "Mention", createdAt: date },
          summary: "Task",
          plan: [{ content: "Plan", status: "pending" }],
          context: { team: "team" },
          externalLinks: [{ label: "PR", url: "https://github.com/acme/repo/pull/1" }],
          pullRequest: { id: "pr", url: "https://github.com/acme/repo/pull/1" },
        },
      };
    },
  });
  const result = await tracker.getSession("session");
  expect(result.status).toBe("stopping");
  expect(result.issue).toBeNull();
  expect(result.sourceComment?.body).toBe("Mention");
  expect(result.externalLinks).toHaveLength(1);
  expect(result.pullRequest?.id).toBe("pr");
  expect(calls[0]).toContain("sourceComment { id body createdAt }");
});

test("pages complete immutable activity history without a 50 or 500 activity cutoff", async () => {
  const calls: unknown[] = [];
  const client: LinearClient = {
    async query(query, variables) {
      expect(query).toContain("includeArchived: true");
      expect(query).toContain("orderBy: createdAt");
      calls.push(variables?.["after"]);
      const page = calls.length;
      return {
        agentSession: {
          id: "session",
          activities: {
            nodes: [
              ...(page > 1 ? [activity("000")] : []),
              ...Array.from({ length: 50 }, (_, offset) =>
                activity(String((page - 1) * 50 + offset).padStart(3, "0")),
              ),
            ],
            pageInfo: { hasNextPage: page < 11, endCursor: `page${page}` },
          },
        },
      };
    },
  };
  const activities = await createLinearTracker(client).listSessionActivities("session");
  expect(activities).toHaveLength(550);
  expect(calls).toHaveLength(11);
  expect(activities[0]?.userId).toBe("human");
  expect(activities.at(-1)?.id).toBe("549");
});

test("history preserves structured actions, all text types, signals and source comment IDs", async () => {
  const tracker = createLinearTracker({
    async query() {
      return {
        agentSession: {
          id: "session",
          activities: {
            nodes: [
              ...["thought", "prompt", "response", "error", "elicitation"].map((type) =>
                activity(type, type),
              ),
              {
                ...activity("action"),
                content: {
                  type: "action",
                  action: "Test",
                  parameter: "bun test",
                  result: "Passed",
                },
                signal: "continue",
                signalMetadata: { value: 1 },
                sourceComment: { id: "source" },
                ephemeral: true,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
  });
  const history = await tracker.listSessionActivities("session");
  expect(history).toHaveLength(6);
  expect(history.find((entry) => entry.id === "action")).toMatchObject({
    content: { type: "action", action: "Test", parameter: "bun test", result: "Passed" },
    signal: "continue",
    sourceCommentId: "source",
    ephemeral: true,
  });
});

test("history refuses a repeated cursor and cancellation instead of returning partial history", async () => {
  const tracker = createLinearTracker({
    async query() {
      return {
        agentSession: {
          id: "session",
          activities: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
        },
      };
    },
  });
  await expect(tracker.listSessionActivities("session")).rejects.toThrow("did not advance");
  const controller = new AbortController();
  controller.abort();
  await expect(
    tracker.listSessionActivities("session", { signal: controller.signal }),
  ).rejects.toThrow();
});

test.each(["", " \n "])("history preserves a string action parameter %j", async (parameter) => {
  const tracker = createLinearTracker({
    async query() {
      return {
        agentSession: {
          id: "session",
          activities: {
            nodes: [
              { ...activity("action"), content: { type: "action", action: "Read", parameter } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    },
  });
  expect((await tracker.listSessionActivities("session"))[0]?.content).toEqual({
    type: "action",
    action: "Read",
    parameter,
  });
});

test.each([undefined, null, 123, {}, []])(
  "history rejects a non-string action parameter %j",
  async (parameter) => {
    const tracker = createLinearTracker({
      async query() {
        return {
          agentSession: {
            id: "session",
            activities: {
              nodes: [
                { ...activity("action"), content: { type: "action", action: "Read", parameter } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    });
    await expect(tracker.listSessionActivities("session")).rejects.toThrow(
      "Missing or invalid Linear parameter",
    );
  },
);
