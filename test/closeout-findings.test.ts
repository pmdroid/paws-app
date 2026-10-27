import { expect, test } from "bun:test";
import { findingsJsonSchema, parseFindings } from "../src/closeout-spec";

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

test("the review command schema is an object, as OpenAI structured output requires", () => {
  const schema = findingsJsonSchema() as Record<string, unknown>;
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["findings"]);
  expect(schema.additionalProperties).toBe(false);
  expect((schema.properties as Record<string, { type: string }>)["findings"]?.type).toBe("array");
});

test("a reply shaped by the object schema parses to its findings", () => {
  const reported = {
    severity: "P2" as const,
    location: "src/a.ts:1",
    explanation: "x",
    evidence: "y",
  };
  expect(parseFindings(JSON.stringify({ findings: [reported] }))).toEqual({
    ok: true,
    findings: [reported],
  });
  expect(parseFindings('{"findings":[]}')).toEqual({ ok: true, findings: [] });
});
