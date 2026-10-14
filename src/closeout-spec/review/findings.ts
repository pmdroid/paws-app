import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020";
import type { Finding, Severity } from "../types";
import evidenceSchema from "../schema/evidence.schema.json" with { type: "json" };

const SEVERITIES = new Set<Severity>(["P0", "P1", "P2", "P3"]);

/**
 * The spec's finding format, copied into the reviewer prompt.
 * Severity, location, explanation, and evidence are the evidence-schema fields.
 */
export const FINDING_FORMAT = [
  "Reply with a JSON array of findings and no other text.",
  "Each finding has these fields and no others:",
  "- severity: P0, P1, P2, or P3. P0 is the most severe.",
  "- location: where you looked. 1 to 512 characters.",
  "- explanation: what is wrong, or what you checked. 1 to 8000 characters.",
  "- evidence: the observation that supports the finding. 1 to 8000 characters.",
  "At most 200 findings. An empty array means you found nothing.",
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
  const slice = bracketSlice(text);
  if (slice !== undefined) {
    const inner = tryParse(slice);
    if (inner.ok) return validateParsed(inner.value);
    return { ok: false, reason: "reply was not valid JSON" };
  }
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

function validateParsed(value: unknown): ParsedFindings {
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

function bracketSlice(text: string): string | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
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
