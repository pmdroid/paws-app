import { describe, expect, test } from "bun:test";
import {
  getCandidateRisk,
  latestCandidateRisk,
  migrate,
  openDatabase,
  saveCandidateRisk,
} from "../src/db";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run(
    `INSERT INTO work_item (id,delegation_id,linear_issue_id,linear_identifier,title,state,position,version,branch_name,created_at)
     VALUES ('item','delegation','issue','PAS-755','Risk','merge_queue',0,0,'paws/pas-755',1)`,
  );
  return db;
}

describe("candidate risk", () => {
  test("stores the tier and matched paths for each candidate head", () => {
    const db = seeded();
    saveCandidateRisk(db, {
      itemId: "item",
      head: "aaa",
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts"],
      classifiedAt: 10,
    });
    saveCandidateRisk(db, {
      itemId: "item",
      head: "bbb",
      base: "base",
      tier: "normal",
      paths: [],
      classifiedAt: 20,
    });
    expect(getCandidateRisk(db, "item", "aaa")).toEqual({
      itemId: "item",
      head: "aaa",
      base: "base",
      tier: "high",
      paths: ["src/auth/session.ts"],
      classifiedAt: 10,
    });
    expect(latestCandidateRisk(db, "item")?.head).toBe("bbb");
    expect(getCandidateRisk(db, "item", "ccc")).toBeNull();
    expect(() =>
      db.run(
        "INSERT INTO candidate_risk (item_id, head_sha, base_sha, tier, paths, classified_at) VALUES ('item','x','b','low','[]',1)",
      ),
    ).toThrow();
  });
});
