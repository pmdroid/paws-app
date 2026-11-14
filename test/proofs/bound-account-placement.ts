import { eq } from "drizzle-orm";
import { seed } from "../dialects";
import { recordAccountObservation, listAgentBindings } from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: ["src/runner-placement/**"],
  summary:
    "Work uses a healthy bound account without runner-local sign-in and waits when that account expires.",
  agent: () => [],
  async run(proof) {
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
    proof.expect(
      "healthy binding places work without local sign-in",
      (await placement.candidates(request)).some((r) => r.id === runnerId),
    );
    const binding = (await listAgentBindings(db, workspace.id)).find(
      (b) => b.runnerId === runnerId && !b.legacy,
    )!;
    let observedAt = NOW;
    for (const state of ["exhausted", "restricted"] as const) {
      const until = NOW + 60_000;
      await recordAccountObservation(db, {
        bindingId: binding.id,
        ...(state === "exhausted" ? { state, resetsAt: until } : { state }),
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
    await recordAccountObservation(db, {
      bindingId: binding.id,
      state: "auth_required",
      source: "result",
      sourceId: "expired",
      observedAt: NOW,
      now: NOW,
    });
    proof.expect(
      "expired bound account blocks placement",
      (await placement.candidates(request)).length === 0,
    );
    proof.expect(
      "expired account needs setup",
      (await placement.setupNeed!(request))?.reason === "agent-not-signed-in",
    );
  },
} satisfies Proof;
