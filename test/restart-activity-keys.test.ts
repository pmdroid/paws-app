import path from "node:path";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  runAgent,
  type AcpEvent,
  type AcpEventOrigin,
  type RunAgentOptions,
  type RunAgentResult,
} from "../src/acp";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listOutbox,
  listWorkItems,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { emptyReview, repoLayout } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { writeFileSync } from "node:fs";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

type Update = { text: string; origin?: AcpEventOrigin };

test("updates from a run that Paws resumes after a restart all land in the outbox once", async () => {
  const layout = await repoLayout("paws-restart-activity-");
  const file = path.join(layout.pawsRoot, "paws.db");
  let db = openDatabase(file);
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-9",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const origin = (sequence: number): AcpEventOrigin => ({
    runId: "remote",
    generation: 1,
    sequence,
  });
  let turn: Update[] = [];
  let sent = 0;
  let sequence = 0;
  const open = (database: Database) => {
    // The stopped process leaves its job leased. A short lease lets the next process claim it soon.
    const jobs = new JobLoop(database, systemClock, { leaseMs: 1_000 });
    const outbox = new OutboxDispatcher(database, systemClock);
    const orchestrator = attachOrchestrator({
      db: database,
      admission: workspaceAdmission(database),
      jobs,
      outbox,
      tracker,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      retryBaseMs: 10,
      remoteExecution: {
        agentForSession() {
          throw new Error("This fixture does not request a routing helper");
        },
        agentForItem() {
          return async (input: RunAgentOptions): Promise<RunAgentResult> => {
            if (input.prepareOnly) return runAgent(input);
            for (const update of turn) {
              const event: AcpEvent = { type: "progress", text: update.text };
              await input.onEvent?.(event, update.origin);
              sent++;
            }
            // The runner keeps working until Paws stops listening.
            await new Promise((_, reject) => {
              if (input.signal?.aborted) reject(input.signal.reason);
              input.signal?.addEventListener("abort", () => reject(input.signal?.reason));
            });
            throw new Error("unreachable");
          };
        },
      },
      launch(input) {
        sequence += 1;
        const script = path.join(layout.root, `restart-${sequence}.json`);
        writeFileSync(
          script,
          JSON.stringify({
            model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
            steps: emptyReview().steps,
          }),
        );
        return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
      },
    });
    return { jobs, outbox, orchestrator };
  };
  // A job tick waits for the turn, and the turn waits for the shutdown, so ticks run unawaited.
  const until = async (paws: ReturnType<typeof open>, count: number) => {
    const deadline = Date.now() + 60_000;
    let ticking: Promise<unknown> = Promise.resolve();
    while (Date.now() < deadline) {
      if (sent >= count) return;
      paws.orchestrator.reconcileExecution();
      paws.outbox.tick();
      ticking = ticking.then(() => paws.jobs.tick()).catch(() => undefined);
      await Promise.race([ticking, Bun.sleep(50)]);
    }
  };
  let paws = open(db);
  try {
    turn = [
      { text: "Read the issue.", origin: origin(1) },
      { text: "Paws note before the restart." },
      { text: "Wrote the first test.", origin: origin(2) },
    ];
    await paws.orchestrator.onLinearEvent(createdEvent());
    await until(paws, 3);
    expect(sent).toBe(3);
    const runId = listWorkItems(db)[0]!.currentRunId!;

    await paws.orchestrator.shutdown();
    prepareShutdown(db);
    db.close();
    db = openDatabase(file);
    recoverOnStartup(db, Date.now() - 60_000);
    paws = open(db);
    // The runner sends the event that was in flight again, then goes on.
    turn = [
      { text: "Wrote the first test.", origin: origin(2) },
      { text: "Paws note after the restart." },
      { text: "Made the test pass.", origin: origin(3) },
      { text: "Opened the pull request.", origin: origin(4) },
    ];
    await until(paws, 7);
    expect(sent).toBe(7);
    expect(listWorkItems(db)[0]!.currentRunId).toBe(runId);

    const bodies = listOutbox(db)
      .filter((row) => row.idempotencyKey.startsWith(`${runId}:acp:`))
      .map((row) => (row.payload as { body: string }).body);
    expect(bodies).toEqual([
      "Read the issue.",
      "Paws note before the restart.",
      "Wrote the first test.",
      "Paws note after the restart.",
      "Made the test pass.",
      "Opened the pull request.",
    ]);
  } finally {
    await paws.orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 90_000);

function createdEvent(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
