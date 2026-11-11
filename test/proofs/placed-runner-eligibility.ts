import { eq } from "drizzle-orm";
import { seed } from "../dialects";
import {
  applyWorkItemEvent,
  enqueueJob,
  getJob,
  insertRun,
  recordRunnerRepositories,
  slotWaitRunners,
  runnerSlotFree,
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
    const db = proof.store;
    const { pair, queue, workspace } = await workspaceWithRunners(db);
    const previous = await pair("previous", 1, [REPOSITORY]);
    const full = await pair("full", 1, [REPOSITORY]);
    const newly = await pair("newly", 1, ["other/repo"]);
    await queue("busy");
    const busy = await insertRun(db, { itemId: "busy", now: NOW, status: "active" });
    await queue("parked");
    await applyWorkItemEvent(db, "parked", "dispatched");
    const run = await insertRun(db, { itemId: "parked", now: NOW, status: "active" });
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ currentRunId: run.id })
          .where(eq(q.t.workItem.id, "parked")),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: busy.id,
          runnerId: full,
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: "busy",
          leaseUntil: NOW + 3600000,
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: previous,
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: "old",
          leaseUntil: NOW - 1,
          endedAt: NOW - 1,
          teardownConfirmedAt: NOW - 1,
        }),
      (q) => q.orm.update(q.t.runner).set({ status: "paused" }).where(eq(q.t.runner.id, previous)),
    );
    const jobId = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: {
        itemId: "parked",
        capacityWait: { since: NOW, attempt: 1, runnerIds: [full], online: [full, newly] },
      },
      now: NOW + 60000,
    });
    const wait = async () =>
      ((await getJob(db, jobId))!.payload as { capacityWait: RunnerCapacityWaitState })
        .capacityWait;
    proof.expect(
      "placed work initially has no free retry runner",
      !(await runnerSlotFree(
        db,
        await slotWaitRunners(db, run.id, await wait(), NOW),
        NOW,
        run.id,
      )),
    );
    await recordRunnerRepositories(db, newly, [REPOSITORY], NOW + 1);
    proof.expect("eligibility wakes the parked job", (await getJob(db, jobId))!.runAt === NOW + 1);
    proof.expect(
      "the placed-run retry filter now includes free capacity",
      await runnerSlotFree(
        db,
        await slotWaitRunners(db, run.id, await wait(), NOW + 1),
        NOW + 1,
        run.id,
      ),
    );
    const offered = await createRunnerPlacement({
      store: db,
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
