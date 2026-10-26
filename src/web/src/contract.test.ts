import { statusFixture } from "../../../test/fixtures/status";
import { describe, expect, test } from "bun:test";
import { parseStatusSnapshot } from "./contract";

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
});
