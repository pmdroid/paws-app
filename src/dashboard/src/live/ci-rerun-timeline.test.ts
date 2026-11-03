import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listWorkItemFacts,
  migrate,
  openDatabase,
  recordCiRerun,
} from "../../../db";
import { parseStatusSnapshot } from "../contract";
import { handleStatusRequest } from "../engine";
import { historyOf } from "./provider";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

test("the timeline shows the agent's CI re-run with its reason and run id", async () => {
  const db = openDatabase(":memory:");
  open.push(db);
  migrate(db);
  insertQueuedItem(db, { id: "item" });
  beginImplementRun(db, "item", 1);
  const reason = "shard 3 hit its 12-minute limit in a test this change does not touch";
  recordCiRerun(db, {
    itemId: "item",
    head: "d".repeat(40),
    runIds: [41474224082],
    reason,
    at: Date.now() + 1,
  });
  const record = getWorkItem(db, "item")!;
  const facts = new Map(listWorkItemFacts(db).map((fact) => [fact.itemId, fact]));
  const { timeline } = historyOf(db, record, facts, Date.now() + 2);
  expect(timeline?.at(-1)).toMatchObject({
    kind: "ci_rerun",
    from: "running",
    to: "running",
    reason,
    actor: "agent",
    runIds: [41474224082],
  });
  applyWorkItemEvent(db, "item", "turn_ended");
  const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
    db,
    env: {},
  });
  const body = parseStatusSnapshot(await response!.json());
  if (!body.ok) throw new Error(body.error);
  const item = body.snapshot.items.find((candidate) => candidate.id === "item");
  expect(item?.timeline?.find((entry) => entry.kind === "ci_rerun")?.runIds).toEqual([41474224082]);
});
