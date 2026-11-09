import { afterEach, expect, test } from "bun:test";
import {
  getTaskClassificationSteps,
  resolveTaskClassificationSteps,
  saveTaskClassificationSteps,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a classification is saved once, read back parsed and resolved to a redirect", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    expect(await db.run((q) => getTaskClassificationSteps(q, "task"))).toBeNull();
    await db.run((q) =>
      saveTaskClassificationSteps(q, "task", { mode: "clarify", question: "Which repo?" }),
    );
    await db.run((q) => saveTaskClassificationSteps(q, "task", { mode: "answer" }));
    expect(await db.run((q) => getTaskClassificationSteps(q, "task"))).toEqual({
      mode: "clarify",
      question: "Which repo?",
    });

    await db.transaction((q) =>
      resolveTaskClassificationSteps(q, { taskKey: "task", itemId: "item", context: "ctx" }),
    );
    expect(await db.run((q) => getTaskClassificationSteps(q, "task"))).toEqual({
      mode: "code",
      redirect: { taskKey: "resolved:task", itemId: "item" },
    });
    expect(await db.run((q) => getTaskClassificationSteps(q, "resolved:task"))).toEqual({
      mode: "code",
      context: "ctx",
      sourceItemId: "item",
    });
  });
});
