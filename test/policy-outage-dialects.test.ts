import { afterEach, expect, test } from "bun:test";
import {
  endPolicyOutageSteps,
  getPolicyOutageSteps,
  recordPolicyOutageSteps,
  setPolicyOutageQuestionSteps,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const broken = (repository: string, now: number, main: string, error = "unreadable") => ({
  repository,
  error,
  policyPath: ".paws/closeout.toml",
  main,
  changedBy: "c1",
  now,
});

forEachDialect((connect) => {
  test("a policy outage follows main while its error holds and restarts when it changes", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;

    expect(await db.run((q) => recordPolicyOutageSteps(q, broken("acme/paws", 100, "m1")))).toEqual(
      {
        repository: "acme/paws",
        startedAt: 100,
        error: "unreadable",
        policyPath: ".paws/closeout.toml",
        main: "m1",
        changedBy: "c1",
        questionId: null,
        questionItemId: null,
      },
    );
    await db.run((q) =>
      setPolicyOutageQuestionSteps(q, "acme/paws", { id: "q1", itemId: "ENG-1" }),
    );
    expect(
      await db.run((q) => recordPolicyOutageSteps(q, broken("acme/paws", 200, "m2"))),
    ).toMatchObject({ startedAt: 100, main: "m2", questionId: "q1", questionItemId: "ENG-1" });
    expect(
      await db.run((q) => recordPolicyOutageSteps(q, broken("acme/paws", 300, "m3", "other"))),
    ).toMatchObject({ startedAt: 300, main: "m3", error: "other", questionId: null });

    expect(await db.run((q) => endPolicyOutageSteps(q, "acme/paws"))).toMatchObject({
      repository: "acme/paws",
    });
    expect(await db.run((q) => endPolicyOutageSteps(q, "acme/paws"))).toBeNull();
    expect(await db.run((q) => getPolicyOutageSteps(q, "acme/paws"))).toBeNull();
  });
});
