import { bindingReadinessSteps } from "../../src/runner-placement";
import { eq } from "drizzle-orm";
import {
  bindAgentAccountSteps,
  recordAccountObservationSteps,
  createAgentAccountSteps,
  saveProviderUsageSteps,
} from "../../src/db";
import { leaseCentralAccount, UsageLimitPause } from "../../src/runner-backend";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import { seed } from "../pglite-fixtures";
import type { Proof } from "./harness";
export default {
  covers: [
    "src/agent-auth/**",
    "src/db/account-provider-usage.ts",
    "src/db/agent-account-credentials.ts",
  ],
  summary:
    "Provider usage pauses account placement until reset, while extra usage permits the run.",
  agent: () => [],
  async run(proof) {
    const db = proof.store;
    const { pair, workspace, userId } = await workspaceWithRunners(db);
    const runnerId = await pair("usage-runner", 1, [REPOSITORY]);
    await seed(db, (q) => q.orm.update(q.t.agentAccount).set({ enabled: 0 }));
    const account = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: userId,
        workspaceId: workspace.id,
        agent: "claude",
        label: "Usage",
        now: NOW,
      }),
    );
    await db.transaction((q) =>
      saveProviderUsageSteps(
        q,
        account,
        [{ window: "5-hour", usedPercent: 100, resetsAt: NOW + 60000 }],
        NOW,
      ),
    );
    const place = (now: number) =>
      leaseCentralAccount(db, {
        workspaceId: workspace.id,
        agent: "claude",
        runnerId,
        runId: "usage-run",
        until: now + 1000,
        now,
      });
    proof.expect(
      "spent account pauses before reset",
      (await place(NOW).catch((e: unknown) => e)) instanceof UsageLimitPause,
    );
    await seed(db, (q) =>
      q.orm
        .update(q.t.agentAccount)
        .set({ extraUsage: 1 })
        .where(eq(q.t.agentAccount.id, account.id)),
    );
    proof.expect(
      "extra usage permits a spent account",
      (await place(NOW))?.accountId === account.id,
    );
    await seed(db, (q) =>
      q.orm
        .update(q.t.agentAccount)
        .set({ extraUsage: 0 })
        .where(eq(q.t.agentAccount.id, account.id)),
    );
    proof.expect(
      "reset makes the account available",
      (await place(NOW + 60000))?.accountId === account.id,
    );
    const binding = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        userId,
        workspaceId: workspace.id,
        accountId: account.id,
        runnerId,
        now: NOW + 60000,
      }),
    );
    await db.transaction((q) =>
      recordAccountObservationSteps(q, {
        bindingId: binding.id,
        source: "result",
        sourceId: "spent-run",
        observedAt: NOW + 60001,
        now: NOW + 60001,
        state: "exhausted",
        resetsAt: NOW + 120000,
      }),
    );
    await db.transaction((q) => saveProviderUsageSteps(q, account, [], NOW + 60002));
    await seed(db, (q) =>
      q.orm
        .update(q.t.runner)
        .set({ lastSeenAt: NOW + 60003 })
        .where(eq(q.t.runner.id, runnerId)),
    );
    const readiness = await db.run((q) =>
      bindingReadinessSteps(q, { bindingId: binding.id, now: NOW + 60003 }),
    );
    proof.expect(
      "provider poll preserves the runner cooldown",
      !readiness.ready && readiness.reason === "exhausted",
      readiness,
    );
  },
} satisfies Proof;
