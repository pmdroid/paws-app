import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020";
import { parse, YAMLParseError } from "yaml";
import {
  SPEC_COMMIT,
  SPEC_VERSION,
  type CommandRecord,
  type CommandRunner,
  type DecisionDocument,
  type EvidenceStore,
  type PolicyDocument,
  type ResolvedPolicy,
  type Reviewer,
  type ReviewRecord,
} from "./index";

const SCHEMA_DIR = new URL("./schema/", import.meta.url).pathname;

const COMMIT_FULL = "4d0b6d871ca29b5f3d39868b2db80498e21e6e74";

type Manifest = {
  specVersion: string;
  commit: string;
  commitFull: string;
  files: Record<string, string>;
};

describe("closeout spec schemas", () => {
  test("vendored schema hashes match the manifest", () => {
    const manifest = readManifest();
    expect(SPEC_VERSION).toBe("0.1");
    expect(SPEC_COMMIT).toBe("4d0b6d8");
    expect(manifest.specVersion).toBe(SPEC_VERSION);
    expect(manifest.commit).toBe(SPEC_COMMIT);
    expect(manifest.commitFull).toBe(COMMIT_FULL);

    const names = Object.keys(manifest.files).sort();
    expect(names).toEqual(["decision.schema.json", "evidence.schema.json", "policy.schema.json"]);
    const present = readdirSync(SCHEMA_DIR)
      .filter((name) => name.endsWith(".schema.json"))
      .sort();
    expect(present).toEqual(names);

    for (const name of names) {
      const bytes = readFileSync(join(SCHEMA_DIR, name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      const expected = manifest.files[name];
      if (expected === undefined) throw new Error(`manifest is missing ${name}`);
      expect(digest).toBe(expected);
    }
  });

  test("ajv compiles each schema and checks a document", () => {
    const manifest = readManifest();
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validators = new Map<string, ValidateFunction>();
    for (const name of Object.keys(manifest.files)) {
      const validate = ajv.compile(readSchema(name));
      expect(typeof validate).toBe("function");
      validators.set(name, validate);
    }

    const policy: PolicyDocument = {
      specVersion: "0.1",
      items: [
        {
          id: "typecheck",
          kind: "command",
          gate: "beforePR",
          exec: ["bun", "run", "typecheck"],
          timeoutSeconds: 120,
        },
      ],
    };
    const validatePolicy = validators.get("policy.schema.json");
    expectValid(validatePolicy, policy, "policy.schema.json");
    expect(validatePolicy?.({ specVersion: "0.1", nope: true })).toBe(false);

    const command: CommandRecord = {
      specVersion: "0.1",
      recordType: "command",
      itemId: "typecheck",
      base: "a".repeat(40),
      head: "b".repeat(40),
      policyDigest: `sha256:${"c".repeat(64)}`,
      attempt: 1,
      evaluator: { name: "paws", version: "0.1" },
      producer: { name: "paws", version: "0.1" },
      exec: {
        argv: ["bun", "run", "typecheck"],
        exitCode: 0,
        timedOut: false,
        dirty: false,
        headMoved: false,
        durationMs: 1,
        truncated: false,
      },
      artifacts: [],
    };
    const validateEvidence = validators.get("evidence.schema.json");
    expectValid(validateEvidence, command, "evidence.schema.json");

    const review: ReviewRecord = {
      specVersion: "0.1",
      recordType: "review",
      itemId: "adversarial-review",
      base: "a".repeat(40),
      head: "b".repeat(40),
      policyDigest: `sha256:${"c".repeat(64)}`,
      attempt: 1,
      evaluator: { name: "paws", version: "0.1" },
      producer: { session: "reviewer", model: "other", provider: "codex" },
      findings: [
        {
          severity: "P1",
          location: "src/export.ts",
          explanation: "The export drops a column.",
          evidence: "The function returns rows without the archived flag.",
        },
      ],
      artifacts: [],
    };
    expectValid(validateEvidence, review, "evidence.schema.json");

    const decision: DecisionDocument = {
      specVersion: "0.1",
      decision: "accepted",
      gate: "beforePR",
      base: "a".repeat(40),
      head: "b".repeat(40),
      message: "no closeout policy",
      candidate: { session: "implementer", model: "claude", provider: "anthropic" },
      policy: { path: null, digest: null, absent: true },
      items: [],
      warnings: [],
    };
    expectValid(validators.get("decision.schema.json"), decision, "decision.schema.json");
  });

  test("yaml 1.2 rejects duplicate keys", () => {
    const options = { uniqueKeys: true, version: "1.2" } as const;
    expect(parse('specVersion: "0.1"\n', options)).toEqual({ specVersion: "0.1" });
    expect(parse("flag: yes\n", options)).toEqual({ flag: "yes" });
    expect(() => parse("a: 1\na: 2\n", options)).toThrow(YAMLParseError);
    try {
      parse("a: 1\na: 2\n", options);
    } catch (error) {
      expect(error).toBeInstanceOf(YAMLParseError);
      expect((error as YAMLParseError).code).toBe("DUPLICATE_KEY");
    }
  });

  test("resolved policy and ports are constructible", async () => {
    const absent: ResolvedPolicy = {
      source: "none",
      digest: null,
      entryPath: null,
      setup: [],
      items: [],
      files: [],
    };
    expect(absent.digest).toBeNull();

    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(request) {
        calls.push(request.argv.join(" "));
        return {
          argv: request.argv,
          exitCode: 0,
          timedOut: false,
          dirty: false,
          headMoved: false,
          durationMs: 0,
          truncated: false,
          artifacts: [],
        };
      },
    };
    const reviewer: Reviewer = {
      async review() {
        return {
          producer: { session: "s", model: "m", provider: "p" },
          findings: [],
          artifacts: [],
        };
      },
    };
    const store: EvidenceStore = {
      async load() {
        return { records: [] };
      },
      async add() {},
    };
    const result = await runner.run({ cwd: "/work", argv: ["bun", "test"], timeoutSeconds: 30 });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(["bun test"]);
    expect((await store.load()).records).toEqual([]);
    expect((await reviewer.review(sampleReview())).findings).toEqual([]);
  });
});

function sampleReview(): Parameters<Reviewer["review"]>[0] {
  return {
    item: {
      id: "adversarial-review",
      kind: "review",
      gate: "beforePR",
      skill: ".agents/skills/adversarial-review/SKILL.md",
      independence: { differentSession: true, differentModel: true },
      failOn: "P1",
    },
    candidate: { session: "implementer", model: "claude", provider: "anthropic" },
    base: "a".repeat(40),
    head: "b".repeat(40),
    policyDigest: `sha256:${"c".repeat(64)}`,
    worktree: "/work",
  };
}

function readManifest(): Manifest {
  const value: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, "manifest.json"), "utf8"));
  if (!isManifest(value)) throw new Error("schema manifest is not the expected object");
  return value;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.specVersion === "string" &&
    typeof record.commit === "string" &&
    typeof record.commitFull === "string" &&
    typeof record.files === "object" &&
    record.files !== null &&
    Object.values(record.files as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    )
  );
}

function readSchema(name: string): AnySchema {
  const value: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not a schema object`);
  }
  return value;
}

function expectValid(validate: ValidateFunction | undefined, data: unknown, name: string): void {
  if (!validate) throw new Error(`missing validator ${name}`);
  if (!validate(data)) throw new Error(formatErrors(name, validate.errors));
}

function formatErrors(name: string, errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return `${name} rejected the document`;
  return errors.map((error) => `${name} ${error.instancePath} ${error.message ?? ""}`).join("; ");
}
