import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seed } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  recordAgentCloseout,
  type AgentCloseoutProgress,
  type Db,
} from "./index";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const attempt = {
  head: "abc",
  id: "test",
  kind: "command",
  command: "bun test",
  attempt: 1,
  maxAttempts: 3,
};

const finished = (durationMs: number): AgentCloseoutProgress => ({
  type: "finished",
  ...attempt,
  state: "passed",
  exitCode: 0,
  timedOut: false,
  durationMs,
  stdout: "",
  stderr: "",
  truncated: false,
});

async function itemWithTime(): Promise<{ db: Db; id: string; runId: string }> {
  const { db, close } = await tempStore();
  closers.push(close);
  const item = await insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: 1_000 });
  const { run } = await beginImplementRun(db, item.id, 1_000);
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ agentMs: 600_000, closeoutMs: 30_000, awakeMs: 630_000, implementMs: 600_000 })
      .where(eq(q.t.workItem.id, item.id)),
  );
  return { db, id: item.id, runId: run.id };
}

const times = async (db: Db, id: string) => {
  const { agentMs, closeoutMs, awakeMs, implementMs, fixMs } = (await getWorkItem(db, id))!;
  return { agentMs, closeoutMs, awakeMs, implementMs, fixMs };
};

test("a finished in-turn check moves its duration from agent time to Closeout time", async () => {
  const { db, id, runId } = await itemWithTime();
  await recordAgentCloseout(db, runId, id, finished(120_000), 2_000);
  expect(await times(db, id)).toEqual({
    agentMs: 480_000,
    closeoutMs: 150_000,
    awakeMs: 630_000,
    implementMs: 600_000,
    fixMs: 0,
  });
});

test("a check longer than the remaining agent time moves only what is left", async () => {
  const { db, id, runId } = await itemWithTime();
  await recordAgentCloseout(db, runId, id, finished(900_000), 2_000);
  expect(await times(db, id)).toMatchObject({ agentMs: 0, closeoutMs: 630_000, awakeMs: 630_000 });
  await recordAgentCloseout(db, runId, id, finished(60_000), 3_000);
  expect(await times(db, id)).toMatchObject({ agentMs: 0, closeoutMs: 630_000 });
});

test("started and report events change no time column", async () => {
  const { db, id, runId } = await itemWithTime();
  const before = await times(db, id);
  await recordAgentCloseout(db, runId, id, { type: "started", ...attempt }, 2_000);
  await recordAgentCloseout(
    db,
    runId,
    id,
    { type: "report", head: "abc", maxAttempts: 3, checks: [], blocked: null },
    3_000,
  );
  expect(await times(db, id)).toEqual(before);
});
