import { afterEach, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listWorkItemFacts,
  recordCiRerun,
} from "../../../db";
import { parseIssueListResponse } from "../contract";
import { handleStatusRequest } from "../engine";
import { historyOf } from "./provider";
import { tempStore } from "../../../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

test("the timeline shows the agent's CI re-run with its reason and run id", async () => {
  const { db, close } = await tempStore();
  open.push(close);
  await insertQueuedItem(db, { id: "item" });
  await beginImplementRun(db, "item", 1);
  const reason = "shard 3 hit its 12-minute limit in a test this change does not touch";
  await recordCiRerun(db, {
    itemId: "item",
    head: "d".repeat(40),
    runIds: [41474224082],
    reason,
    at: Date.now() + 1,
  });
  const record = (await getWorkItem(db, "item"))!;
  const facts = new Map((await listWorkItemFacts(db)).map((fact) => [fact.itemId, fact]));
  const { timeline } = await historyOf(db, record, facts, Date.now() + 2);
  expect(timeline?.at(-1)).toMatchObject({
    kind: "ci_rerun",
    from: "running",
    to: "running",
    reason,
    actor: "agent",
    runIds: [41474224082],
  });
  await applyWorkItemEvent(db, "item", "turn_ended");
  const response = await handleStatusRequest(new Request("http://127.0.0.1/api/issues"), {
    store: db,
    env: {},
  });
  const body = parseIssueListResponse(await response!.json());
  if (!body.ok) throw new Error(body.error);
  const item = body.response.issues.find((candidate) => candidate.id === "item");
  expect(item?.timeline?.find((entry) => entry.kind === "ci_rerun")?.runIds).toEqual([41474224082]);
});
