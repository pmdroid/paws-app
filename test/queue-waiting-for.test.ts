import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock } from "../src/core";
import { createLiveStatusProvider } from "../src/dashboard/src/live/provider";
import {
  JobLoop,
  OutboxDispatcher,
  bindingAccountHealth,
  listAgentBindings,
  listOutbox,
  recordAccountObservation,
  type Db,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { itemRunnerVerdictsSteps } from "../src/runner-placement";
import { tempHome } from "./helpers";
import { seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";
import { NOW, workspaceWithRunners } from "./runner-slot-fixture";
import { workspaceAdmission } from "./fake-workspace";

const RESETS = Date.UTC(2027, 0, 15, 21, 30);

function orchestrator(db: Db, clock: FakeClock) {
  return new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
    itemRunners: (q, itemId, profile, now) =>
      itemRunnerVerdictsSteps(q, db, { itemId, ...profile, now }),
  });
}

async function thoughts(db: Db, itemId: string): Promise<string[]> {
  return (await listOutbox(db))
    .map((row) => row.payload as { kind?: string; body?: string; sessionId?: string })
    .filter((payload) => payload.kind === "thought" && payload.sessionId === `session-${itemId}`)
    .map((payload) => payload.body ?? "");
}

async function fixture(db: Db) {
  const setup = await workspaceWithRunners(db);
  const runner = await setup.pair("solo", 1, null);
  for (const [id, identifier] of [
    ["first", "PAS-1"],
    ["second", "PAS-2"],
  ] as const) {
    await setup.queue(id);
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ linearIdentifier: identifier, position: id === "first" ? 1 : 2 })
        .where(eq(q.t.workItem.id, id)),
    );
  }
  return { ...setup, runner };
}

async function coolDown(db: Db, workspace: string, runnerId: string) {
  const binding = (await listAgentBindings(db, workspace)).find((b) => b.runnerId === runnerId)!;
  await recordAccountObservation(db, {
    bindingId: binding.id,
    source: "result",
    sourceId: "quota",
    observedAt: NOW,
    now: NOW,
    state: "exhausted",
    resetsAt: RESETS,
  });
  return (await bindingAccountHealth(db, binding.id)).find((row) => row.state === "exhausted")!
    .nextCheckAt!;
}

test("a busy-slots hold posts the slot line", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(NOW);
  const paws = orchestrator(db, clock);
  try {
    await fixture(db);
    await paws.reconcileExecution();
    expect(await thoughts(db, "second")).toEqual([
      "Queued, 1st in line. 1 of 1 runner slot is busy. Paws starts PAS-2 when a slot frees.",
    ]);
    expect((await createLiveStatusProvider(db).issue("PAS-2"))?.issue.queue?.waitingFor).toEqual({
      kind: "slots",
      text: "Queued, 1st in line. 1 of 1 runner slot is busy.",
    });
  } finally {
    await paws.shutdown();
    await close();
  }
});

test("a quota-cooldown hold names the account and its reset time once, in the thought and the API", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(NOW);
  const paws = orchestrator(db, clock);
  try {
    const { workspace, runner } = await fixture(db);
    const until = await coolDown(db, workspace.id, runner);
    const accountId = (await listAgentBindings(db, workspace.id)).find(
      (b) => b.runnerId === runner,
    )!.accountId;
    const account = await db.run((q) =>
      q.one(
        q.orm
          .select({ label: q.t.agentAccount.label })
          .from(q.t.agentAccount)
          .where(eq(q.t.agentAccount.id, accountId)),
      ),
    );
    await paws.reconcileExecution();
    await paws.reconcileExecution();
    const time = `${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const text = `Waiting for an agent account's quota: ${account!.label} resets at ${time}`;
    for (const id of ["first", "second"]) {
      const posted = await thoughts(db, id);
      expect(posted).toEqual([
        `Queued. ${text}. Paws starts PAS-${id === "first" ? 1 : 2} once a runner can take it.`,
      ]);
      expect(posted.join("")).not.toContain("slot");
    }
    expect((await createLiveStatusProvider(db).issue("PAS-1"))?.issue.queue?.waitingFor).toEqual({
      kind: "quota",
      text,
      until,
    });
  } finally {
    await paws.shutdown();
    await close();
  }
});
