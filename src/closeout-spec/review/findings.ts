import { journalCaught } from "../../journal";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020";
import type { Finding, Severity } from "../types";
import evidenceSchema from "../schema/evidence.schema.json" with { type: "json" };

const SEVERITIES = new Set<Severity>(["P0", "P1", "P2", "P3"]);

/** Most findings a review command may report. Its schema enforces this; the vendored evidence schema allows 200. */
const MAX_FINDINGS = 10;
/** Longest explanation or evidence a review command may report. */
const MAX_TEXT = 600;

const EXPLANATION = "What is wrong, in at most three sentences. No label prefix.";
const EVIDENCE = "The concrete input or call sequence that triggers it, or the check you ran.";

/** What each severity means, given to every reviewer in the prompt and the command schema. */
const SEVERITY_SCALE = [
  "P0: data loss, a security break, or a wrong merge reachable in production today.",
  "P1: a reachable defect in changed code with a concrete trigger that causes a wrong state, a stuck or revived item, or a failed command.",
  "P2: a defect that needs an unusual race or input, or a missing test for new behaviour.",
  "P3: style, duplication, efficiency, naming and documentation.",
  "A race that needs concurrent events during an `await` is P2 unless reproduced.",
];

/**
 * The spec's finding format, copied into the reviewer prompt.
 * Severity, location, explanation, and evidence are the evidence-schema fields.
 */
export const FINDING_FORMAT = [
  "Reply with a JSON array of findings and no other text.",
  "Each finding has these fields and no others:",
  "- severity: P0, P1, P2, or P3. P0 is the most severe.",
  ...SEVERITY_SCALE.map((line) => `  - ${line}`),
  "- location: path:line in the head commit, such as src/app.ts:42. 1 to 512 characters. Use the line the change added or edited that causes the problem. When the change breaks code it did not edit, use the changed line that breaks it.",
  `- explanation: ${EXPLANATION} Name every place in the change where the same problem occurs so the fixer fixes all of them, not one line. 1 to ${MAX_TEXT} characters.`,
  `- evidence: ${EVIDENCE} 1 to ${MAX_TEXT} characters.`,
  `At most ${MAX_FINDINGS} findings. An empty array means you found nothing.`,
].join("\n");

export type ParsedFindings = { ok: true; findings: Finding[] } | { ok: false; reason: string };

let compiled: ValidateFunction | undefined;

/** Validate a reviewer reply against the vendored evidence schema's finding array. */
export function parseFindings(text: string): ParsedFindings {
  const fenced = lastParsed(fenceBodies(text));
  if (fenced.sawJson) return validateParsed(fenced.value);
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    const whole = tryParse(trimmed);
    if (whole.ok) return validateParsed(whole.value);
  }
  const slices = bracketSlices(text);
  for (const slice of slices) {
    const inner = tryParse(slice);
    if (inner.ok) return validateParsed(inner.value);
  }
  if (slices.length > 0) return { ok: false, reason: "reply was not valid JSON" };
  return { ok: false, reason: "reply did not contain a JSON array" };
}

export function reaskPrompt(reason: string): string {
  return [
    "The previous reply was not a valid findings array.",
    reason,
    "Reply again with only a JSON array of findings.",
    FINDING_FORMAT,
  ].join("\n\n");
}

/**
 * JSON Schema for a review command's final message: `{ findings: [...] }`. Structured output
 * from OpenAI and Anthropic requires an object at the top level, so the array is wrapped.
 */
export function findingsJsonSchema(): AnySchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: { findings: commandFindingsSchema() },
  };
}

/** The vendored finding array, narrowed for review commands and described for the model. */
function commandFindingsSchema(): AnySchema {
  const findings = findingsSchema(evidenceSchema as unknown) as Record<string, unknown>;
  const item = findings.items;
  if (!isRecord(item) || !isRecord(item.properties)) {
    throw new Error("evidence schema findings have no item properties");
  }
  const fields = item.properties;
  return {
    ...findings,
    maxItems: MAX_FINDINGS,
    items: {
      ...item,
      properties: {
        ...fields,
        severity: { ...field(fields.severity), description: SEVERITY_SCALE.join("\n") },
        explanation: {
          ...field(fields.explanation),
          maxLength: MAX_TEXT,
          description: EXPLANATION,
        },
        evidence: { ...field(fields.evidence), maxLength: MAX_TEXT, description: EVIDENCE },
      },
    },
  };
}

function field(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("evidence schema finding field is not an object");
  return value;
}

function validateParsed(parsed: unknown): ParsedFindings {
  const value =
    isRecord(parsed) && Object.keys(parsed).length === 1 && "findings" in parsed
      ? parsed.findings
      : parsed;
  const validate = findingsValidator();
  if (!validate(value)) return { ok: false, reason: schemaReason(validate.errors) };
  if (!Array.isArray(value) || !value.every(isFinding)) {
    return { ok: false, reason: "findings do not match the evidence schema" };
  }
  return { ok: true, findings: value };
}

function schemaReason(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "findings do not match the evidence schema";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`.trim())
    .join("; ");
}

function findingsValidator(): ValidateFunction {
  if (compiled) return compiled;
  const parsed: unknown = evidenceSchema;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  compiled = ajv.compile(findingsSchema(parsed));
  return compiled;
}

function findingsSchema(root: unknown): AnySchema {
  const review = defs(root).review;
  if (!isRecord(review)) throw new Error("evidence schema has no review definition");
  const properties = review.properties;
  if (!isRecord(properties)) throw new Error("evidence schema review has no properties");
  const findings = properties.findings;
  if (!isRecord(findings)) throw new Error("evidence schema has no findings array");
  return findings;
}

function defs(root: unknown): Record<string, unknown> {
  if (!isRecord(root)) throw new Error("evidence schema is not an object");
  const nested = root.$defs;
  if (!isRecord(nested)) throw new Error("evidence schema has no definitions");
  return nested;
}

function fenceBodies(text: string): string[] {
  const bodies: string[] = [];
  const fence = /```(?:json)?[^\n]*\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fence)) {
    const body = match[1]?.trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

function lastParsed(bodies: string[]): { sawJson: boolean; value: unknown } {
  for (let index = bodies.length - 1; index >= 0; index -= 1) {
    const body = bodies[index];
    if (body === undefined) continue;
    const parsed = tryParse(body);
    if (parsed.ok) return { sawJson: true, value: parsed.value };
  }
  return { sawJson: false, value: undefined };
}

function bracketSlices(text: string): string[] {
  const end = text.lastIndexOf("]");
  const slices: string[] = [];
  for (
    let start = text.indexOf("[");
    start !== -1 && start < end;
    start = text.indexOf("[", start + 1)
  )
    slices.push(text.slice(start, end + 1));
  return slices;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (caughtError1) {
    journalCaught(caughtError1, "findings.tryParse.parse", null);
    return { ok: false };
  }
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    isSeverity(value.severity) &&
    typeof value.location === "string" &&
    typeof value.explanation === "string" &&
    typeof value.evidence === "string"
  );
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && SEVERITIES.has(value as Severity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
