import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { ReviewerModelConflict, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { questionEffects } from "../src/loop/question-effects";
import { answerSteps } from "../src/questions";
import * as h from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { runnerCheckout } from "./helpers";
import { tempStore } from "./pglite";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const issue = { linearIssueId: "issue", identifier: "ENG-9", title: "Ok", subIssues: [] };
const created = { dedupeKey: "c", action: "created", sessionId: "ses_1", issueId: "issue" };

async function checksRun(input: RunAgentOptions): Promise<RunAgentResult> {
  const session = createCloseoutSession(input.worktreePath, {
    policy: async () => workspacePolicyFiles(input.worktreePath),
  });
  for (const id of (JSON.parse(await session.report()) as { pending: string[] }).pending)
    await session.run(id);
  const closeoutReport = await session.report({ probes: true });
  const ended = { stopReason: "end_turn", cancelled: false, timedOut: false } as const;
  return { role: input.role, ...ended, authRequired: false, agentExited: true, closeoutReport };
}

test("a reviewer model equal to the implementer's asks once, then reviews with the answer", async () => {
  const layout = await h.repoLayout("paws-reviewer-model-");
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([{ ...issue, description: null }]);
  const [jobs, outbox] = [new JobLoop(db, systemClock), new OutboxDispatcher(db, systemClock)];
  const repository = { owner: "pmdroid", repo: "paws-demo" };
  const reviewed: (string | null | undefined)[] = [];
  const runner = h.cloneRunnerPg(
    repository,
    async (input) => {
      if (input.role === "reviewer" && !input.prepareOnly) {
        if (input.profile?.model !== "gpt-other")
          throw new ReviewerModelConflict("test-claude-model", ["codex gpt-other"], []);
        reviewed.push(input.profile.model);
      }
      const checks = input.role === "implementer" && input.checkpoint === false;
      return checks && !input.prepareOnly ? checksRun(input) : runAgent(input);
    },
    db,
  );
  const orchestrator = attachOrchestrator({
    ...{ store: db, admission: workspaceAdmission(db), jobs, outbox, tracker, retryBaseMs: 10 },
    ...{ pawsRoot: layout.pawsRoot, home: layout.home, placementPollMs: 1 },
    repositories: [{ ...repository, remoteUrl: layout.bare }],
    remoteExecution: { agentForSession: () => runAgent, agentForItem: () => runner },
    launch(input) {
      const script = path.join(layout.root, `${crypto.randomUUID()}.json`);
      const work = [h.writeOk(runnerCheckout(layout.pawsRoot, input.itemId)), { type: "end" }];
      const steps = input.purpose === "review" ? h.emptyReview().steps : work;
      const model = input.role === "reviewer" ? "test-codex-model" : "test-claude-model";
      writeFileSync(script, JSON.stringify({ model, models: [model, "gpt-other"], steps }));
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  const state = () => h.stateOfPg(db, "ENG-9");
  const until = async (done: () => Promise<boolean>) => {
    for (const end = Date.now() + 60_000; Date.now() < end && !(await done());)
      if ((await h.tickWithRestartsPg(jobs, orchestrator, db)) === null) await outbox.tick();
    for (let index = 0; index < 20; index++) await outbox.tick().then(() => outbox.idle());
  };
  try {
    await orchestrator.onLinearEvent({ ...created, payload: "{}" } as AcceptedLinearEvent);
    await until(async () => (await state()) === "awaiting_input");
    expect(tracker.questions[0]!.body).toStartWith("ENG-9 was implemented with test-claude-model");
    expect(tracker.questions[0]!.options).toEqual(["codex gpt-other", "Stop"]);
    const reply = { sessionId: "ses_1", deliveryId: "r", body: "codex gpt-other", now: Date.now() };
    const effects = questionEffects(db, { now: reply.now });
    await db.transaction((q) => answerSteps(q, { ...reply, answeredBy: "pascal" }, effects));
    await until(async () => (await state()) !== "verifying");
    expect(reviewed).toEqual(["gpt-other"]);
    expect(await state()).not.toBeOneOf(["failed", "awaiting_input"]);
    expect(tracker.questions).toHaveLength(1);
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await close();
    await layout.cleanup();
  }
}, 120_000);
