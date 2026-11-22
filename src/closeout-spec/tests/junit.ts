import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { FailedTest } from "./types";

export const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export type JunitReport =
  | { ok: true; cases: number; failures: FailedTest[] }
  | { ok: false; message: string };

type Node = Record<string, unknown>;

const LISTS = new Set(["testsuite", "testcase", "failure", "error"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
  parseTagValue: false,
  isArray: (name) => LISTS.has(name),
});

export function parseJunit(text: string): JunitReport {
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
    return { ok: false, message: "is larger than 8 MB" };
  }
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) {
    return { ok: false, message: "declares a DTD or entities" };
  }
  const valid = XMLValidator.validate(text);
  if (valid !== true) return { ok: false, message: `is not valid XML: ${valid.err.msg}` };
  const document = parser.parse(text) as Node;
  const root = document.testsuites;
  const suites = lists(isNode(root) ? root.testsuite : document.testsuite);
  if (root === undefined && suites.length === 0) return { ok: false, message: "has no testsuite" };
  const found = { cases: 0, failures: [] as FailedTest[] };
  for (const suite of suites) walk(suite, undefined, found);
  return { ok: true, ...found };
}

function walk(
  suite: Node,
  parentFile: string | undefined,
  found: { cases: number; failures: FailedTest[] },
): number {
  const file = decoded(suite.file) ?? parentFile;
  let errors = 0;
  for (const testcase of lists(suite.testcase)) {
    found.cases += 1;
    const caseFile = decoded(testcase.file) ?? file;
    const name = [decoded(testcase.classname), decoded(testcase.name)].filter(Boolean).join(" > ");
    for (const [key, kind] of [
      ["failure", "failed"],
      ["error", "error"],
    ] as const) {
      for (const entry of lists(testcase[key])) {
        if (kind === "error") errors += 1;
        found.failures.push({
          ...(caseFile ? { file: caseFile } : {}),
          ...(name ? { name } : {}),
          message: decoded(entry.message) ?? decoded(entry["#text"]) ?? kind,
          kind,
        });
      }
    }
  }
  for (const child of lists(suite.testsuite)) errors += walk(child, file, found);
  const missing = Number(decoded(suite.errors) ?? 0) - errors;
  if (missing > 0) {
    found.failures.push({
      ...(file ? { file } : {}),
      message: `${missing} error${missing === 1 ? "" : "s"} outside any test`,
      kind: "skipped-crash",
    });
  }
  return Math.max(errors, errors + missing);
}

function lists(value: unknown): Node[] {
  return (Array.isArray(value) ? value : []).map((entry) =>
    isNode(entry) ? entry : { "#text": entry },
  );
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decoded(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, ref: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (ref[0] !== "#") return named[ref.toLowerCase()] ?? "";
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
