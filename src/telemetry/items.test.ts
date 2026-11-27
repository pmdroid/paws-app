import { afterEach, expect, test } from "bun:test";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  applyWorkItemEvent,
  applyWorkItemEventSteps,
  getWorkItem,
  onCommittedTransition,
} from "../db";
import { insertWorkItem, seed, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import {
  DEFAULT_TELEMETRY_SETTINGS,
  createTelemetry,
  itemTransitionLogs,
  parseTelemetrySettings,
  type ExporterLoaders,
  type ExporterSet,
} from ".";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
});

async function setup(options: { failing?: boolean; settings?: unknown } = {}) {
  const store = await tempStore();
  cleanup.push(() => store.close());
  const logs = new InMemoryLogRecordExporter();
  if (options.failing)
    logs.export = () => {
      throw new Error("collector down");
    };
  const set = { logs: () => logs } as unknown as ExporterSet;
  const exporters = { "http/protobuf": async () => set } as ExporterLoaders;
  const telemetry = createTelemetry({
    version: "t",
    instanceId: "t",
    exporters,
    countFailure() {},
  });
  const on = { enabled: true, endpoint: "https://otel.example.com", metrics: { enabled: false } };
  await telemetry.apply(
    options.settings === "off"
      ? DEFAULT_TELEMETRY_SETTINGS
      : parseTelemetrySettings({ ...on, ...(options.settings as object) }),
    null,
  );
  cleanup.push(onCommittedTransition(itemTransitionLogs(telemetry)), () => telemetry.shutdown());
  const db = store.db;
  await withoutForeignKeys(db);
  await insertWorkItem(db, "PAS-1");
  await seed(
    db,
    (q) => q.orm.update(q.t.workItem).set({ currentRunId: "run-1" }),
    (q) =>
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: "PAS-1", owner: "acme", repo: "app", remoteUrl: "u" }),
    (q) =>
      q.orm.insert(q.t.runnerWork).values({
        ...{ runId: "run-1", runnerId: "runner-1", workspaceId: "ws", commandId: "c" },
        ...{ generation: 1, runnerFence: 0, leaseUntil: 0 },
      }),
  );
  const records = async () => {
    await telemetry.flush();
    return logs
      .getFinishedLogRecords()
      .map((r): Record<string, unknown> => ({ body: r.body, ...r.attributes }));
  };
  return { db, records };
}

const dispatched = {
  body: "paws.item.transition",
  "event.name": "paws.item.transition",
  "paws.issue": "PAS-1",
  "paws.item_id": "PAS-1",
  "paws.from": "queued",
  "paws.event": "dispatched",
  "paws.to": "running",
  "paws.version": 1,
  "paws.repository": "acme/app",
  "paws.runner_id": "runner-1",
};

test("a committed transition emits one record with identifiers only", async () => {
  const { db, records } = await setup();
  await applyWorkItemEvent(db, "PAS-1", "dispatched");
  expect(await records()).toEqual([dispatched]);
});

test("a rolled-back transaction or savepoint emits none", async () => {
  const { db, records } = await setup();
  await expect(
    db.transaction(function* (q) {
      yield* applyWorkItemEventSteps(q, "PAS-1", "dispatched");
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await db.transaction(function* (q) {
    try {
      yield* q.transaction(function* (inner) {
        yield* applyWorkItemEventSteps(inner, "PAS-1", "dispatched");
        throw new Error("savepoint");
      });
    } catch (error) {
      expect(String(error)).toContain("savepoint");
    }
  });
  expect((await getWorkItem(db, "PAS-1"))?.state).toBe("queued");
  expect(await records()).toEqual([]);
});

test("a failing exporter leaves the transition committed", async () => {
  const { db, records } = await setup({ failing: true });
  await applyWorkItemEvent(db, "PAS-1", "dispatched");
  expect(await records()).toEqual([]);
  expect((await getWorkItem(db, "PAS-1"))?.state).toBe("running");
});

test("export off, the items signal off or a narrower scope sends nothing for that transition", async () => {
  for (const settings of ["off", { items: { enabled: false } }, { items: { scope: "final" } }]) {
    const { db, records } = await setup({ settings });
    await applyWorkItemEvent(db, "PAS-1", "dispatched");
    expect(await records()).toEqual([]);
    for (const done of cleanup.splice(0).reverse()) await done();
  }
});

test("scopes pick their target states and the repository and runner can be left out", async () => {
  const { db, records } = await setup({
    settings: { items: { scope: "failures_and_questions", includeRepositoryAndRunner: false } },
  });
  await applyWorkItemEvent(db, "PAS-1", "dispatched");
  await applyWorkItemEvent(db, "PAS-1", "run_failed");
  const { "paws.repository": _, "paws.runner_id": __, ...rest } = dispatched;
  expect(await records()).toEqual([
    {
      ...rest,
      "paws.from": "running",
      "paws.event": "run_failed",
      "paws.to": "failed",
      "paws.version": 2,
    },
  ]);
});
