import { afterEach, expect, test } from "bun:test";
import {
  getTaskModeGenerationSteps,
  getTaskModeSteps,
  saveTaskModeSteps,
  taskRequiresRepositorySteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a task mode is selected once with its generation and repository context", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "item");
    expect(await db.run((q) => getTaskModeSteps(q, "item"))).toBeNull();
    expect(await db.run((q) => getTaskModeGenerationSteps(q, "item"))).toBe(0);
    expect(await db.run((q) => taskRequiresRepositorySteps(q, "item"))).toBe(false);

    expect(await db.transaction((q) => saveTaskModeSteps(q, "item", "answer", 3, true))).toBe(
      "answer",
    );
    expect(await db.transaction((q) => saveTaskModeSteps(q, "item", "answer"))).toBe("answer");
    await expect(db.transaction((q) => saveTaskModeSteps(q, "item", "code"))).rejects.toThrow(
      "Task mode already selected",
    );
    expect(await db.run((q) => getTaskModeSteps(q, "item"))).toBe("answer");
    expect(await db.run((q) => getTaskModeGenerationSteps(q, "item"))).toBe(3);
    expect(await db.run((q) => taskRequiresRepositorySteps(q, "item"))).toBe(true);
  });
});
