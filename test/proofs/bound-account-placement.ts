import { MINIMUM_RUNNER_VERSION } from "../../src/runner-protocol";
import { probeRunnerPlacement } from "../local/runner-placement";
import { eq } from "drizzle-orm";
import { seed } from "../pglite-fixtures";
import * as data from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";
export default {
  covers: ["src/runner-placement/**", "src/db/agent-account*.ts", "src/runner-backend/**"],
  summary: "Bound accounts place work and recover from temporary health failures.",
  agent: () => [],
  async run({ store: db, expect }) {
    const { pair, queue, workspace, userId } = await workspaceWithRunners(db);
    const runnerId = await pair("bound", 1, [REPOSITORY]);
    await queue("bound-work");
    await seed(db, (q) =>
      q.orm.delete(q.t.runnerAgentPolicy).where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
    );
    const placement = createRunnerPlacement({ store: db, now: () => NOW });
    const request = {
      itemId: "bound-work",
      role: "implementer" as const,
      purpose: "work" as const,
      profile: { agent: "claude" as const },
    };
    const binding = (await data.listAgentBindings(db, workspace.id)).find(
      (b) => b.runnerId === runnerId && !b.legacy,
    )!;
    for (const runnerVersion of [null, "0.1.83"]) {
      await seed(db, (q) =>
        q.orm
          .update(q.t.runnerHostStatus)
          .set({ runnerVersion })
          .where(eq(q.t.runnerHostStatus.runnerId, runnerId)),
      );
      expect("outdated runner refuses work", (await placement.candidates(request)).length === 0);
    }
    await data.recordRunnerHostStatus(
      db,
      runnerId,
      { runnerVersion: MINIMUM_RUNNER_VERSION.join(".") },
      NOW,
    );
    expect("minimum runner accepts work", (await placement.candidates(request)).length === 1);
    await probeRunnerPlacement(process.env.TMPDIR!, expect);
    for (const [index, source] of (["login_check", "sign_in"] as const).entries()) {
      await data.recordAccountObservation(db, {
        bindingId: binding.id,
        source: "result",
        sourceId: `expired-${source}`,
        observedAt: NOW + index * 2 + 1,
        now: NOW + index * 2 + 1,
        state: "auth_required",
      });
      await data.holdForRunnerSetup(db, {
        itemId: "bound-work",
        ownerUserId: userId,
        runnerId,
        reason: "agent-not-signed-in",
        agent: "claude",
        now: NOW + index * 2 + 1,
      });
      await seed(db, (q) => q.orm.delete(q.t.job));
      await data.recordAccountObservation(db, {
        bindingId: binding.id,
        source,
        sourceId: `success-${source}`,
        observedAt: NOW + index * 2 + 2,
        now: NOW + index * 2 + 2,
        state: "ok",
        clears: ["auth"],
      });
      expect(
        `${source} success queues a held owner's setup check`,
        (await data.listJobs(db)).some(
          (job) =>
            job.queue === "runner_setup.check" &&
            (job.payload as { ownerUserId?: string }).ownerUserId === userId,
        ),
      );
    }
    const at = { workspaceId: workspace.id, now: NOW };
    const a = await data.createAgentAccount(db, {
      ownerUserId: userId,
      ...at,
      agent: "claude",
      label: "alternate",
    });
    const alternate = await data.bindAgentAccount(db, {
      userId: userId,
      ...at,
      runnerId,
      accountId: a.id,
    });
    const [next] = await placement.candidates({ ...request, excludeRunnerIds: [binding.id] });
    expect("failover chooses the alternate binding", next?.account?.bindingId === alternate.id);
  },
} satisfies Proof;
