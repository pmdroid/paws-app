import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv/dist/2020";
import type { EvidenceRecord } from "../types";
import evidenceSchema from "../schema/evidence.schema.json" with { type: "json" };

const schema = readSchema();
const validate: ValidateFunction = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/** A schema-invalid record is not evidence. Callers block instead of skipping the file. */
export function checkEvidence(
  value: unknown,
): { ok: true; record: EvidenceRecord } | { ok: false; message: string } {
  if (validate(value)) return { ok: true, record: value as EvidenceRecord };
  return { ok: false, message: evidenceErrors(validate.errors) };
}

function readSchema(): AnySchema {
  const value: unknown = evidenceSchema;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("evidence.schema.json is not a schema object");
  }
  return value;
}

function evidenceErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "evidence record is invalid";
  return errors
    .map((error) => {
      const where = error.instancePath.length > 0 ? error.instancePath : "/";
      return `${where} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}
