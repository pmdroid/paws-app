import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  consumeBrowserInstallationSteps,
  readCredentialCiphertextSteps,
  readSettingSteps,
  resolveDashboardAliasSteps,
  saveBrowserInstallationSteps,
  updateSettingSteps,
  writeCredentialCiphertextSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  return handle.db;
}

forEachDialect((open) => {
  test("credentials are written, replaced or kept", async () => {
    const db = await connect(open);
    const key = { kind: "linear" as const, workspace: "org" };
    expect(await db.run((q) => readCredentialCiphertextSteps(q, key))).toBeNull();
    expect(await db.run((q) => writeCredentialCiphertextSteps(q, key, "one", { now: 1 }))).toBe(
      true,
    );
    expect(
      await db.run((q) =>
        writeCredentialCiphertextSteps(q, key, "two", { now: 2, onlyIfMissing: true }),
      ),
    ).toBe(false);
    expect(await db.run((q) => readCredentialCiphertextSteps(q, key))).toBe("one");
    expect(await db.run((q) => writeCredentialCiphertextSteps(q, key, "three", { now: 3 }))).toBe(
      true,
    );
    expect(await db.run((q) => readCredentialCiphertextSteps(q, key))).toBe("three");
  });

  test("settings change from their stored value", async () => {
    const db = await connect(open);
    expect(await db.run((q) => readSettingSteps(q, "k"))).toBeNull();
    const seen: (string | null)[] = [];
    const append = (stored: string | null) => {
      seen.push(stored);
      return `${stored ?? ""}x`;
    };
    await db.transaction((q) => updateSettingSteps(q, "k", append, 1));
    await db.transaction((q) => updateSettingSteps(q, "k", append, 2));
    expect(seen).toEqual([null, "x"]);
    expect(await db.run((q) => readSettingSteps(q, "k"))).toBe("xx");
  });

  test("browser installations are consumed once and expire", async () => {
    const db = await connect(open);
    const request = { stateHash: "s", browserHash: "b", identity: "id", expiresAt: 100 };
    await db.run((q) => saveBrowserInstallationSteps(q, request));
    await db.run((q) =>
      saveBrowserInstallationSteps(q, { ...request, stateHash: "late", expiresAt: 700_100 }),
    );
    expect(await db.run((q) => consumeBrowserInstallationSteps(q, "s", "b", 0))).toBeNull();
    await db.run((q) =>
      saveBrowserInstallationSteps(q, { ...request, stateHash: "s2", expiresAt: 700_200 }),
    );
    expect(await db.run((q) => consumeBrowserInstallationSteps(q, "s2", "other", 0))).toBeNull();
    expect(await db.run((q) => consumeBrowserInstallationSteps(q, "s2", "b", 700_300))).toBeNull();
    expect(await db.run((q) => consumeBrowserInstallationSteps(q, "late", "b", 0))).toBe("id");
    expect(await db.run((q) => consumeBrowserInstallationSteps(q, "late", "b", 0))).toBeNull();
  });

  test("dashboard aliases resolve to visible items' public ids", async () => {
    const db = await connect(open);
    await db.run(function* (q) {
      const { run, workItem } = q.t;
      for (const [id, identifier, session, at] of [
        ["i1", " PAS-1 ", "mine", 2],
        ["i2", "", "mine", 1],
        ["i3", "PAS-3", "other", 0],
      ] as const) {
        yield* insertWorkItemSteps(q, id, at);
        yield* q.exec(
          q.orm
            .update(workItem)
            .set({ linearIdentifier: identifier, sessionKey: session })
            .where(eq(workItem.id, id)),
        );
      }
      yield* q.exec(
        q.orm.insert(run).values(
          ["i1", "i3"].map((itemId) => ({
            id: `run-${itemId}`,
            itemId,
            kind: "implement",
            agent: "cursor",
            status: "ended",
            createdAt: 0,
            updatedAt: 0,
          })),
        ),
      );
    });
    const alias = (kind: "runs" | "sessions" | "verdicts", id: string, scope?: string[]) =>
      db.run((q) => resolveDashboardAliasSteps(q, kind, id, scope));
    expect(await alias("runs", "run-i1")).toBe("PAS-1");
    expect(await alias("runs", "run-i3", ["mine"])).toBeNull();
    expect(await alias("sessions", "mine")).toBe("i2");
    expect(await alias("sessions", "mine", [])).toBeNull();
    expect(await alias("verdicts", "PAS-3")).toBe("PAS-3");
    expect(await alias("verdicts", "PAS-3", ["mine"])).toBeNull();
    expect(await alias("verdicts", "run-i1", ["mine"])).toBe("PAS-1");
  });
});
