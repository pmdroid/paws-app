import {
  applyWorkItemEvent,
  enqueueJob,
  getJob,
  insertRun,
  recordRunnerRepositories,
  slotWaitRunners,
  runnerSlotFree,
  sqliteDb,
  type RunnerCapacityWaitState,
} from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { JOB_KIND } from "../../src/core";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";

export default {
  covers: ["src/db/runner-capacity.ts", "src/db/runner-repositories.ts"],
  summary:
    "Previously placed work can retry on a runner that newly allows its repository while its old runner is offline and its alternative is full.",
  agent: () => [],
  async run(proof) {
    const db = proof.database;
    const { pair, queue, workspace } = await workspaceWithRunners(db);
    const previous = await pair("previous", 1, [REPOSITORY]);
    const full = await pair("full", 1, [REPOSITORY]);
    const newly = await pair("newly", 1, ["other/repo"]);
    await queue("busy");
    const busy = insertRun(db, { itemId: "busy", now: NOW, status: "active" });
    await queue("parked");
    applyWorkItemEvent(db, "parked", "dispatched");
    const run = insertRun(db, { itemId: "parked", now: NOW, status: "active" });
    db.run("UPDATE work_item SET current_run_id=? WHERE id='parked'", [run.id]);
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,'busy',?)",
      [busy.id, full, workspace.id, NOW + 3600000],
    );
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(?,?,?,1,0,'old',?,?,?)",
      [run.id, previous, workspace.id, NOW - 1, NOW - 1, NOW - 1],
    );
    db.run("UPDATE runner SET status='paused' WHERE id=?", [previous]);
    const jobId = enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: {
        itemId: "parked",
        capacityWait: { since: NOW, attempt: 1, runnerIds: [full], online: [full, newly] },
      },
      now: NOW + 60000,
    });
    const wait = () =>
      (getJob(db, jobId)!.payload as { capacityWait: RunnerCapacityWaitState }).capacityWait;
    proof.expect(
      "placed work initially has no free retry runner",
      !(await runnerSlotFree(
        sqliteDb(db),
        await slotWaitRunners(sqliteDb(db), run.id, wait(), NOW),
        NOW,
        run.id,
      )),
    );
    await recordRunnerRepositories(sqliteDb(db), newly, [REPOSITORY], NOW + 1);
    proof.expect("eligibility wakes the parked job", getJob(db, jobId)!.runAt === NOW + 1);
    proof.expect(
      "the placed-run retry filter now includes free capacity",
      await runnerSlotFree(
        sqliteDb(db),
        await slotWaitRunners(sqliteDb(db), run.id, wait(), NOW + 1),
        NOW + 1,
        run.id,
      ),
    );
    const offered = await createRunnerPlacement({
      store: sqliteDb(db),
      now: () => NOW + 1,
    }).candidates({
      itemId: "parked",
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude" },
      pinnedRunnerId: previous,
    });
    proof.expect(
      "placement offers the newly eligible runner",
      offered.some((r) => r.id === newly),
    );
  },
} satisfies Proof;
