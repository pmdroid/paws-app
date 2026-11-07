import { afterEach, expect, test } from "bun:test";
import {
  heartbeatInstanceSteps,
  jobInstanceElsewhereSteps,
  lastInstanceHeartbeatSteps,
  liveInstancesSteps,
  registerInstanceSteps,
  stopInstanceSteps,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("instances register, beat, stop and leave the live set", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    expect(await db.run(lastInstanceHeartbeatSteps)).toBeNull();
    const web = await db.run((q) =>
      registerInstanceSteps(q, { role: "web", host: "a", version: "1", now: 1_000, pid: 7 }),
    );
    const worker = await db.run((q) =>
      registerInstanceSteps(q, { role: "worker", host: "b", version: null, now: 2_000 }),
    );
    expect(worker).toMatchObject({ role: "worker", startedAt: 2_000, pid: null });
    expect(await db.run((q) => heartbeatInstanceSteps(q, web.id, 3_000))).toBe(true);
    expect(await db.run((q) => heartbeatInstanceSteps(q, "missing", 3_000))).toBe(false);
    expect(await db.run((q) => liveInstancesSteps(q, 3_000))).toEqual([
      { ...web, heartbeatAt: 3_000 },
      worker,
    ]);
    expect(await db.run((q) => jobInstanceElsewhereSteps(q, web.id, 3_000))).toBe(true);
    expect(await db.run((q) => jobInstanceElsewhereSteps(q, worker.id, 3_000))).toBe(false);

    await db.run((q) => stopInstanceSteps(q, worker.id, 4_000));
    expect(await db.run(lastInstanceHeartbeatSteps)).toBe(4_000);
    expect((await db.run((q) => liveInstancesSteps(q, 4_000))).map((row) => row.id)).toEqual([
      web.id,
    ]);
  });
});
