import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import { enqueueJob, getJob, startLoops } from "./index";
import { tempStore } from "../../test/pglite";

test("a running job survives a 45-second pause of the process", async () => {
  const clock = new FakeClock(1_000);
  const { db, close } = await tempStore();
  const id = await enqueueJob(db, { queue: "work", now: clock.now() });
  const controller = new AbortController();
  let started = () => {};
  let release = () => {};
  const claimed = new Promise<void>((resolve) => (started = resolve));
  const loops = await startLoops({
    db,
    instanceId: "01JINSTANCEACME0000000000",
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
  for (let attempt = 0; attempt < 200 && (await getJob(db, id))?.status !== "done"; attempt++)
    await Bun.sleep(5);
  expect((await getJob(db, id))?.status).toBe("done");
  controller.abort();
  await loops.stop();
  await close();
});
