import { claimNextJob, getWorkItem, listItemHolds, recordRunnerRepositories } from "../../src/db";
import { JOB_KIND } from "../../src/core";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: [
    "src/scheduler/scheduler.ts",
    "src/scheduler/waits.ts",
    "src/runner-placement/fit.ts",
    "src/runner-placement/eligible.ts",
    "src/db/runner-capacity.ts",
  ],
  summary:
    "Two items can start on the two-slot runner that allows their repository; the third remains queued with placement's refusal until another runner allows the repository.",
  agent: () => [],
  async run(proof) {
    const db = proof.database;
    const { pair, queue, pass } = workspaceWithRunners(db);
    const goldbox = pair("goldbox", 6, ["other/repo"]);
    pair("agentbox", 2, [REPOSITORY]);
    for (const id of ["a", "b", "c"]) queue(id);
    const admitted = pass();
    proof.expect("only two items are admitted", admitted.length === 2, admitted);
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
      listItemHolds(db)
        .find((hold) => hold.itemId === "c")
        ?.blockers[0]?.includes("goldbox: repository not allowed in the runner's host config") ===
        true,
    );
    proof.expect(
      "the third item remains queued",
      getWorkItem(db, "c")?.state === "queued",
      getWorkItem(db, "c")?.state,
    );
    // Use the same heartbeat repository writer as the real runner.
    recordRunnerRepositories(db, goldbox, [REPOSITORY], NOW + 1);
    proof.expect("newly allowed capacity admits the held item", pass().includes("c"));
  },
} satisfies Proof;
