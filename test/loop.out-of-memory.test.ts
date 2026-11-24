import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import {
  cloneRunnerPg,
  emptyReview,
  repoLayout,
  stateOfPg,
  tickWithRestartsPg,
  writeOk,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a turn the OOM killer ended waits on a question that names the runner's memory", async () => {
  const result = await killedTurn({
    errorMessage:
      "The runner stopped this run: the runner ran out of memory during phase agent (3.8 GB on this runner).\n\nLast worker output:\nboom",
    failureReason: "out_of_memory",
  });
  expect(result.state, result.detail).toBe("awaiting_input");
  expect(result.questions, result.detail).toHaveLength(1);
  expect(result.questions[0]!.body).toStartWith(
    "The runner stopped this run: the runner ran out of memory during phase agent (3.8 GB on this runner). Retry here, or stop?",
  );
  expect(result.questions[0]!.options).toEqual(["Retry here", "Stop"]);
}, 90_000);

test("a worker killed by signal 9 without an OOM kill still fails", async () => {
  const result = await killedTurn({
    errorMessage:
      "The runner stopped this run: worker exited with signal 9 during phase agent.\n\nLast worker output:\nboom",
  });
  expect(result.state, result.detail).toBe("failed");
  expect(result.questions, result.detail).toEqual([]);
}, 90_000);

async function killedTurn(failure: { errorMessage: string; failureReason?: "out_of_memory" }) {
  const layout = await repoLayout("paws-oom-loop-");
  const { db, close } = await tempStore();
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
  let sequence = 0;
  const repository = { owner: "pmdroid", repo: "paws-demo" };
  const orchestrator = attachOrchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    tracker,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repositories: [{ ...repository, remoteUrl: layout.bare }],
    retryBaseMs: 10,
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem() {
        return cloneRunnerPg(
          repository,
          async (input: RunAgentOptions): Promise<RunAgentResult> => {
            if (input.prepareOnly) return runAgent(input);
            return {
              role: input.role,
              stopReason: "error",
              ...failure,
              cancelled: false,
              timedOut: false,
              authRequired: false,
              agentExited: true,
            };
          },
          db,
        );
      },
    },
    launch(input) {
      sequence += 1;
      const script = path.join(layout.root, `oom-${sequence}.json`);
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
    const settled = async () =>
      ["awaiting_input", "failed"].includes((await stateOfPg(db, "ENG-9")) ?? "");
    while (Date.now() < deadline && !(await settled())) {
      const job = await tickWithRestartsPg(jobs, orchestrator, db);
      if (job === null) {
        await outbox.tick();
        await Bun.sleep(20);
      }
    }
    for (let index = 0; index < 20; index++) {
      await outbox.tick();
      await outbox.idle();
    }
    return {
      state: await stateOfPg(db, "ENG-9"),
      questions: tracker.questions,
      detail: JSON.stringify(tracker.progress.map((update) => `${update.kind}: ${update.body}`)),
    };
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await close();
    await layout.cleanup();
  }
}

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
