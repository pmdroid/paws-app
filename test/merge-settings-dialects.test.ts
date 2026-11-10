import { describe, expect, test } from "bun:test";
import { MAIN_MOVED } from "../src/config";
import { getTaskMergeSettingsSteps, keepTaskMergeSettingsSteps } from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";
import { tempDb } from "./helpers";
import { pgliteDb } from "./pglite";

forEachDialect((open) => {
  test("a task keeps the merge settings it resolved first", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => getTaskMergeSettingsSteps(q, "item"))).toBeNull();
      const first = { order: "queue", mainMoved: "ci", resolved: { order: "default" } } as const;
      await db.run((q) => keepTaskMergeSettingsSteps(q, "item", first, 10));
      await db.run((q) =>
        keepTaskMergeSettingsSteps(q, "item", { ...first, order: "ci-green", resolved: {} }, 20),
      );
      expect(await db.run((q) => getTaskMergeSettingsSteps(q, "item"))).toEqual(first);
    } finally {
      await close();
    }
  });

  for (const mainMoved of MAIN_MOVED)
    test(`a task can start with main_moved = "${mainMoved}"`, async () => {
      const { db, close } = await open();
      try {
        await insertWorkItem(db, "item");
        const settings = { order: "queue", mainMoved, resolved: {} } as const;
        await db.run((q) => keepTaskMergeSettingsSteps(q, "item", settings, 10));
        expect(await db.run((q) => getTaskMergeSettingsSteps(q, "item"))).toEqual(settings);
      } finally {
        await close();
      }
    });
});

function quotedValues(definition: string): string[] {
  return [...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
}

describe("work_item_merge_settings_check_2", () => {
  const expected = [...MAIN_MOVED].sort();

  test("lists the MAIN_MOVED values on SQLite", () => {
    const db = tempDb();
    try {
      const table = db
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'work_item_merge_settings'",
        )
        .get()!;
      const definition = /CHECK\s*\(main_moved IN \(([^)]*)\)\)/.exec(table.sql)?.[1];
      expect(quotedValues(definition ?? "")).toEqual(expected);
    } finally {
      db.close();
    }
  });

  test("lists the MAIN_MOVED values on Postgres", async () => {
    const pg = await pgliteDb();
    try {
      const { rows } = await pg.$client.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'work_item_merge_settings_check_2'",
      );
      expect(rows).toHaveLength(1);
      expect(quotedValues(rows[0]!.definition.replaceAll("::text", ""))).toEqual(expected);
    } finally {
      await pg.$client.close();
    }
  });
});
