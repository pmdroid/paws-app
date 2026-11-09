import { afterEach, expect, test } from "bun:test";
import { listTaskBlockersSteps, listTaskBlocksSteps, saveTaskBlocksSteps } from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("saving blocks replaces the edges of the blocked issues and lists them", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    const save = (blocked: string[], edges: { blocker: string; blocked: string }[]) =>
      db.transaction((q) =>
        saveTaskBlocksSteps(
          q,
          blocked,
          edges.map((edge) => ({
            blockerLinearIssueId: edge.blocker,
            blockedLinearIssueId: edge.blocked,
          })),
        ),
      );
    await save(
      ["b", "c"],
      [
        { blocker: "z", blocked: "b" },
        { blocker: "a", blocked: "b" },
        { blocker: "a", blocked: "b" },
        { blocker: "a", blocked: "c" },
      ],
    );
    expect(await db.run((q) => listTaskBlockersSteps(q, "b"))).toEqual(["a", "z"]);
    await save(["b"], [{ blocker: "y", blocked: "b" }]);
    expect(await db.run((q) => listTaskBlockersSteps(q, "b"))).toEqual(["y"]);
    expect(
      (await db.run(listTaskBlocksSteps)).toSorted((x, y) => x.blocked.localeCompare(y.blocked)),
    ).toEqual([
      { blocker: "y", blocked: "b" },
      { blocker: "a", blocked: "c" },
    ]);
    await expect(save(["b"], [{ blocker: "a", blocked: "c" }])).rejects.toThrow(
      "blocked issue c is outside the replaced set",
    );
    expect(await db.run((q) => listTaskBlockersSteps(q, "c"))).toEqual(["a"]);
  });
});
