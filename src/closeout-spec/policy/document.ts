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

export type ParsedPolicy =
  | {
      ok: true;
      document: PolicyDocument;
      /** JSON pointers of the keys the schema does not know, dropped before validation. */
      unknownKeys: string[];
    }
  | { ok: false; message: string };

export type PolicyParser = (text: string) => ParsedPolicy;

/**
 * A parser for one edition of `policy.schema.json`. A key the schema does not know is dropped
 * and named in `unknownKeys`, so a policy written for a newer parser still runs here; the keys it
 * knows are validated strictly. Tests pass an older schema to stand in for an older runner.
 */
export function createPolicyParser(policySchema: AnySchema): PolicyParser {
  const schema = readSchema(policySchema);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validators: Validators = {
    policy: compiled(ajv, "urn:closeout:policy:0.1"),
    command: ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/command" }),
    review: ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/review" }),
    evidence: ajv.compile({ $ref: "urn:closeout:policy:0.1#/$defs/evidence" }),
  };
  return (text) => {
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
    const unknownKeys: string[] = [];
    const known = knownKeys(value, schema, schema, "", unknownKeys);
    const schemaError = schemaMessage(validators, known);
    if (schemaError !== undefined) return { ok: false, message: schemaError };
    try {
      return { ok: true, document: decodeDocument(known), unknownKeys };
    } catch (error) {
      journalCaught(error, "document.parsePolicy.decodeDocument", null);
      const message = error instanceof Error ? error.message : "document does not match the schema";
      return { ok: false, message };
    }
  };
}

type Validators = {
  policy: ValidateFunction;
  command: ValidateFunction;
  review: ValidateFunction;
  evidence: ValidateFunction;
};

/** YAML 1.2 parse plus `policy.schema.json`. The message has no file prefix. */
export const parsePolicy: PolicyParser = createPolicyParser(policySchema);

/**
 * `value` without the object keys `node` does not list under `properties`, each recorded in
 * `unknown` as a JSON pointer. An `items` entry follows the branch its `kind` names; a value the
 * schema cannot place is returned as it is, for validation to reject.
 */
function knownKeys(
  value: unknown,
  node: unknown,
  root: Record<string, unknown>,
  path: string,
  unknown: string[],
): unknown {
  const schema = resolveRef(node, root);
  if (!isRecord(schema)) return value;
  if (Array.isArray(value)) {
    if (schema.items === undefined) return value;
    return value.map((entry, index) =>
      knownKeys(entry, schema.items, root, `${path}/${index}`, unknown),
    );
  }
  if (!isRecord(value)) return value;
  if (Array.isArray(schema.oneOf)) {
    const branch = schema.oneOf.find((option) => {
      const resolved = resolveRef(option, root);
      if (!isRecord(resolved) || !isRecord(resolved.properties)) return false;
      const kind = resolved.properties.kind;
      return isRecord(kind) && kind.const === value.kind;
    });
    return branch === undefined ? value : knownKeys(value, branch, root, path, unknown);
  }
  if (!isRecord(schema.properties) || schema.additionalProperties !== false) return value;
  const properties = schema.properties;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in properties)) {
      unknown.push(`${path}/${key}`);
      continue;
    }
    out[key] = knownKeys(entry, properties[key], root, `${path}/${key}`, unknown);
  }
  return out;
}

function resolveRef(node: unknown, root: Record<string, unknown>): unknown {
  let current = node;
  for (let depth = 0; depth < 8 && isRecord(current) && typeof current.$ref === "string"; depth++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/")) return current;
    let target: unknown = root;
    for (const part of ref.slice(2).split("/"))
      target = isRecord(target) ? target[part] : undefined;
    current = target;
  }
  return current;
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

function schemaMessage(validators: Validators, value: unknown): string | undefined {
  const validatePolicy = validators.policy;
  if (validatePolicy(value)) return undefined;
  const errors = validatePolicy.errors ?? [];
  const structural = errors.find((error) => !error.instancePath.startsWith("/items/"));
  if (structural) return formatError(structural);
  return itemSchemaMessage(validators, value) ?? formatError(errors[0]);
}

function itemSchemaMessage(
  { command: validateCommand, review: validateReview, evidence: validateEvidence }: Validators,
  value: unknown,
): string | undefined {
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
    if (entry.recheck !== undefined) rule.recheck = expectBoolean(entry.recheck);
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
  const recheck = value.recheck === undefined ? undefined : expectBoolean(value.recheck);
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
    if (recheck !== undefined) item.recheck = recheck;
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
    if (recheck !== undefined) item.recheck = recheck;
    return item;
  }
  if (value.kind === "evidence") {
    const item: PolicyEvidence = { id: value.id, kind: "evidence", gate: "beforePR" };
    if (value.media !== undefined) item.media = expectStrings(value.media).map(expectMedia);
    if (value.minimum !== undefined) item.minimum = expectInt(value.minimum);
    if (value.hint !== undefined) item.hint = expectString(value.hint);
    if (value.approval !== undefined) item.approval = expectApproval(value.approval);
    if (paths !== undefined) item.paths = paths;
    if (recheck !== undefined) item.recheck = recheck;
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

function expectBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("document does not match the schema");
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

function readSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("policy schema is not an object");
  return value;
}

function compiled(ajv: Ajv2020, id: string): ValidateFunction {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`policy schema ${id} did not compile`);
  return validate;
}
