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
const owner = { ownerUserId: "owner", userId: "owner", createdAt: 0, updatedAt: 0, checkedAt: 0 };
const box = { runnerId: "box", agent: "codex", model: "", startedAt: 1, endedAt: 2 };
const implemented = { role: "implementer", purpose: "work", outcome: "success" };
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

for (const reviewerModel of ["implemented", "gpt-other"])
  test(`reviewer model ${reviewerModel}: asks before placing only when it equals the implementation`, async () => {
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
    try {
      await orchestrator.onLinearEvent({ ...created, payload: "{}" } as AcceptedLinearEvent);
      await db.run(function* (q) {
        const one = (table: typeof q.t.workspace | typeof q.t.workItem) =>
          q.one(q.orm.select({ id: table.id }).from(table));
        const [workspace, item] = [yield* one(q.t.workspace), yield* one(q.t.workItem)];
        const ids = { workspaceId: workspace!.id, itemId: item!.id, quotaScope: "unknown" };
        const b = { ...ids, ...owner, ...box, ...implemented, resolvedModel: "implemented" };
        const insert = (table: unknown, values: object) =>
          q.exec(q.orm.insert(table as never).values({ ...b, ...values } as never));
        yield* insert(q.t.runner, { id: "box", name: "box", status: "active" });
        yield* insert(q.t.workspaceMember, { role: "member", source: "linear", active: 1 });
        yield* insert(q.t.runnerAgentPolicy, {});
        yield* insert(q.t.agentAccount, { id: "acct", label: "a" });
        yield* insert(q.t.agentAccountBinding, { id: "b", accountId: "acct" });
        yield* insert(q.t.agentModelCatalog, { resultJson: catalog });
        yield* insert(q.t.runnerExecutionUsage, { commandId: "c" });
      });
      if (reviewerModel === "gpt-other") {
        await until(async () => reviewed.length > 0 || (await state()) === "failed");
        expect([reviewed, tracker.questions]).toEqual([["gpt-other"], []]);
        return;
      }
      await until(async () => ["awaiting_input", "failed"].includes((await state()) ?? ""));
      expect([await state(), reviewed]).toEqual(["awaiting_input", []]);
      expect(tracker.questions[0]!.body).toStartWith("ENG-9 was implemented with implemented");
      expect(tracker.questions[0]!.options).toEqual(["codex gpt-other", "Stop"]);
      const reply = { sessionId: "ses_1", deliveryId: "r", body: "Codex gpt-other" };
      const effects = questionEffects(db, { now: Date.now() });
      await db.transaction((q) =>
        answerSteps(q, { ...reply, answeredBy: "pascal", now: Date.now() }, effects),
      );
      await until(async () => (await state()) !== "verifying");
      expect([reviewed, tracker.questions.length]).toEqual([["gpt-other"], 1]);
      expect(await state()).not.toBeOneOf(["failed", "awaiting_input"]);
    } finally {
      await orchestrator.shutdown().catch(() => undefined);
      settings.release();
      await close();
      await layout.cleanup();
    }
  }, 120_000);
