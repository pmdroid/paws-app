import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { runAgent } from "../src/acp";
import { RunnerCommandRejectedError, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getWorkItem, listOutbox, listWorkItems } from "../src/db";
import {
  createFakeTracker,
  type AcceptedLinearEvent,
  type LinearActivitySnapshot,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const DESCRIPTION = "DESCRIPTION-MUST-SURVIVE: fix the failing tar extraction.";
const LATEST = "LATEST-HUMAN-COMMENT: please retry with the smaller archive.";

function activity(id: string, type: string, body: string, at: number): LinearActivitySnapshot {
  const createdAt = new Date(Date.UTC(2026, 10, 17, 19, at)).toISOString();
  return {
    id,
    sessionId: "session",
    createdAt,
    updatedAt: createdAt,
    userId: type === "prompt" ? "human" : "app-user",
    content: { type, body } as LinearActivitySnapshot["content"],
    signal: null,
    signalMetadata: null,
    sourceCommentId: null,
    ephemeral: false,
  };
}

async function harness(helper: (prompt: string) => Promise<never>) {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Fix the tar extraction",
      description: DESCRIPTION,
      subIssues: [],
    },
  ]);
  const tarDump = Array.from(
    { length: 400 },
    (_, line) => `tar: source/file-${line}: Cannot open: Function not implemented`,
  ).join("\n");
  tracker.listSessionActivities = async () => [
    activity("a1", "prompt", "Work on ENG-1", 1),
    activity("a2", "error", tarDump, 2),
    activity("a3", "response", "x".repeat(20_000), 3),
    activity("a4", "prompt", LATEST, 4),
  ];
  const helperCalls: string[] = [];
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let intake = true;
  const orchestrator = attachOrchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    linearTaskModes: true,
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: {
      slotFree: async () => !intake,
      agentForSession: () => async (options: Parameters<typeof runAgent>[0]) => {
        helperCalls.push(options.prompt);
        return helper(options.prompt);
      },
      agentForItem: () => async () => {
        throw new Error("No implementation turn is expected");
      },
    },
  });
  const event: AcceptedLinearEvent = {
    dedupeKey: "created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({
      agentSession: { creatorId: "human" },
      previousComments: Array.from({ length: 8 }, (_, index) => ({
        id: `comment-${index}`,
        body: `Comment ${index}: ${"y".repeat(5_000)}`,
      })),
    }),
  };
  await orchestrator.onLinearEvent(event);
  intake = false;
  const itemId = (await listWorkItems(db))[0]!.id;
  const tick = async () => {
    await db.run((q) =>
      q.exec(q.orm.update(q.t.job).set({ runAt: 0 }).where(eq(q.t.job.status, "pending"))),
    );
    await jobs.tick();
  };
  const errorPosts = async () =>
    (await listOutbox(db))
      .map((row) => (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload))
      .filter((payload: { kind?: string }) => payload.kind === "error")
      .map((payload: { body: string }) => payload.body);
  const done = async () => {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    await close();
  };
  return { db, itemId, helperCalls, tick, errorPosts, done };
}

test("a thread over the runner limit sends a prompt within it that keeps the description and latest human comment", async () => {
  const h = await harness(async () => {
    throw new Error("Remote session helper timed out");
  });
  try {
    await h.tick();
    expect(h.helperCalls).toHaveLength(1);
    const prompt = h.helperCalls[0]!;
    expect(prompt.length).toBeLessThanOrEqual(65_536);
    expect(prompt).toContain(DESCRIPTION);
    expect(prompt).toContain(LATEST);
    expect(prompt).toContain("[Shortened by Paws to fit the runner's prompt limit.]");
  } finally {
    await h.done();
  }
}, 20_000);

test("a start the runner protocol refuses fails the item once with the schema reason", async () => {
  const reason =
    "Paws built a classify command the runner protocol refuses: prompt: Too big: expected string to have <=65536 characters";
  const h = await harness(async () => {
    throw new RunnerCommandRejectedError(reason);
  });
  try {
    await h.tick();
    await h.tick();
    expect(h.helperCalls).toHaveLength(1);
    expect((await getWorkItem(h.db, h.itemId))?.state).toBe("failed");
    const posts = await h.errorPosts();
    expect(posts).toEqual([reason]);
    expect(posts[0]).not.toContain("attempts");
    expect(posts[0]).not.toContain("No paired runner");
  } finally {
    await h.done();
  }
}, 20_000);

test("a long runner error posts its first 20 lines and the count left out", async () => {
  const runnerError = Array.from(
    { length: 195 },
    (_, line) => `tar: source/file-${line}: Cannot open: Function not implemented`,
  ).join("\n");
  const h = await harness(async () => {
    throw new RunnerCommandRejectedError(runnerError);
  });
  try {
    await h.tick();
    expect((await getWorkItem(h.db, h.itemId))?.state).toBe("failed");
    const [posted] = await h.errorPosts();
    const lines = posted!.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines.slice(0, 20)).toEqual(runnerError.split("\n").slice(0, 20));
    expect(lines[20]).toBe("[175 more lines left out; the full text is in the run's transcript.]");
  } finally {
    await h.done();
  }
}, 20_000);
