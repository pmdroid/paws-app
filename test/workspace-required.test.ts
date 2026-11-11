import { and, eq, gt } from "drizzle-orm";
import { expect, test } from "bun:test";
import { insertQueuedItem, setJournalSink } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome, withHomeStore } from "./helpers";

test("startup without a Linear workspace says why and admits nothing", async () => {
  const home = tempHome();
  await withHomeStore(home, (store) => insertQueuedItem(store, { id: "waiting", now: Date.now() }));
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const paws = await startPaws({
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
  });
  try {
    const ticked = async () =>
      (
        await paws.store.run((q) =>
          q.all(
            q.orm
              .select({ id: q.t.job.id })
              .from(q.t.job)
              .where(
                and(eq(q.t.job.queue, "scheduler.tick"), gt(q.t.job.runAt, q.t.job.createdAt)),
              ),
          ),
        )
      ).length > 0;
    for (let waited = 0; !(await ticked()) && waited < 2_000; waited += 25) await Bun.sleep(25);
    expect(await ticked()).toBe(true);
    expect(
      await paws.store.run((q) =>
        q.all(
          q.orm
            .select({ itemId: q.t.schedulerAdmission.itemId })
            .from(q.t.schedulerAdmission)
            .where(eq(q.t.schedulerAdmission.itemId, "waiting")),
        ),
      ),
    ).toEqual([]);
    expect(lines.join("\n")).toContain("Linear workspace");
  } finally {
    await paws.stop();
    restore();
  }
});
