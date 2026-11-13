import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import { applyWorkItemEvent, enqueueJob, insertQueuedItem, pinnedSlotsReserved } from "../src/db";
import { tempStore } from "./pglite";

const NOW = 1_000_000;

test("items admitted to one runner yield only to admissions ahead of them, so the first ones run", async () => {
  const { db, close } = await tempStore();
  try {
    const items = ["a", "b", "c", "d", "e"];
    for (const [index, id] of items.entries()) {
      await insertQueuedItem(db, { id, now: index });
      await applyWorkItemEvent(db, id, "dispatched");
      const jobId = await enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: id, admissionRunnerId: "A" },
        runAt: NOW,
        now: NOW,
      });
      await db.run((q) =>
        q.exec(
          q.orm.execute(
            sql`INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(${id},${jobId},'p','r','[]',0,${NOW})`,
          ),
        ),
      );
    }

    const reserved = await Promise.all(items.map((id) => pinnedSlotsReserved(db, "A", id, NOW)));
    expect(reserved).toEqual([0, 1, 2, 3, 4]);
    expect(await pinnedSlotsReserved(db, "A", "not-admitted", NOW)).toBe(5);
    expect(await pinnedSlotsReserved(db, "B", "a", NOW)).toBe(0);
  } finally {
    await close();
  }
});
