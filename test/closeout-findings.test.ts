import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { FINDING_FORMAT, findingsJsonSchema, parseFindings } from "../src/closeout-spec";
import evidenceSchema from "../src/closeout-spec/schema/evidence.schema.json" with { type: "json" };

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

const commandValidator = () => new Ajv2020({ strict: false }).compile(findingsJsonSchema());

test("the review command schema allows ten findings of at most 600 characters", () => {
  const validate = commandValidator();
  expect(validate({ findings: Array.from({ length: 10 }, () => finding) })).toBe(true);
  expect(validate({ findings: [{ ...finding, explanation: "x".repeat(600) }] })).toBe(true);
  expect(validate({ findings: Array.from({ length: 11 }, () => finding) })).toBe(false);
  expect(validate({ findings: [{ ...finding, explanation: "x".repeat(601) }] })).toBe(false);
  expect(validate({ findings: [{ ...finding, evidence: "x".repeat(601) }] })).toBe(false);
});

test("the review command schema defines each severity and leaves the evidence schema alone", () => {
  const schema = JSON.stringify(findingsJsonSchema());
  for (const severity of ["P0: data loss", "P1: a reachable defect", "P2: a defect", "P3: style"])
    expect(schema).toContain(severity);
  expect(schema).toContain("is P2 unless reproduced");
  expect(schema).toContain("No label prefix.");
  const vendored = JSON.stringify(evidenceSchema);
  expect(vendored).toContain('"maxItems":200');
  expect(vendored).not.toContain("No label prefix.");
});

test("the re-ask format carries the severity scale and accepts an answer the command schema allows", () => {
  expect(FINDING_FORMAT).toContain("P1: a reachable defect in changed code");
  expect(FINDING_FORMAT).toContain("At most 10 findings.");
  const answer = { findings: Array.from({ length: 10 }, () => finding) };
  expect(commandValidator()(answer)).toBe(true);
  expect(parseFindings(JSON.stringify(answer))).toEqual({ ok: true, findings: answer.findings });
});
