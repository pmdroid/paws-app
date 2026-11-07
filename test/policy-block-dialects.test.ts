import { afterEach, expect, test } from "bun:test";
import { listOpenPolicyBlocksSteps, savePolicyBlockSteps, type PolicyBlock } from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const block = (questionId: string, itemId: string, repository = "acme/paws"): PolicyBlock => ({
  questionId,
  itemId,
  repository,
  cause: "policy_unreadable",
  error: "unreadable",
  policyPath: ".paws/closeout.toml",
  main: "m1",
  changedBy: null,
  createdAt: 100,
});

forEachDialect((connect) => {
  test("open policy blocks list oldest first, by item within a millisecond", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const question = (id: string, itemId: string, status = "open") => ({
      id,
      itemId,
      sessionId: `ses-${itemId}`,
      body: "help",
      status,
      createdAt: 100,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.question)
        .values([
          question("Z", "ENG-1"),
          question("A", "ENG-2"),
          question("B", "ENG-3"),
          question("C", "ENG-4", "answered"),
        ]),
    );

    await db.run((q) => savePolicyBlockSteps(q, block("A", "ENG-2")));
    await db.run((q) => savePolicyBlockSteps(q, { ...block("Z", "ENG-1"), error: "first" }));
    await db.run((q) => savePolicyBlockSteps(q, block("Z", "ENG-1")));
    await db.run((q) => savePolicyBlockSteps(q, block("B", "ENG-3", "acme/website")));
    await db.run((q) => savePolicyBlockSteps(q, block("C", "ENG-4")));

    expect(await db.run((q) => listOpenPolicyBlocksSteps(q, "acme/paws"))).toEqual([
      block("Z", "ENG-1"),
      block("A", "ENG-2"),
    ]);
    expect(
      (await db.run((q) => listOpenPolicyBlocksSteps(q))).map((found) => found.questionId),
    ).toEqual(["Z", "A", "B"]);
  });
});
