import { expect, test } from "bun:test";
import { parseFindings } from "../src/closeout-spec";

const finding = {
  severity: "P2" as const,
  location: "src/runner-worker/index.ts:519-521",
  explanation: "A reviewer profile silently falls back when its 1M entry is unavailable.",
  evidence: "A reviewer requesting `opus[1m]` on a runner advertising only `opus` runs standard.",
};

test("prose with brackets before the findings array still parses the array", () => {
  const reply = [
    "The direct ACP path selects an advertised `[1m]` entry exactly and emits a notice.",
    "",
    JSON.stringify([finding], null, 2),
  ].join("\n");
  expect(parseFindings(reply)).toEqual({ ok: true, findings: [finding] });
});

test("an empty findings array after bracketed prose parses", () => {
  expect(parseFindings("Checked `sonnet[1m]` selection.\n[]")).toEqual({ ok: true, findings: [] });
});

test("bracketed prose without a findings array is still rejected", () => {
  expect(parseFindings("Checked `opus[1m]` and `sonnet[1m]`.").ok).toBe(false);
});
