import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
} from "../db";
import { restartForPushConflict } from "./push-conflict";

function runningItem() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "pas-886", sessionKey: "ses", now: 1_000 });
  const { run } = beginImplementRun(db, item.id, 1_000);
  return { db, itemId: item.id, runId: run.id };
}

test("a candidate that conflicts with its moved branch restarts with reason conflict and no question", () => {
  const { db, itemId, runId } = runningItem();
  expect(getWorkItem(db, itemId)?.state).toBe("running");

  expect(
    restartForPushConflict(db, itemId, {
      branch: "paws/pas-886",
      files: ["src/a.ts", "src/b.ts"],
      now: 2_000,
    }),
  ).toBe(true);

  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(getRun(db, runId)?.status).toBe("ended");
  const resumes = listJobs(db).filter(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  );
  expect(resumes).toHaveLength(1);
  expect(resumes[0]!.payload).toMatchObject({ itemId, reason: "conflict" });
  const handoff = String((resumes[0]!.payload as { handoff: string }).handoff);
  expect(handoff).toContain("`paws/pas-886` moved on GitHub");
  expect(handoff).toContain("- `src/a.ts`\n- `src/b.ts`");
  expect(db.query("SELECT COUNT(*) AS count FROM question").get()).toEqual({ count: 0 });
});

test("an item that is no longer running is not restarted for a push conflict", () => {
  const { db, itemId } = runningItem();
  applyWorkItemEvent(db, itemId, "turn_ended");
  expect(
    restartForPushConflict(db, itemId, { branch: "paws/pas-886", files: ["a"], now: 2_000 }),
  ).toBe(false);
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
});
