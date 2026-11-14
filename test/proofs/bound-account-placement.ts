import { eq } from "drizzle-orm";
import { seed } from "../dialects";
import { recordAccountObservation, listAgentBindings } from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: ["src/runner-placement/**", "src/db/agent-accounts.ts"],
  summary: "Bound accounts place work and recover from temporary health failures.",
  agent: () => [],
  async run(proof) {
    const resumed = Bun.spawnSync(
      [process.execPath, "test", "test/runner-setup-hold.test.ts", "-t", "re-enabling an account"],
      { stdout: "pipe", stderr: "pipe" },
    );
    proof.expect(
      "re-enabled account resumes held work",
      resumed.exitCode === 0,
      resumed.stderr.toString(),
    );
    const db = proof.store;
    const { pair, queue, workspace } = await workspaceWithRunners(db);
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
    const binding = (await listAgentBindings(db, workspace.id)).find(
      (b) => b.runnerId === runnerId && !b.legacy,
    )!;
    let observedAt = NOW;
    for (const state of ["exhausted", "restricted"] as const) {
      await recordAccountObservation(db, {
        bindingId: binding.id,
        ...(state === "exhausted" ? { state, resetsAt: NOW + 60_000 } : { state }),
        source: "result",
        sourceId: state,
        observedAt: ++observedAt,
        now: NOW,
      });
      const refused: number[] = [];
      await placement.candidates({
        ...request,
        onRejected: (_id, _reason, retry) => {
          if (retry) refused.push(retry);
        },
      });
      proof.expect(
        state + " keeps retry time without setup",
        refused.length > 0 && (await placement.setupNeed!(request)) === null,
      );
      await recordAccountObservation(db, {
        bindingId: binding.id,
        state: "ok",
        clears: ["quota", "provider"],
        source: "sign_in",
        sourceId: state + "-clear",
        observedAt: ++observedAt,
        now: NOW,
      });
      proof.expect(
        state + " recovers automatically",
        (await placement.candidates(request)).length === 1,
      );
    }
  },
} satisfies Proof;
