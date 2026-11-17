import { bindingReadinessSteps } from "../../src/runner-placement";
import { eq } from "drizzle-orm";
import {
  bindAgentAccountSteps,
  recordAccountObservationSteps,
  createAgentAccountSteps,
  saveProviderUsageSteps,
} from "../../src/db";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import { seed, seedCredential } from "../pglite-fixtures";
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
    await seedCredential(db, account.id, "claude", NOW);
    const binding = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        userId,
        workspaceId: workspace.id,
        accountId: account.id,
        runnerId,
        now: NOW,
      }),
    );
    const ready = async (bindingId: string, now: number) => {
      await seed(db, (q) =>
        q.orm.update(q.t.runner).set({ lastSeenAt: now }).where(eq(q.t.runner.id, runnerId)),
      );
      return db.run((q) => bindingReadinessSteps(q, { bindingId, now }));
    };
    await db.transaction((q) =>
      saveProviderUsageSteps(
        q,
        account,
        [{ window: "5-hour", usedPercent: 100, resetsAt: NOW + 60000 }],
        NOW,
      ),
    );
    const paused = await ready(binding.id, NOW + 1);
    proof.expect(
      "spent account pauses before reset",
      !paused.ready && paused.reason === "exhausted",
      paused,
    );
    proof.expect(
      "reset makes the account available",
      (await ready(binding.id, NOW + 120000)).ready,
    );
    const extra = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: userId,
        workspaceId: workspace.id,
        agent: "claude",
        label: "Extra",
        now: NOW,
      }),
    );
    await seedCredential(db, extra.id, "claude", NOW);
    const extraBinding = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        userId,
        workspaceId: workspace.id,
        accountId: extra.id,
        runnerId,
        now: NOW,
      }),
    );
    await db.transaction((q) =>
      saveProviderUsageSteps(
        q,
        { ...extra, extraUsage: true },
        [{ window: "5-hour", usedPercent: 100, resetsAt: NOW + 60000 }],
        NOW,
      ),
    );
    proof.expect(
      "extra usage permits a spent account",
      (await ready(extraBinding.id, NOW + 1)).ready,
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
    const readiness = await ready(binding.id, NOW + 60003);
    proof.expect(
      "provider poll preserves the runner cooldown",
      !readiness.ready && readiness.reason === "exhausted",
      readiness,
    );
    const spent = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: userId,
        workspaceId: workspace.id,
        agent: "claude",
        label: "Spent",
        now: NOW + 60004,
      }),
    );
    await seedCredential(db, spent.id, "claude", NOW + 60004);
    const spentBinding = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        userId,
        workspaceId: workspace.id,
        accountId: spent.id,
        runnerId,
        now: NOW + 60004,
      }),
    );
    await db.transaction((q) =>
      saveProviderUsageSteps(
        q,
        spent,
        [{ window: "Weekly", usedPercent: 100, resetsAt: NOW + 600000 }],
        NOW + 60005,
      ),
    );
    const placed = await ready(spentBinding.id, NOW + 60005);
    proof.expect(
      "a spent provider reading keeps placement off the account until reset",
      !placed.ready && placed.reason === "exhausted",
      placed,
    );
  },
} satisfies Proof;
