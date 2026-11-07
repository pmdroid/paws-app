import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { repositoryCommandSettlementSteps } from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a repository command settles as done, waits, or expires past its deadline", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const command = (id: string, state: string, result: string | null = null) => ({
      id,
      runnerId: "box",
      itemId: "ENG-1",
      payload: "{}",
      state,
      result,
      grantHash: "grant",
      expiresAt: 100,
      createdAt: 0,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerRepositoryCommand)
        .values([
          command("done", "done", "ok"),
          command("pending", "pending"),
          command("delivered", "delivered"),
        ]),
    );
    const settle = (id: string, at: number) =>
      db.run((q) => repositoryCommandSettlementSteps(q, id, at));

    expect(await settle("missing", 0)).toBeNull();
    expect(await settle("done", 500)).toEqual({ state: "done", result: "ok" });
    expect(await settle("pending", 99)).toEqual({ state: "pending" });
    expect(await settle("delivered", 99)).toEqual({ state: "delivered" });
    expect(await settle("delivered", 100)).toEqual({ state: "expired" });
    expect(await settle("delivered", 0)).toEqual({ state: "expired" });
    const expired = await db.run(function* (q) {
      const table = q.t.runnerRepositoryCommand;
      return yield* q.one(
        q.orm
          .select({ state: table.state, grantHash: table.grantHash })
          .from(table)
          .where(eq(table.id, "delivered")),
      );
    });
    expect(expired).toEqual({ state: "expired", grantHash: null });
  });
});
