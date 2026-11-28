import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pawsPaths } from "../src/config";
import { openPawsStore, setSyncCursorSteps, syncCursorSteps, type Db } from "../src/db";
import { tempHome } from "./helpers";
import { pgliteServer } from "./pglite";

async function roundTrip(store: Db, name: string) {
  await store.run((q) => setSyncCursorSteps(q, name, 42));
  return store.run((q) => syncCursorSteps(q, name));
}

describe("openPawsStore", () => {
  test("without a url opens PGlite in pglite/, migrated, and keeps its rows across opens", async () => {
    const paths = pawsPaths(tempHome());
    const legacy = join(paths.home, "paws.db");
    const legacyBytes = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff, 0x01]);
    writeFileSync(legacy, legacyBytes);
    const first = await openPawsStore({
      url: null,
      pgliteDir: paths.pgliteDir,
    });
    try {
      expect(await roundTrip(first.store, "kept")).toBe(42);
    } finally {
      await first.close();
    }
    expect(paths.pgliteDir).toBe(join(paths.home, "pglite"));
    expect(existsSync(join(paths.pgliteDir, "PG_VERSION"))).toBe(true);
    expect(readFileSync(legacy).equals(legacyBytes)).toBe(true);
    const second = await openPawsStore({
      url: null,
      pgliteDir: paths.pgliteDir,
    });
    try {
      expect(await second.store.run((q) => syncCursorSteps(q, "kept"))).toBe(42);
    } finally {
      await second.close();
    }
  }, 30_000);

  test("with a url migrates the Postgres there and runs on it", async () => {
    const server = await pgliteServer();
    try {
      const { store, close } = await openPawsStore({
        url: server.url,
        pgliteDir: join(tempHome(), "unused"),
      });
      try {
        expect(await roundTrip(store, "server")).toBe(42);
      } finally {
        await close();
      }
      expect(await server.store.run((q) => syncCursorSteps(q, "server"))).toBe(42);
    } finally {
      await server.close();
    }
  });

  test("with a url it can't reach it rejects", async () => {
    await expect(
      openPawsStore({
        url: "postgres://paws@127.0.0.1:1/paws",
        pgliteDir: tempHome(),
      }),
    ).rejects.toThrow();
  });
});
