import { createHash } from "node:crypto";
import {
  SPEC_VERSION,
  type PolicyFile,
  type ResolvedRequirement,
  type ResolvedSetup,
  type RetryPolicy,
} from "../types";

/**
 * Canonical JSON for Closeout draft 0.1 section 6.
 * Object keys are sorted by UTF-16 code unit. Arrays keep their order.
 * Strings use JSON encoding. The only numbers are safe integers, in base 10,
 * with no exponent and no insignificant whitespace.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `sha256:` plus the SHA-256 of the UTF-8 canonical policy identity. */
export function policyCanonicalJson(policy: {
  files: readonly PolicyFile[];
  items: readonly ResolvedRequirement[];
  setup: readonly ResolvedSetup[];
  retry?: RetryPolicy;
}): string {
  const body: Record<string, unknown> = {
    specVersion: SPEC_VERSION,
    files: policy.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    items: policy.items.map(requirementJson),
  };
  if (policy.retry !== undefined) {
    body.retry = {
      maxFailedAttemptsPerItem: policy.retry.maxFailedAttemptsPerItem,
      scope: policy.retry.scope,
    };
  }
  if (policy.setup.length > 0) body.setup = policy.setup.map(setupJson);
  return canonicalJson(body);
}

export function sortPolicyFiles(files: readonly PolicyFile[]): PolicyFile[] {
  const byPath = new Map<string, PolicyFile>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()].sort((left, right) => compareUtf16(left.path, right.path));
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requirementJson(item: ResolvedRequirement): Record<string, unknown> {
  if ("supported" in item) {
    return withPaths(
      { id: item.id, kind: item.kind, gate: item.gate, supported: false },
      item.paths,
    );
  }
  if (item.kind === "command") {
    return withPaths(
      {
        id: item.id,
        kind: item.kind,
        gate: item.gate,
        exec: item.exec,
        timeoutSeconds: item.timeoutSeconds,
      },
      item.paths,
    );
  }
  return withPaths(
    {
      id: item.id,
      kind: item.kind,
      gate: item.gate,
      skill: item.skill,
      independence: {
        differentSession: item.independence.differentSession,
        differentModel: item.independence.differentModel,
      },
      failOn: item.failOn,
    },
    item.paths,
  );
}

function setupJson(step: ResolvedSetup): Record<string, unknown> {
  return withPaths(
    {
      id: step.id,
      kind: step.kind,
      gate: step.gate,
      exec: step.exec,
      timeoutSeconds: step.timeoutSeconds,
    },
    step.paths,
  );
}

function withPaths(
  value: Record<string, unknown>,
  paths: string[] | undefined,
): Record<string, unknown> {
  if (paths !== undefined && paths.length > 0) value.paths = paths;
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => compareUtf16(left, right));
    const parts = keys.map((key) => `${canonicalString(key)}:${canonicalize(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error("canonical JSON only accepts safe integers");
}

function canonicalNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error("canonical JSON only accepts safe integers");
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function canonicalString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += ch;
      }
    }
  }
  out += '"';
  return out;
}
