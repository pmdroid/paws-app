import { afterEach, expect, test } from "bun:test";
import { INSTANCE_DEAD_MS, ownerGoneSteps } from "../src/db";
import { forEachDialect, seed, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("an owner is gone once it stopped, missed its heartbeat or its process on this host exited", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    const now = 1_800_000_000_000;
    const row = (
      id: string,
      host: string,
      extra: { pid?: number; stoppedAt?: number; heartbeatAt?: number } = {},
    ) => ({
      id,
      role: "all",
      host,
      startedAt: 0,
      heartbeatAt: now,
      ...extra,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.instance)
        .values([
          row("self", "here", { pid: process.pid }),
          row("remote", "there", { pid: 2 ** 22 + 1 }),
          row("stopped", "there", { stoppedAt: now }),
          row("silent", "there", { heartbeatAt: now - INSTANCE_DEAD_MS }),
          row("exited", "here", { pid: 2 ** 22 + 1 }),
          row("unknown-pid", "here"),
        ]),
    );
    const gone = await db.run((q) => ownerGoneSteps(q, "self", now));
    expect(
      ["self", "remote", "stopped", "silent", "exited", "unknown-pid", "never-seen"].filter(gone),
    ).toEqual(["stopped", "silent", "exited", "never-seen"]);
  });
});
