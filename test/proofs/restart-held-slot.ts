import { eq } from "drizzle-orm";
import { seed } from "../dialects";
import { getWorkItem, insertRun, schedulerRunnerSlots } from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: ["src/scheduler/scheduler.ts", "src/db/runner-capacity.ts"],
  summary: "A queued restart reuses its active run's held slot while unrelated work stays queued.",
  agent: () => [],
  async run(proof) {
    const db = proof.store;
    const { pair, queue, pass, workspace } = await workspaceWithRunners(db);
    const pinned = await pair("pinned", 1, [REPOSITORY]);
    await queue("a-unrelated");
    await queue("b-resume");
    const run = await insertRun(db, { itemId: "b-resume", now: NOW, status: "active" });
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ currentRunId: run.id })
          .where(eq(q.t.workItem.id, "b-resume")),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: pinned,
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: "ended",
          leaseUntil: NOW - 1,
          endedAt: NOW - 1,
          teardownConfirmedAt: NOW - 1,
        }),
    );
    const admitted = await pass();
    proof.expect(
      "only the restart is admitted",
      admitted.length === 1 && admitted[0] === "b-resume",
      admitted,
    );
    proof.expect(
      "unrelated work stays queued",
      (await getWorkItem(db, "a-unrelated"))?.state === "queued",
    );
    proof.expect(
      "the restart retains its runner",
      (await schedulerRunnerSlots(db, NOW)).find((row) => row.itemId === "b-resume")?.runnerId ===
        pinned,
    );
    const offered = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
      itemId: "b-resume",
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude" },
      pinnedRunnerId: pinned,
    });
    proof.expect(
      "placement accepts the restart on the held slot",
      offered.length === 1 && offered[0]?.id === pinned,
    );
  },
} satisfies Proof;
