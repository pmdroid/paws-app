import { expect, test } from "bun:test";
import policySchema from "../schema/policy.schema.json" with { type: "json" };
import {
  POLICY_SCHEMA_SUMMARY,
  schemaSummaryDrift,
  type PolicySchemaDocument,
} from "./schema-summary";

const schema = policySchema as unknown as PolicySchemaDocument;

test("the summary is the one policy.schema.json generates", () => {
  expect(schemaSummaryDrift(schema)).toBeUndefined();
  for (const kind of ["command", "review", "evidence", "preview"])
    expect(POLICY_SCHEMA_SUMMARY).toContain(`items[] kind "${kind}"`);
  expect(POLICY_SCHEMA_SUMMARY).toContain("rules[]: requires id, probe, summary, failOn=");
});

test("a kind added to the schema without the summary following is drift", () => {
  const fixture = structuredClone(schema) as PolicySchemaDocument & {
    $defs: Record<string, unknown>;
  };
  fixture.$defs.approval = {
    type: "object",
    required: ["id", "kind", "approvers"],
    properties: { id: {}, kind: { const: "approval" }, approvers: {} },
  };
  fixture.$defs.item.oneOf = [...fixture.$defs.item.oneOf, { $ref: "#/$defs/approval" }];
  const drift = schemaSummaryDrift(fixture);
  expect(drift).toContain('items[] kind "approval": requires id, approvers');
  expect(schemaSummaryDrift(fixture, drift?.slice(drift.indexOf("\n") + 1))).toBeUndefined();
});
