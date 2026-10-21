import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import { enqueueJob, getJob, migrate, openDatabase, startLoops } from "./index";

test("a running job survives a 45-second pause of the process", async () => {
  const clock = new FakeClock(1_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const id = enqueueJob(db, { queue: "work", now: clock.now() });
  const controller = new AbortController();
  let started = () => {};
  let release = () => {};
  const claimed = new Promise<void>((resolve) => (started = resolve));
  const loops = startLoops({
    db,
    signal: controller.signal,
    clock,
    prepare({ jobs }) {
      jobs.register("work", async () => {
        started();
        await new Promise<void>((resume) => (release = resume));
      });
    },
  });
  await claimed;
  clock.advance(45_000);
  release();
  for (let attempt = 0; attempt < 200 && getJob(db, id)?.status !== "done"; attempt++)
    await Bun.sleep(5);
  expect(getJob(db, id)?.status).toBe("done");
  controller.abort();
  await loops.stop();
  db.close();
});
