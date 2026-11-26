import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { useMemorySettings } from "../src/config";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { questionEffects } from "../src/loop/question-effects";
import { answerSteps } from "../src/questions";
import * as h from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";
import { runnerCheckout } from "./helpers";
import { tempStore } from "./pglite";
import { withoutForeignKeys } from "./pglite-fixtures";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const issue = { linearIssueId: "issue", identifier: "ENG-9", title: "Ok", subIssues: [] };
const created = { dedupeKey: "c", action: "created", sessionId: "ses_1", issueId: "issue" };
const catalog = { models: [{ id: "implemented" }, { id: "gpt-other" }, { id: "default" }] };

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

async function review(reviewerModel: string) {
  const layout = await h.repoLayout("paws-reviewer-model-");
  const settings = useMemorySettings(
    path.join(layout.pawsRoot, "config.toml"),
    `[agents.defaults.implementer]\nagent = "claude"\nmodel = "test-claude-model"\n[agents.defaults.reviewer]\nagent = "codex"\nmodel = "${reviewerModel}"\n`,
  );
  const { db, close } = await tempStore();
  await withoutForeignKeys(db);
  const tracker = createFakeTracker([{ ...issue, description: null }]);
  const [jobs, outbox] = [new JobLoop(db, systemClock), new OutboxDispatcher(db, systemClock)];
  const repository = { owner: "pmdroid", repo: "paws-demo" };
  const reviewed: (string | null | undefined)[] = [];
  const runner = h.cloneRunnerPg(
    repository,
    async (input) => {
      if (input.role === "reviewer" && !input.prepareOnly) reviewed.push(input.profile?.model);
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
      const models = [model, "gpt-other", "implemented"];
      writeFileSync(script, JSON.stringify({ model, models, steps }));
      return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
    },
  });
  const state = () => h.stateOfPg(db, "ENG-9");
  const until = async (done: () => Promise<boolean>) => {
    for (const end = Date.now() + 60_000; Date.now() < end && !(await done());)
      if ((await h.tickWithRestartsPg(jobs, orchestrator, db)) === null) await outbox.tick();
    for (let index = 0; index < 20; index++) await outbox.tick().then(() => outbox.idle());
  };
  const answer = async (body: string) => {
    const reply = { sessionId: "ses_1", deliveryId: "r", body, now: Date.now() };
    const effects = questionEffects(db, { now: reply.now });
    await db.transaction((q) => answerSteps(q, { ...reply, answeredBy: "pascal" }, effects));
  };
  await orchestrator.onLinearEvent({ ...created, payload: "{}" } as AcceptedLinearEvent);
  await db.run(function* (q) {
    const workspace = yield* q.one(q.orm.select({ id: q.t.workspace.id }).from(q.t.workspace));
    const box = { id: "box", ownerUserId: "owner", name: "box", status: "active", createdAt: 0 };
    yield* q.exec(q.orm.insert(q.t.runner).values({ ...box, workspaceId: workspace!.id }));
    const row = { runnerId: "box", userId: "owner", agent: "codex", model: "", updatedAt: 1 };
    yield* q.exec(q.orm.insert(q.t.agentModelCatalog).values({ ...row, resultJson: catalog }));
    const item = yield* q.one(q.orm.select({ id: q.t.workItem.id }).from(q.t.workItem));
    const usage = { commandId: "c", runnerId: "box", ownerUserId: "owner", itemId: item!.id };
    const role = { role: "implementer", purpose: "work", outcome: "success" } as const;
    const run = { startedAt: 1, endedAt: 2, resolvedModel: "implemented" };
    yield* q.exec(q.orm.insert(q.t.runnerExecutionUsage).values({ ...usage, ...role, ...run }));
  });
  const cleanup = async () => {
    await orchestrator.shutdown().catch(() => undefined);
    settings.release();
    await close();
    await layout.cleanup();
  };
  return { tracker, reviewed, state, until, answer, cleanup };
}

test("an equal reviewer model asks before placing the review, then reviews with the answer", async () => {
  const run = await review("implemented");
  try {
    await run.until(async () => ["awaiting_input", "failed"].includes((await run.state()) ?? ""));
    expect(await run.state()).toBe("awaiting_input");
    expect(run.reviewed).toEqual([]);
    expect(run.tracker.questions[0]!.body).toStartWith("ENG-9 was implemented with implemented");
    expect(run.tracker.questions[0]!.options).toEqual(["codex gpt-other", "Stop"]);
    await run.answer("codex gpt-other");
    await run.until(async () => (await run.state()) !== "verifying");
    expect(run.reviewed).toEqual(["gpt-other"]);
    expect(await run.state()).not.toBeOneOf(["failed", "awaiting_input"]);
    expect(run.tracker.questions).toHaveLength(1);
  } finally {
    await run.cleanup();
  }
}, 120_000);

test("a different reviewer model places the review without asking", async () => {
  const run = await review("gpt-other");
  try {
    await run.until(async () => run.reviewed.length > 0 || (await run.state()) === "failed");
    expect(run.reviewed).toEqual(["gpt-other"]);
    expect(run.tracker.questions).toEqual([]);
  } finally {
    await run.cleanup();
  }
}, 120_000);
