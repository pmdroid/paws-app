import { afterEach, expect, test } from "bun:test";
import { getWorkItem, listItemHolds, noRunnerOffersLine, type Db } from "../src/db";
import { createRunnerPlacement, itemRunnerVerdictsSteps } from "../src/runner-placement";
import { dispatch } from "../src/scheduler";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";
import { offerFixtureModels, seed } from "./pglite-fixtures";
import { workspaceWithRunners, NOW } from "./runner-slot-fixture";

const MODEL = "gpt-6.2-sol";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function fixture() {
  const store = await tempStore();
  close = store.close;
  const { db } = store;
  const runners = await workspaceWithRunners(db);
  return { db, ...runners };
}

const offer = (db: Db, runnerId: string, models: string[], at = NOW) =>
  offerFixtureModels(db, runnerId, "claude", models, at);

const request = {
  itemId: "item",
  profile: { agent: "claude" as const, model: MODEL },
  role: "implementer" as const,
  purpose: "work" as const,
};

test("a turn goes only to the runner whose catalog lists the selected model", async () => {
  const { db, pair, queue } = await fixture();
  const lagging = await pair("lagging", 2, null);
  const current = await pair("current", 2, null);
  const empty = await pair("empty", 2, null);
  await offer(db, lagging, ["gpt-6.1-sol"]);
  await offer(db, current, ["gpt-6.1-sol", MODEL]);
  await queue("item");
  const rejected: string[] = [];
  const offered = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
    ...request,
    onRejected: (id, reason) => rejected.push(`${id}: ${reason}`),
  });
  expect(offered.map((runner) => runner.id)).toEqual([current]);
  expect(rejected).toContain(`${lagging}: claude does not offer ${MODEL}`);
  expect(rejected).toContain(`${empty}: claude does not offer ${MODEL}`);
  const wide = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
    ...request,
    profile: { agent: "claude", model: `${MODEL}[1m]` },
  });
  expect(wide).toEqual([]);
});

test("with no runner offering the model the item waits queued, then starts once a catalog lists it", async () => {
  const { db, pair, queue } = await fixture();
  const runner = await pair("runner", 2, null);
  await offer(db, runner, ["gpt-6.1-sol"]);
  await queue("item");
  const pass = (now: number) =>
    dispatch(db, {
      now,
      admission: workspaceAdmission(db),
      itemRunners: (q, itemId) =>
        itemRunnerVerdictsSteps(q, db, { itemId, agent: "claude", model: MODEL, now }),
    });
  expect(await pass(NOW)).toEqual([]);
  expect(await listItemHolds(db)).toMatchObject([
    { itemId: "item", reason: "slot", blockers: [`No runner offers claude ${MODEL}`] },
  ]);
  expect((await getWorkItem(db, "item"))?.state).toBe("queued");
  await offer(db, runner, ["gpt-6.1-sol", MODEL], NOW + 1);
  expect(await pass(NOW + 1)).toEqual(["item"]);
  expect(await listItemHolds(db)).toEqual([]);
});

test("a turn whose agent does not advertise the model drops it from that runner's catalog", async () => {
  const { db, pair, queue, userId } = await fixture();
  const stale = await pair("stale", 2, null);
  const other = await pair("other", 2, null);
  await offer(db, stale, [MODEL]);
  await offer(db, other, [MODEL]);
  await queue("item");
  const placement = createRunnerPlacement({ store: db, now: () => NOW });
  await seed(db, (q) =>
    q.orm.insert(q.t.runnerExecutionUsage).values({
      commandId: "turn",
      runnerId: stale,
      ownerUserId: userId,
      itemId: "item",
      agent: "claude",
      model: MODEL,
      role: "implementer",
      purpose: "work",
      startedAt: NOW,
    }),
  );
  const finish = () =>
    db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: "turn",
        runnerId: stale,
        profile: request.profile,
        result: {
          executionId: "01M5GCQ27RE0YMKT767K0P3451",
          commandId: "turn",
          role: "implementer",
          stopReason: "error",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
          errorMessage: `Run failed during agent: Agent does not advertise model ${MODEL}.`,
        },
        finishedAt: NOW + 2_000,
      }),
    );
  expect(await finish()).toMatchObject({ retryable: false, modelMissing: MODEL });
  const offered = await placement.candidates(request);
  expect(offered.map((runner) => runner.id)).toEqual([other]);
  const pinned = await placement.candidates({ ...request, pinnedRunnerId: stale });
  expect(pinned.map((runner) => runner.id)).toEqual([other]);
  await offer(db, stale, [MODEL], NOW + 3_000);
  expect(await finish()).toMatchObject({ retryable: false, modelMissing: MODEL });
  const again = await placement.candidates(request);
  expect(again.map((runner) => runner.id).sort()).toEqual([other, stale].sort());
});

test("the model wait reason shows past an offline runner but not past an eligible one", () => {
  const line = (rejection: string | null) =>
    noRunnerOffersLine({
      repository: null,
      agent: "claude",
      model: MODEL,
      runners: [
        { hostConfig: null, id: "a", name: "a", rejection: `claude does not offer ${MODEL}` },
        { hostConfig: null, id: "b", name: "b", rejection },
      ],
    });
  expect(line("offline")).toBe(`No runner offers claude ${MODEL}`);
  expect(line(null)).toBeNull();
});
