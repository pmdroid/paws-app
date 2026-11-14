import { fullStatusFixture, issueList, issueResource } from "../test/fixtures";
import { describe, expect, test } from "bun:test";
import { parseIssueDetailResponse, parseIssueListResponse } from "./contract";

describe("issue resource contract", () => {
  test("rejects a body that is missing the source", () => {
    const parsed = parseIssueListResponse({ generatedAt: new Date().toISOString() });
    expect(parsed.ok).toBe(false);
  });

  test("rejects the removed demo source", () => {
    expect(parseIssueListResponse({ ...issueList(fullStatusFixture()), source: "demo" }).ok).toBe(
      false,
    );
  });

  test("rejects a recommended option outside the list", () => {
    const full = fullStatusFixture();
    const detail = issueResource(full, full.questions[0]!.itemId);
    detail.questions[0]!.recommendedOption = 9;
    expect(parseIssueDetailResponse(detail).ok).toBe(false);
  });

  test("the list carries one row per item and no runs, Closeout or events", () => {
    const full = fullStatusFixture();
    const parsed = parseIssueListResponse(
      JSON.parse(
        JSON.stringify({ ...issueList(full), events: [{ at: full.generatedAt, text: "x" }] }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.response).sort()).toEqual([
      "generatedAt",
      "issues",
      "project",
      "source",
    ]);
    for (const row of parsed.response.issues)
      expect(Object.keys(row).every((key) => !["timeline", "pr", "runId"].includes(key))).toBe(
        true,
      );
  });

  test("the list rejects a row without a known state", () => {
    const list = issueList(fullStatusFixture());
    (list.issues[0] as { state: string }).state = "green";
    expect(parseIssueListResponse(list).ok).toBe(false);
  });

  test("the issue detail keeps every attempt with its checks and findings", () => {
    const parsed = parseIssueDetailResponse(
      JSON.parse(JSON.stringify(issueResource(fullStatusFixture(), "ENG-100"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const verdict = parsed.response.verdicts[0]!;
    expect(verdict.attempts?.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
    expect(verdict.maxAttempts).toBe(3);
    expect(verdict.checks.some((check) => check.command !== "")).toBe(true);
  });
});
