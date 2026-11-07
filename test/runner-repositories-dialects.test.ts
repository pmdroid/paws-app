import { afterEach, expect, test } from "bun:test";
import { runnerRepositoryListsSteps, runnerRepositoryRefusalSteps } from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a runner refuses repositories outside its admin list first, then its host list", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerRepositories).values([
        {
          runnerId: "box",
          repositories: json(db, ["acme/paws", "acme/looky"]),
          reportedAt: 1,
          adminRepositories: json(db, ["Acme/Paws", "acme/other"]),
        },
        { runnerId: "open", repositories: null, reportedAt: 1, adminRepositories: null },
      ]),
    );

    expect(await db.run((q) => runnerRepositoryListsSteps(q, "box"))).toEqual({
      admin: ["Acme/Paws", "acme/other"],
      host: ["acme/paws", "acme/looky"],
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "open"))).toEqual({
      admin: null,
      host: null,
    });
    expect(await db.run((q) => runnerRepositoryListsSteps(q, "unknown"))).toEqual({
      admin: null,
      host: null,
    });

    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "ACME/paws"))).toBeNull();
    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "acme/looky"))).toEqual({
      list: "admin",
      allowed: ["Acme/Paws", "acme/other"],
    });
    expect(await db.run((q) => runnerRepositoryRefusalSteps(q, "box", "acme/other"))).toEqual({
      list: "host",
      allowed: ["acme/paws", "acme/looky"],
    });
    expect(
      await db.run((q) => runnerRepositoryRefusalSteps(q, "open", "acme/anything")),
    ).toBeNull();
  });
});
