import { afterEach, expect, test } from "bun:test";
import {
  deleteRiskFixSteps,
  getCandidateRiskSteps,
  getRiskAutoContextSteps,
  getRiskFixSteps,
  latestCandidateRiskSteps,
  latestRiskFixSteps,
  listRiskAutoContextsSteps,
  saveCandidateRiskSteps,
  saveRiskAutoContextSteps,
  saveRiskFixSteps,
  type CandidateRisk,
  type Db,
  type RiskAutoContext,
  type RiskFix,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await insertWorkItem(handle.db, "a");
  return handle.db;
}

forEachDialect((open) => {
  test("a candidate's risk is replaced per head and the latest breaks ties on the head", async () => {
    const db = await connect(open);
    expect(await db.run((q) => latestCandidateRiskSteps(q, "a"))).toBeNull();
    const first: CandidateRisk = {
      itemId: "a",
      head: "h1",
      base: "b",
      tier: "high",
      paths: ["db/x.sql"],
      classifiedAt: 5,
      matches: [{ path: "db/x.sql", lists: ["settings"] }],
    };
    const second: CandidateRisk = { ...first, head: "h2", tier: "normal", paths: [] };
    delete second.matches;
    await db.run((q) => saveCandidateRiskSteps(q, second));
    await db.run((q) => saveCandidateRiskSteps(q, first));
    expect(await db.run((q) => getCandidateRiskSteps(q, "a", "h1"))).toEqual(first);
    expect(await db.run((q) => getCandidateRiskSteps(q, "a", "h2"))).toEqual(second);
    expect(await db.run((q) => latestCandidateRiskSteps(q, "a"))).toEqual(second);
    const replaced = { ...first, classifiedAt: 6 };
    await db.run((q) => saveCandidateRiskSteps(q, replaced));
    expect(await db.run((q) => latestCandidateRiskSteps(q, "a"))).toEqual(replaced);
  });

  test("a risk fix is saved, replaced, read as latest and deleted", async () => {
    const db = await connect(open);
    const fix: RiskFix = {
      itemId: "a",
      head: "h1",
      approvedHead: "h0",
      approvedQuestionId: "q",
      changed: ["a.ts", "db/x.sql"],
      paths: ["db/x.sql"],
      recordedAt: 1,
    };
    await db.run((q) => saveRiskFixSteps(q, fix));
    await db.run((q) => saveRiskFixSteps(q, { ...fix, head: "h2", paths: [] }));
    expect(await db.run((q) => getRiskFixSteps(q, "a", "h1"))).toEqual(fix);
    expect(await db.run((q) => latestRiskFixSteps(q, "a"))).toEqual({
      ...fix,
      head: "h2",
      paths: [],
    });
    await db.run((q) => deleteRiskFixSteps(q, "a", "h2"));
    expect(await db.run((q) => latestRiskFixSteps(q, "a"))).toEqual(fix);
    await db.run((q) => deleteRiskFixSteps(q, "a", "h1"));
    expect(await db.run((q) => getRiskFixSteps(q, "a", "h1"))).toBeNull();
  });

  test("the automatic risk context keeps the latest head only", async () => {
    const db = await connect(open);
    const context: RiskAutoContext = {
      autoApproveHighRisk: true,
      policyDigest: "d",
      policyPaths: ["db/**"],
    };
    await db.transaction((q) => saveRiskAutoContextSteps(q, "a", "h1", context));
    await db.transaction((q) => saveRiskAutoContextSteps(q, "a", "h2", context));
    await db.transaction((q) => saveRiskAutoContextSteps(q, "a", "h2", context));
    expect(await db.run((q) => getRiskAutoContextSteps(q, "a"))).toEqual({ head: "h2", context });
    expect(await db.run((q) => listRiskAutoContextsSteps(q))).toEqual([
      { itemId: "a", head: "h2", context },
    ]);
    await db.transaction((q) => saveRiskAutoContextSteps(q, "a", "h2", null));
    expect(await db.run((q) => getRiskAutoContextSteps(q, "a"))).toBeNull();
  });
});
