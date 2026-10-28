import { journalCaught } from "../../journal";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020";
import { parse, YAMLParseError } from "yaml";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import type {
  PolicyCommand,
  EvidenceApprovalMode,
  ReviewScope,
  EvidenceMedia,
  PolicyDocument,
  PolicyEvidence,
  PolicyImport,
  PolicyItem,
  PolicyReview,
  PolicyRule,
  PolicySetupStep,
  RetryPolicy,
  RetryScope,
  RuleOnFail,
  Severity,
} from "../types";

const YAML_OPTIONS = { uniqueKeys: true, version: "1.2" } as const;

const schema = readSchema();
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validatePolicy = compiled("urn:closeout:policy:0.1");
const validateCommand = ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/command" });
const validateReview = ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/review" });
const validateEvidence = ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/evidence" });

export type ParsedPolicy = { ok: true; document: PolicyDocument } | { ok: false; message: string };

/** YAML 1.2 parse plus `policy.schema.json`. The message has no file prefix. */
export function parsePolicy(text: string): ParsedPolicy {
  let value: unknown;
  try {
    value = parse(text, YAML_OPTIONS);
  } catch (error) {
    journalCaught(error, "document.parsePolicy.parse", null);
    if (error instanceof YAMLParseError && error.code === "DUPLICATE_KEY") {
      return { ok: false, message: "duplicated mapping key" };
    }
    return { ok: false, message: "invalid YAML" };
  }
  const schemaError = schemaMessage(value);
  if (schemaError !== undefined) return { ok: false, message: schemaError };
  try {
    return { ok: true, document: decodeDocument(value) };
  } catch (error) {
    journalCaught(error, "document.parsePolicy.decodeDocument", null);
    const message = error instanceof Error ? error.message : "document does not match the schema";
    return { ok: false, message };
  }
}

/** Best-effort parse used only to discover import and skill paths. */
export function tryParseYamlValue(text: string): unknown | undefined {
  try {
    return parse(text, YAML_OPTIONS);
  } catch (caughtError1) {
    journalCaught(caughtError1, "document.tryParseYamlValue.parse", null);
    return undefined;
  }
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (caughtError2) {
    journalCaught(caughtError2, "document.decodeUtf8.decode", null);
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaMessage(value: unknown): string | undefined {
  if (validatePolicy(value)) return undefined;
  const errors = validatePolicy.errors ?? [];
  const structural = errors.find((error) => !error.instancePath.startsWith("/items/"));
  if (structural) return formatError(structural);
  return itemSchemaMessage(value) ?? formatError(errors[0]);
}

function itemSchemaMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined;
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!isRecord(item)) return `/items/${index} must be object`;
    if (item.kind === "command") {
      if (!validateCommand(item))
        return formatUnder(`/items/${index}`, validateCommand.errors?.[0]);
    } else if (item.kind === "review") {
      if (!validateReview(item)) return formatUnder(`/items/${index}`, validateReview.errors?.[0]);
    } else if (item.kind === "evidence") {
      if (!validateEvidence(item))
        return formatUnder(`/items/${index}`, validateEvidence.errors?.[0]);
    } else {
      return `/items/${index} must match exactly one schema in oneOf`;
    }
  }
  return undefined;
}

function formatUnder(prefix: string, error: ErrorObject | undefined): string {
  if (!error) return `${prefix} document does not match the schema`;
  const path = `${prefix}${error.instancePath}`;
  return `${path.length === 0 ? "/" : path} ${errorDetail(error)}`;
}

function formatError(error: ErrorObject | undefined): string {
  if (!error) return "document does not match the schema";
  const path = error.instancePath.length === 0 ? "/" : error.instancePath;
  return `${path} ${errorDetail(error)}`;
}

function errorDetail(error: ErrorObject): string {
  if (error.keyword === "additionalProperties") {
    const property = additionalProperty(error);
    if (property !== undefined) {
      return `must NOT have additional properties ('${property}' was unexpected)`;
    }
  }
  return error.message ?? "document does not match the schema";
}

function additionalProperty(error: ErrorObject): string | undefined {
  const params = error.params;
  if (!("additionalProperty" in params)) return undefined;
  const property = params.additionalProperty;
  return typeof property === "string" ? property : undefined;
}

function decodeDocument(value: unknown): PolicyDocument {
  if (!isRecord(value) || value.specVersion !== "0.1") {
    throw new Error("document does not match the schema");
  }
  const document: PolicyDocument = {
    specVersion: "0.1",
    imports: value.imports === undefined ? [] : decodeImports(value.imports),
    items: value.items === undefined ? [] : decodeItems(value.items),
  };
  if (value.description !== undefined) {
    if (typeof value.description !== "string")
      throw new Error("document does not match the schema");
    document.description = value.description;
  }
  if (value.retry !== undefined) document.retry = decodeRetry(value.retry);
  if (value.setup !== undefined) document.setup = decodeSetup(value.setup);
  if (value.rules !== undefined) document.rules = decodeRules(value.rules);
  return document;
}

function decodeRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) throw new Error("document does not match the schema");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      throw new Error("document does not match the schema");
    }
    const rule: PolicyRule = {
      id: entry.id,
      probe: expectString(entry.probe),
      summary: expectString(entry.summary),
      failOn: expectSeverity(entry.failOn),
    };
    if (entry.exec !== undefined) rule.exec = expectStrings(entry.exec);
    if (entry.paths !== undefined) rule.paths = expectStrings(entry.paths);
    if (entry.onFail !== undefined) rule.onFail = expectOnFail(entry.onFail);
    return rule;
  });
}

function expectOnFail(value: unknown): RuleOnFail {
  if (value === "fix" || value === "approve") return value;
  throw new Error("document does not match the schema");
}

function decodeRetry(value: unknown): RetryPolicy {
  if (!isRecord(value)) throw new Error("document does not match the schema");
  const retry: RetryPolicy = {
    maxFailedAttemptsPerItem: expectInt(
      value.attempts_per_check ?? value.maxFailedAttemptsPerItem ?? 3,
    ),
    scope: expectScope(value.scope ?? "task"),
  };
  if (value.fix_rounds_per_item !== undefined)
    retry.fix_rounds_per_item = expectInt(value.fix_rounds_per_item);
  if (value.maxFailedReviewAttempts !== undefined) {
    retry.maxFailedReviewAttempts = expectInt(value.maxFailedReviewAttempts);
    if (retry.maxFailedReviewAttempts < retry.maxFailedAttemptsPerItem) {
      throw new Error("maxFailedReviewAttempts must be at least maxFailedAttemptsPerItem");
    }
  }
  return retry;
}

function decodeImports(value: unknown): PolicyImport[] {
  if (!Array.isArray(value)) throw new Error("document does not match the schema");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.as !== "string") {
      throw new Error("document does not match the schema");
    }
    return { path: entry.path, as: entry.as };
  });
}

function decodeItems(value: unknown): PolicyItem[] {
  if (!Array.isArray(value)) throw new Error("document does not match the schema");
  return value.map(decodeItem);
}

function decodeItem(value: unknown): PolicyItem {
  if (!isRecord(value) || typeof value.id !== "string" || value.gate !== "beforePR") {
    throw new Error("document does not match the schema");
  }
  const paths = value.paths === undefined ? undefined : expectStrings(value.paths);
  if (value.kind === "command") {
    const item: PolicyCommand = {
      id: value.id,
      kind: "command",
      gate: "beforePR",
      exec: expectStrings(value.exec),
      timeoutSeconds: expectInt(value.timeoutSeconds),
    };
    if (paths !== undefined) item.paths = paths;
    if (value.ci !== undefined) item.ci = expectString(value.ci);
    return item;
  }
  if (value.kind === "review") {
    const item: PolicyReview = {
      id: value.id,
      kind: "review",
      gate: "beforePR",
      skill: expectString(value.skill),
      independence: decodeIndependence(value.independence),
      failOn: expectSeverity(value.failOn),
    };
    if (value.scope !== undefined) item.scope = expectReviewScope(value.scope);
    if (value.parallel !== undefined) item.parallel = value.parallel === true;
    if (value.minChangedLines !== undefined)
      item.minChangedLines = expectInt(value.minChangedLines);
    if (paths !== undefined) item.paths = paths;
    return item;
  }
  if (value.kind === "evidence") {
    const item: PolicyEvidence = { id: value.id, kind: "evidence", gate: "beforePR" };
    if (value.media !== undefined) item.media = expectStrings(value.media).map(expectMedia);
    if (value.minimum !== undefined) item.minimum = expectInt(value.minimum);
    if (value.hint !== undefined) item.hint = expectString(value.hint);
    if (value.approval !== undefined) item.approval = expectApproval(value.approval);
    if (paths !== undefined) item.paths = paths;
    return item;
  }
  throw new Error("document does not match the schema");
}

function expectReviewScope(value: unknown): ReviewScope {
  if (value === "candidate" || value === "diff") return value;
  throw new Error("document does not match the schema");
}

function expectApproval(value: unknown): EvidenceApprovalMode {
  if (value === "human") return value;
  throw new Error("document does not match the schema");
}

function expectMedia(value: string): EvidenceMedia {
  if (value === "image" || value === "video") return value;
  throw new Error("document does not match the schema");
}

function decodeSetup(value: unknown): PolicySetupStep[] {
  if (!Array.isArray(value)) throw new Error("document does not match the schema");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      throw new Error("document does not match the schema");
    }
    const step: PolicySetupStep = {
      id: entry.id,
      exec: expectStrings(entry.exec),
      timeoutSeconds: expectInt(entry.timeoutSeconds),
    };
    if (entry.paths !== undefined) step.paths = expectStrings(entry.paths);
    return step;
  });
}

function decodeIndependence(value: unknown): {
  differentSession: boolean;
  differentModel: boolean;
} {
  if (!isRecord(value)) throw new Error("document does not match the schema");
  if (typeof value.differentSession !== "boolean" || typeof value.differentModel !== "boolean") {
    throw new Error("document does not match the schema");
  }
  return { differentSession: value.differentSession, differentModel: value.differentModel };
}

function expectString(value: unknown): string {
  if (typeof value !== "string") throw new Error("document does not match the schema");
  return value;
}

function expectStrings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("document does not match the schema");
  }
  return value;
}

function expectInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("document does not match the schema");
  }
  return value;
}

function expectScope(value: unknown): RetryScope {
  if (value === "task" || value === "candidate") return value;
  throw new Error("document does not match the schema");
}

function expectSeverity(value: unknown): Severity {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error("document does not match the schema");
}

function readSchema(): AnySchema {
  const value: unknown = policySchema;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("policy schema is not an object");
  }
  return value;
}

function compiled(id: string): ValidateFunction {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`policy schema ${id} did not compile`);
  return validate;
}
