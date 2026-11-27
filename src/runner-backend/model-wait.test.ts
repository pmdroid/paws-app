import { afterEach, expect, test } from "bun:test";
import { createRunnerPlacement } from "../runner-placement";
import { tempStore } from "../../test/pglite";
import { offerFixtureModels } from "../../test/pglite-fixtures";
import { workspaceWithRunners, NOW } from "../../test/runner-slot-fixture";
import { modelMissWait } from "./model-wait";

const MODEL = "gpt-6.2-sol";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function waitAfterMiss(otherOffers: boolean) {
  const store = await tempStore();
  close = store.close;
  const { pair, queue } = await workspaceWithRunners(store.db);
  const stale = await pair("stale", 2, null);
  const other = await pair("other", 2, null);
  await offerFixtureModels(store.db, stale, "claude", ["gpt-6.1-sol"], NOW);
  await offerFixtureModels(store.db, other, "claude", otherOffers ? [MODEL] : [], NOW);
  await queue("item");
  const rejected: string[] = [];
  const offered = await createRunnerPlacement({ store: store.db, now: () => NOW }).candidates({
    itemId: "item",
    profile: { agent: "claude", model: MODEL },
    role: "implementer",
    purpose: "work",
    pinnedRunnerId: stale,
    onRejected: (id, reason) => rejected.push(`${id}: ${reason}`),
  });
  return {
    other,
    wait: modelMissWait(
      rejected,
      offered.map((runner) => runner.id),
      `stale: the agent no longer offers ${MODEL}`,
    ),
  };
}

test("after a model miss, a runner that still offers the model gets a normal slot wait", async () => {
  const { other, wait } = await waitAfterMiss(true);
  expect(wait.runnerIds).toEqual([other]);
  expect(wait.modelWait).toBe(false);
});

test("after a model miss with no runner offering the model, the wait is a model wait", async () => {
  const { wait } = await waitAfterMiss(false);
  expect(wait.runnerIds).toEqual([]);
  expect(wait.modelWait).toBe(true);
});

test("a busy runner named in a rejection counts as a slot wait", () => {
  const wait = modelMissWait(["b: no free capacity (work 1 of 1)"], [], "a: gone");
  expect(wait.runnerIds).toEqual(["b"]);
  expect(wait.modelWait).toBe(false);
});
