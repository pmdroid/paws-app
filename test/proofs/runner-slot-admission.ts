import {
  claimNextJob,
  getWorkItem,
  listItemHolds,
  recordRunnerRepositories,
  schedulerRunnerSlots,
  sqliteDb,
} from "../../src/db";
import { createRunnerPlacement, itemRunnerVerdictsSteps } from "../../src/runner-placement";
import { JOB_KIND } from "../../src/core";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: [
    "src/scheduler/scheduler.ts",
    "src/scheduler/waits.ts",
    "src/runner-placement/fit.ts",
    "src/runner-placement/placement.ts",
    "src/runner-placement/session.ts",
    "src/runner-placement/eligible.ts",
    "src/db/runner-capacity.ts",
  ],
  summary:
    "Two items can start on the two-slot runner that allows their repository; the third remains queued with placement's refusal until another runner allows the repository.",
  agent: () => [],
  async run(proof) {
    const db = proof.database;
    const { pair, queue, pass } = await workspaceWithRunners(db);
    await queue("stopped");
    db.run("UPDATE linear_session SET stopped_at=? WHERE session_id=?", [NOW, "session-stopped"]);
    proof.expect(
      "unavailable authority returns an item verdict without aborting admission",
      (await sqliteDb(db).run((q) =>
        itemRunnerVerdictsSteps(q, sqliteDb(db), { itemId: "stopped", agent: "claude", now: NOW }),
      )) === null,
    );
    const goldbox = await pair("goldbox", 6, ["other/repo"]);
    for (const id of ["a", "b", "c"]) await queue(id);
    proof.expect("a repository refused everywhere stays queued", (await pass()).length === 0);
    proof.expect(
      "no refused start can be claimed",
      claimNextJob(db, { now: NOW, queues: [JOB_KIND.start] }) === null,
    );
    const agentbox = await pair("agentbox", 2, [REPOSITORY]);
    const admitted = await pass();
    proof.expect("only two items are admitted", admitted.length === 2, admitted);
    proof.expect(
      "each admitted item reserves only the runner that accepts it",
      (await schedulerRunnerSlots(sqliteDb(db), NOW)).length === 2 &&
        (await schedulerRunnerSlots(sqliteDb(db), NOW)).every((slot) => slot.runnerId === agentbox),
    );
    const claims = Array.from({ length: 2 }, (_, i) =>
      claimNextJob(db, {
        workerId: `proof-${i}`,
        now: NOW,
        leaseMs: 60_000,
        queues: [JOB_KIND.start],
      }),
    );
    proof.expect(
      "only admitted starts can be claimed",
      claims.every(Boolean) && claimNextJob(db, { now: NOW, queues: [JOB_KIND.start] }) === null,
    );
    proof.expect(
      "the wait reason names the rejected host",
      (await listItemHolds(sqliteDb(db)))
        .find((hold) => hold.itemId === "c")
        ?.blockers[0]?.includes("goldbox: repository not allowed in the runner's host config") ===
        true,
    );
    proof.expect(
      "the third item remains queued",
      getWorkItem(db, "c")?.state === "queued",
      getWorkItem(db, "c")?.state,
    );
    await recordRunnerRepositories(sqliteDb(db), goldbox, [REPOSITORY], NOW + 1);
    proof.expect("newly allowed capacity admits the held item", (await pass()).includes("c"));
    proof.expect(
      "newly eligible runner owns the third admission",
      (await schedulerRunnerSlots(sqliteDb(db), NOW)).find((slot) => slot.itemId === "c")
        ?.runnerId === goldbox,
    );
    const spare = await pair("spare", 1, [REPOSITORY]);
    const alternatives = await createRunnerPlacement({
      store: sqliteDb(db),
      now: () => NOW,
    }).candidates({
      itemId: "c",
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude" },
      excludeRunnerIds: [goldbox],
    });
    proof.expect(
      "a failed admission host permits failover",
      alternatives.some((r) => r.id === spare) && !alternatives.some((r) => r.id === goldbox),
    );
    proof.expect(
      "failover replaces the unusable admission choice",
      (await schedulerRunnerSlots(sqliteDb(db), NOW)).find((slot) => slot.itemId === "c")
        ?.runnerId === spare,
    );
  },
} satisfies Proof;
