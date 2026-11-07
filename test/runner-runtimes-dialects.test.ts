import { afterEach, expect, test } from "bun:test";
import { listRunnerRuntimesSteps, recordRunnerRuntimesSteps } from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a runner's reported runtimes replace the ones it reported before", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await db.run((q) =>
      recordRunnerRuntimesSteps(
        q,
        "box",
        [
          { tool: "node", version: "22", status: "installed", error: "ignored" },
          { tool: "go", version: "1.23", status: "failed", error: "no network" },
          { tool: "bun", version: "1.4", status: "failed" },
        ],
        10,
      ),
    );
    await db.run((q) =>
      recordRunnerRuntimesSteps(
        q,
        "other",
        [{ tool: "go", version: "1.23", status: "installed" }],
        10,
      ),
    );
    expect(await db.run((q) => listRunnerRuntimesSteps(q, "box"))).toEqual([
      { tool: "bun", version: "1.4", status: "failed", error: null, reportedAt: 10 },
      { tool: "go", version: "1.23", status: "failed", error: "no network", reportedAt: 10 },
      { tool: "node", version: "22", status: "installed", error: null, reportedAt: 10 },
    ]);

    await db.run((q) =>
      recordRunnerRuntimesSteps(
        q,
        "box",
        [{ tool: "node", version: "22", status: "installed" }],
        20,
      ),
    );
    expect(await db.run((q) => listRunnerRuntimesSteps(q, "box"))).toEqual([
      { tool: "node", version: "22", status: "installed", error: null, reportedAt: 20 },
    ]);
    expect(await db.run((q) => listRunnerRuntimesSteps(q, "other"))).toHaveLength(1);
  });
});
