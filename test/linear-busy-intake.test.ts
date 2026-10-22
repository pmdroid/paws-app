import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "../src/acp";
import { RunnerSlotsBusyError, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  getTaskMode,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { tempHome } from "./helpers";

test("a session delegated while every runner slot is busy is queued at once and classified when it starts", async () => {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const db = openDatabase(join(root, "paws.db"));
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
  const purposes: string[] = [];
  let busy = true;
  const launch: AgentLaunch = (input) => {
    purposes.push(input.purpose);
    const script = join(home, `${purposes.length}.script.json`);
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: input.purpose === "classify" ? '{"mode":"answer"}' : "The queue answer.",
              },
            },
          },
          { type: "end" },
        ],
      }),
    );
    return {
      command: process.execPath,
      args: [
        resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"),
        join(home, `${purposes.length}.trace.json`),
        script,
      ],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    };
  };
  const remote = (purpose: string) => async (options: Parameters<typeof runAgent>[0]) => {
    if (busy) throw new RunnerSlotsBusyError();
    return runAgent({
      ...options,
      ...launch({
        purpose: purpose as never,
        role: options.role,
        profile: options.profile,
        itemId: options.itemId,
        worktree: options.worktreePath,
        prompt: options.prompt,
      }),
    });
  };
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
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
      slotFree: () => !busy,
      agentForSession: (_sessionId, purpose) => remote(purpose),
      agentForItem: () => remote("answer"),
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
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
  try {
    await orchestrator.onLinearEvent(event);
    const itemId = db.query<{ id: string }, []>("SELECT id FROM work_item").get()?.id;
    const atIntake = {
      state: itemId ? getWorkItem(db, itemId)?.state : null,
      mode: itemId ? getTaskMode(db, itemId) : null,
      purposes: [...purposes],
    };
    busy = false;
    for (let tick = 0; tick < 5 && getWorkItem(db, itemId!)?.state !== "completed"; tick++)
      await jobs.tick();
    expect({
      atIntake,
      state: getWorkItem(db, itemId!)?.state,
      mode: getTaskMode(db, itemId!),
      purposes,
    }).toEqual({
      atIntake: { state: "queued", mode: null, purposes: [] },
      state: "completed",
      mode: "answer",
      purposes: ["classify", "answer"],
    });
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    db.close();
  }
}, 20_000);
