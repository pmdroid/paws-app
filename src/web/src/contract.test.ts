import { fullStatusFixture, itemDetail, statusFixture } from "../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseStatusItemDetail, parseStatusSnapshot, STATUS_API_VERSION } from "./contract";

describe("status contract", () => {
  test("rejects a body that is missing the version", () => {
    const parsed = parseStatusSnapshot({ source: "live" });
    expect(parsed.ok).toBe(false);
  });

  test("rejects the removed demo source", () => {
    expect(parseStatusSnapshot({ ...statusFixture(), source: "demo" }).ok).toBe(false);
  });

  test("rejects a recommended option outside the list", () => {
    const snapshot = statusFixture();
    snapshot.questions[0]!.recommendedOption = 9;
    const parsed = parseStatusSnapshot(snapshot);
    expect(parsed.ok).toBe(false);
  });

  test("rejects a body of the first version, which carried every Closeout attempt", () => {
    expect(STATUS_API_VERSION).toBe(2);
    expect(parseStatusSnapshot({ ...statusFixture(), version: 1 }).ok).toBe(false);
  });

  test("the list carries one Closeout summary per item and no events", () => {
    const full = fullStatusFixture();
    const parsed = parseStatusSnapshot(
      JSON.parse(
        JSON.stringify({ ...statusFixture(), events: [{ at: full.generatedAt, text: "x" }] }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect("events" in parsed.snapshot).toBe(false);
    const verdict = parsed.snapshot.verdicts.find((entry) => entry.itemId === "ENG-100")!;
    expect(Object.keys(verdict).sort()).toEqual(["checks", "decision", "headSha", "itemId"]);
    expect(verdict.decision).toBe("exhausted");
    for (const check of verdict.checks) expect(Object.keys(check)).toEqual(["id", "kind", "state"]);
    const agent = parsed.snapshot.agentCloseout![0]!;
    expect(Object.keys(agent).sort()).toEqual([
      "blocked",
      "decision",
      "headSha",
      "itemId",
      "runId",
      "updatedAt",
    ]);
    expect(agent.decision).toBe(full.agentCloseout![0]!.attempts.at(-1)!.decision);
  });

  test("the list rejects a summary check without a known state", () => {
    const snapshot = statusFixture();
    (snapshot.verdicts[0]!.checks[0] as { state: string }).state = "green";
    expect(parseStatusSnapshot(snapshot).ok).toBe(false);
  });

  test("the item detail keeps every attempt with its checks and findings", () => {
    const parsed = parseStatusItemDetail(
      JSON.parse(JSON.stringify(itemDetail(fullStatusFixture(), "ENG-100"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const verdict = parsed.detail.verdicts[0]!;
    expect(verdict.attempts?.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
    expect(verdict.maxAttempts).toBe(3);
    expect(verdict.checks.some((check) => check.command !== "")).toBe(true);
  });
});
