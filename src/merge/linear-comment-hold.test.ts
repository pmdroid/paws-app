import { expect, test } from "bun:test";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  migrate,
  openDatabase,
  settleLinearComments,
  sqliteDb,
} from "../db";
import { reviewHold } from "./orders";

const WAIT = { quietMs: 60_000, maxMs: 300_000 };

test("a queued Linear comment holds the merge until it is handed over or settled", async () => {
  const db = openDatabase(":memory:");
  const store = sqliteDb(db);
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  expect(await reviewHold(store, "eng-1", 10, WAIT)).toBeNull();
  db.run(
    `INSERT INTO linear_comment (comment_id, issue_id, body, created_at_ms, updated_at_ms,
       received_at, source, state, item_id, session_id, generation, authority)
     VALUES ('c-1', 'lin-item-eng-1', 'Hold on.', 2, 2, 2, 'webhook', 'queued', 'eng-1', 's-1', 0, 'person')`,
  );
  expect(await reviewHold(store, "eng-1", 10, WAIT)).toMatchObject({
    kind: "wait",
    reason: "review",
    message: "A comment on the Linear issue goes to the agent before this pull request merges.",
  });
  expect(db.query("SELECT count(*) AS n FROM job").get()).toEqual({ n: 0 });
  settleLinearComments(db, ["c-1"], { state: "ignored", reason: "superseded", now: 20 });
  expect(await reviewHold(store, "eng-1", 30, WAIT)).toBeNull();
  db.close();
});
