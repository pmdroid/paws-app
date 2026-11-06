type SchemaField = { const?: unknown; enum?: readonly unknown[] };

type SchemaObject = {
  required?: readonly string[];
  properties: Readonly<Record<string, SchemaField>>;
};

export type PolicySchemaDocument = SchemaObject & {
  $defs: Readonly<Record<string, unknown>> & {
    item: { oneOf: readonly { $ref: string }[] };
    rule: SchemaObject;
    setupStep: SchemaObject;
  };
};

export const POLICY_SCHEMA_SUMMARY = `Closeout policy schema (.agents/closeout.yaml). No other keys or kinds exist.
- top level: requires specVersion="0.1"; optional description, retry, imports, items, setup, rules
- items[] kind "command": requires id, gate="beforePR", exec, timeoutSeconds; optional paths, ci, recheck
- items[] kind "review": requires id, gate="beforePR", skill, independence, failOn=P0|P1|P2|P3; optional scope, parallel, minChangedLines, paths, recheck
- items[] kind "evidence": requires id, gate="beforePR"; optional media, minimum, hint, approval, paths, recheck
- items[] kind "preview": requires id, gate="beforePR", approval="human"; optional hint, paths, recheck
- rules[]: requires id, probe, summary, failOn=P0|P1|P2|P3; optional exec, paths, onFail, recheck
- setup[]: requires id, exec, timeoutSeconds; optional paths`;

export function summarizePolicySchema(schema: PolicySchemaDocument): string {
  const kinds = schema.$defs.item.oneOf.map((entry) => {
    const name = entry.$ref.slice(entry.$ref.lastIndexOf("/") + 1);
    return `- items[] kind "${name}": ${fields(schema.$defs[name] as SchemaObject, "kind")}`;
  });
  return [
    "Closeout policy schema (.agents/closeout.yaml). No other keys or kinds exist.",
    `- top level: ${fields(schema)}`,
    ...kinds,
    `- rules[]: ${fields(schema.$defs.rule)}`,
    `- setup[]: ${fields(schema.$defs.setupStep)}`,
  ].join("\n");
}

export function schemaSummaryDrift(
  schema: PolicySchemaDocument,
  summary = POLICY_SCHEMA_SUMMARY,
): string | undefined {
  const generated = summarizePolicySchema(schema);
  return generated === summary
    ? undefined
    : `policy.schema.json changed; set POLICY_SCHEMA_SUMMARY to:\n${generated}`;
}

function fields(object: SchemaObject, skip?: string): string {
  const required = object.required ?? [];
  const names = Object.keys(object.properties).filter((name) => name !== skip);
  const shown = names.filter((name) => required.includes(name)).map((name) => field(object, name));
  const optional = names.filter((name) => !required.includes(name));
  return `requires ${shown.join(", ")}${optional.length > 0 ? `; optional ${optional.join(", ")}` : ""}`;
}

function field(object: SchemaObject, name: string): string {
  const value = object.properties[name];
  if (value?.const !== undefined) return `${name}=${JSON.stringify(value.const)}`;
  if (value?.enum !== undefined) return `${name}=${value.enum.join("|")}`;
  return name;
}
