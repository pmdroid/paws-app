import { tickWithRestarts } from "./helpers";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, migrate, openDatabase } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { BRANCH_CONFLICT_INSTRUCTION, attachOrchestrator } from "../src/loop";
import { emptyReview, repoLayout, stateOf, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const CONFLICT = "commit abc1234 conflicts with the branch on GitHub at def5678";

test("a candidate that conflicts with its branch goes to one conflict round, then asks the team", async () => {
  const layout = await repoLayout("paws-branch-conflict-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
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
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const prompts: string[] = [];
  const rounds: boolean[] = [];
  let sequence = 0;
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
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
        // What the remote backend returns when the runner reports a conflicting candidate.
        return async (input: RunAgentOptions): Promise<RunAgentResult> => {
          if (input.prepareOnly) return runAgent(input);
          prompts.push(input.prompt);
          const round = input.conflictRound?.() ?? false;
          rounds.push(round);
          if (!round)
            await input.askTeam!.ask(
              { question: `Paws could not push the candidate: ${CONFLICT}` },
              { itemId: input.itemId, runId: input.runId, role: input.role, signal: input.signal! },
            );
          return {
            role: input.role,
            stopReason: "error",
            cancelled: false,
            timedOut: false,
            authRequired: false,
            agentExited: true,
            errorMessage: "The runner stopped this run.",
            ...(round ? { candidateConflict: { branch: "paws/eng-9", error: CONFLICT } } : {}),
          };
        };
      },
    },
    launch(input) {
      sequence += 1;
      const script = path.join(layout.root, `conflict-${sequence}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }],
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  try {
    await orchestrator.onLinearEvent(createdEvent());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && tracker.questions.length === 0) {
      const job = await tickWithRestarts(jobs, orchestrator, db);
      orchestrator.reconcileExecution();
      await jobs.tick(["run.resume"]);
      if (job === null) {
        outbox.tick();
        await Bun.sleep(20);
      }
    }
    for (let index = 0; index < 20; index++) {
      const job = await tickWithRestarts(jobs, orchestrator, db);
      outbox.tick();
      await outbox.idle();
      if (job === null) await Bun.sleep(10);
    }
    const detail = JSON.stringify({
      prompts,
      items: db.query("SELECT linear_identifier, state FROM work_item").all(),
      events: db.query("SELECT kind, reason FROM work_item_event").all(),
    });
    expect(rounds, detail).toEqual([true, false]);
    expect(prompts[1], detail).toContain(BRANCH_CONFLICT_INSTRUCTION);
    expect(prompts[1], detail).toContain(CONFLICT);
    expect(
      db
        .query<{ reason: string }, []>(
          "SELECT reason FROM work_item_event WHERE kind='restart' ORDER BY id",
        )
        .all()
        .map((row) => row.reason),
      detail,
    ).toEqual(["conflict"]);
    expect(tracker.questions.map((question) => question.body)).toEqual([
      expect.stringContaining("Paws could not push the candidate"),
    ]);
    expect(stateOf(db, "ENG-9"), detail).toBe("awaiting_input");
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
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
