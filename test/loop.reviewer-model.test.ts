import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { ReviewerModelConflict, RunnerCapacityWait, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { questionEffects } from "../src/loop/question-effects";
import { answerSteps } from "../src/questions";
import {
  cloneRunnerPg,
  emptyReview,
  repoLayout,
  stateOfPg,
  tickWithRestartsPg,
  writeOk,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { runnerCheckout } from "./helpers";
import { tempStore } from "./pglite";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a reviewer model equal to the implementer's asks once and reviews with the chosen model", async () => {
  await withLoop(
    (input) =>
      input.profile?.model === "gpt-other"
        ? null
        : new ReviewerModelConflict(
            "test-claude-model",
            ["codex gpt-other"],
            ["agentbox: reviewer model matches implementation model"],
          ),
    async (f) => {
      await f.until(async () => (await f.state()) === "awaiting_input");
      await f.drain();
      expect(f.tracker.questions, await f.detail()).toHaveLength(1);
      expect(f.tracker.questions[0]!.body).toStartWith(
        "ENG-9 was implemented with test-claude-model",
      );
      expect(f.tracker.questions[0]!.options).toEqual(["codex gpt-other", "Stop"]);
      await f.answer("codex gpt-other");
      await f.until(async () => f.reviewers.includes("gpt-other"));
      await f.until(async () => (await f.state()) !== "verifying");
      expect(await f.state(), await f.detail()).not.toBeOneOf(["failed", "awaiting_input"]);
      expect(f.tracker.questions).toHaveLength(1);
    },
  );
}, 120_000);

test("Stop on the reviewer model question ends the item as stopped", async () => {
  await withLoop(
    () =>
      new ReviewerModelConflict(
        "test-claude-model",
        [],
        ["agentbox: reviewer model matches implementation model"],
      ),
    async (f) => {
      await f.until(async () => (await f.state()) === "awaiting_input");
      await f.drain();
      expect(f.tracker.questions[0]!.options).toEqual(["Stop"]);
      await f.answer("Stop");
      expect(await f.state()).toBe("failed");
    },
  );
}, 120_000);

test("a busy reviewer runner still waits without asking", async () => {
  let refusals = 0;
  await withLoop(
    () => {
      refusals += 1;
      return new RunnerCapacityWait(["runner-1"]);
    },
    async (f) => {
      await f.until(async () => refusals > 0);
      await f.until(async () => false, 5_000);
      await f.drain();
      expect(f.tracker.questions, await f.detail()).toEqual([]);
      expect(await f.state(), await f.detail()).toBe("verifying");
    },
  );
}, 120_000);

async function withLoop(
  refuse: (input: RunAgentOptions) => Error | null,
  body: (f: {
    tracker: ReturnType<typeof createFakeTracker>;
    reviewers: string[];
    state(): Promise<string | null>;
    until(done: () => Promise<boolean>, ms?: number): Promise<void>;
    drain(): Promise<void>;
    answer(text: string): Promise<void>;
    detail(): Promise<string>;
  }) => Promise<void>,
) {
  const layout = await repoLayout("paws-reviewer-model-");
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
  const reviewers: string[] = [];
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
    placementPollMs: 1,
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem() {
        return cloneRunnerPg(
          repository,
          async (input: RunAgentOptions): Promise<RunAgentResult> => {
            if (input.role === "reviewer" && !input.prepareOnly) {
              const refused = refuse(input);
              if (refused) throw refused;
              reviewers.push(input.profile?.model ?? "");
              return runAgent(input);
            }
            if (input.checkpoint !== false || input.prepareOnly) return runAgent(input);
            const session = createCloseoutSession(input.worktreePath, {
              policy: async () => workspacePolicyFiles(input.worktreePath),
              ...(input.closeoutRulesFirst ? { rulesFirst: true } : {}),
            });
            const listed = JSON.parse(await session.report()) as { pending: string[] };
            for (const id of listed.pending) await session.run(id);
            return {
              role: "implementer",
              stopReason: "end_turn",
              timedOut: false,
              cancelled: false,
              authRequired: false,
              agentExited: true,
              closeoutReport: await session.report({ probes: true }),
            };
          },
          db,
        );
      },
    },
    launch(input) {
      sequence += 1;
      const script = path.join(layout.root, `reviewer-${sequence}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          models: ["test-codex-model", "test-claude-model", "gpt-other"],
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [
                  writeOk(runnerCheckout(layout.pawsRoot, input.itemId)),
                  { type: "end", stopReason: "end_turn" },
                ],
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  const state = () => stateOfPg(db, "ENG-9");
  const drain = async () => {
    for (let index = 0; index < 20; index++) {
      await outbox.tick();
      await outbox.idle();
    }
  };
  try {
    await orchestrator.onLinearEvent(createdEvent());
    await body({
      tracker,
      reviewers,
      state,
      drain,
      detail: async () =>
        `${await state()} ${JSON.stringify(tracker.progress.map((update) => `${update.kind}: ${update.body}`))}`,
      async until(done, ms = 60_000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && !(await done())) {
          if ((await state()) === "failed") break;
          const job = await tickWithRestartsPg(jobs, orchestrator, db);
          if (job === null) {
            await outbox.tick();
            await Bun.sleep(20);
          }
        }
      },
      async answer(text) {
        const now = Date.now();
        const outcome = await db.transaction((q) =>
          answerSteps(
            q,
            {
              sessionId: "ses_1",
              deliveryId: `reply:${text}`,
              body: text,
              answeredBy: "pascal",
              now,
            },
            questionEffects(db, { now }),
          ),
        );
        expect(outcome.status).toBe("answered");
      },
    });
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
