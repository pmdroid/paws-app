import { afterEach, describe, expect, test } from "bun:test";
import { getCandidateRisk, latestCandidateRisk, saveCandidateRisk } from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const openStores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of openStores.splice(0)) await close();
});

async function openStore() {
  const { db, close } = await tempStore();
  openStores.push(close);
  return db;
}

async function seeded() {
  const db = await openStore();
  await seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id: "item",
      delegationId: "delegation",
      linearIssueId: "issue",
      linearIdentifier: "PAS-755",
      title: "Risk",
      state: "merge_queue",
      position: 0,
      version: 0,
      branchName: "paws/pas-755",
      createdAt: 1,
    }),
  );
  return db;
}

describe("candidate risk", () => {
  test("stores the tier and matched paths for each candidate head", async () => {
    const db = await seeded();
    await saveCandidateRisk(db, {
      itemId: "item",
      head: "aaa",
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts"],
      matches: [{ path: "src/auth/session.ts", lists: ["settings", "file"] }],
      classifiedAt: 10,
    });
    await saveCandidateRisk(db, {
      itemId: "item",
      head: "bbb",
      base: "base",
      tier: "normal",
      paths: [],
      classifiedAt: 20,
    });
    expect(await getCandidateRisk(db, "item", "aaa")).toEqual({
      itemId: "item",
      head: "aaa",
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts"],
      matches: [{ path: "src/auth/session.ts", lists: ["settings", "file"] }],
      classifiedAt: 10,
    });
    expect(await getCandidateRisk(db, "item", "bbb")).not.toHaveProperty("matches");
    expect((await latestCandidateRisk(db, "item"))?.head).toBe("bbb");
    expect(await getCandidateRisk(db, "item", "ccc")).toBeNull();
    await expect(
      seed(db, (q) =>
        q.orm.insert(q.t.candidateRisk).values({
          itemId: "item",
          headSha: "x",
          baseSha: "b",
          tier: "low",
          paths: [],
          classifiedAt: 1,
        }),
      ),
    ).rejects.toThrow();
  });
});
