import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  migrate,
  openDatabase,
  saveTaskMode,
  setJournalSink,
} from "../src/db";
import { unavailableRemoteExecution } from "../src/index";
import { createFakeTracker } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { workspaceAdmission } from "./fake-workspace";
import { tempHome } from "./helpers";

test("with a workspace and no paired runner a delegated task fails because a remote runner is required", async () => {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Explain the queue",
      description: null,
      subIssues: [],
    },
  ]);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    home,
    pawsRoot: home,
    tracker,
    linearTaskModes: true,
    admission: workspaceAdmission(db),
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: unavailableRemoteExecution(),
  });
  try {
    await orchestrator.onLinearEvent({
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
      payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
    });
    const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!.id;
    saveTaskMode(db, itemId, "answer");
    await orchestrator.reconcileExecution();
    for (let tick = 0; tick < 5 && getWorkItem(db, itemId)?.state !== "failed"; tick++)
      await jobs.tick();
    await outbox.idle();
    expect(getWorkItem(db, itemId)?.state).toBe("failed");
    expect(stderr.mock.calls.map(([line]) => line)).toContain(
      "ENG-1 failed (answer_error): A remote runner is required.",
    );
    expect(lines).toContain("item ENG-1 failed: answer_error");
    expect(
      tracker.progress.filter((update) => update.kind === "error").map((update) => update.body),
    ).toEqual(["A remote runner is required."]);
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    stderr.mockRestore();
    restore();
    db.close();
  }
});
