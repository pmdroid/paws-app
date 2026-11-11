import { getWorkItem, insertRun, schedulerRunnerSlots, sqliteDb } from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: ["src/scheduler/scheduler.ts", "src/db/runner-capacity.ts"],
  summary: "A queued restart reuses its active run's held slot while unrelated work stays queued.",
  agent: () => [],
  async run(proof) {
    const db = proof.database;
    const { pair, queue, pass, workspace } = workspaceWithRunners(db);
    const pinned = await pair("pinned", 1, [REPOSITORY]);
    queue("a-unrelated");
    queue("b-resume");
    const run = insertRun(db, { itemId: "b-resume", now: NOW, status: "active" });
    db.run("UPDATE work_item SET current_run_id=? WHERE id=?", [run.id, "b-resume"]);
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(?,?,?,1,0,'ended',?,?,?)",
      [run.id, pinned, workspace.id, NOW - 1, NOW - 1, NOW - 1],
    );
    const admitted = await pass();
    proof.expect(
      "only the restart is admitted",
      admitted.length === 1 && admitted[0] === "b-resume",
      admitted,
    );
    proof.expect("unrelated work stays queued", getWorkItem(db, "a-unrelated")?.state === "queued");
    proof.expect(
      "the restart retains its runner",
      schedulerRunnerSlots(db, NOW).find((row) => row.itemId === "b-resume")?.runnerId === pinned,
    );
    const offered = await createRunnerPlacement({ store: sqliteDb(db), now: () => NOW }).candidates(
      {
        itemId: "b-resume",
        role: "implementer",
        purpose: "work",
        profile: { agent: "claude" },
        pinnedRunnerId: pinned,
      },
    );
    proof.expect(
      "placement accepts the restart on the held slot",
      offered.length === 1 && offered[0]?.id === pinned,
    );
  },
} satisfies Proof;
