import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  apiForFile,
  checkDocument,
  checkRepository,
  documentsIn,
  loadSchemas,
} from "../scripts/check-graphql";

const root = join(import.meta.dir, "..");
const schemas = loadSchemas(root);

test("a GitHub field that does not exist fails, as Commit.pushedAt did in #1550", () => {
  const problems = checkDocument(
    {
      file: "src/github/acme.ts",
      line: 1,
      api: "github",
      text: `query AcmeReadiness($head: GitObjectID!) {
        repository(owner: "acme", name: "app") { object(oid: $head) { ... on Commit { oid pushedAt } } }
      }`,
    },
    schemas.github,
  );
  expect(problems.map((problem) => problem.message)).toEqual([
    'Cannot query field "pushedAt" on type "Commit". Did you mean "pushedDate"?',
  ]);
});

test("a valid Linear query passes", () => {
  const problems = checkDocument(
    {
      file: "src/linear/acme.ts",
      line: 1,
      api: "linear",
      text: 'query AcmeIssue { issue(id: "ACME-1") { id identifier state { type } } }',
    },
    schemas.linear,
  );
  expect(problems).toEqual([]);
});

test("documents resolve string and number constants from the same file", () => {
  const source = [
    "const LIMIT = 50;",
    'const FIELDS = "id identifier";',
    "const query = `query AcmeIssues { issues(first: ${LIMIT}) { nodes { ${FIELDS} } } }`;",
  ].join("\n");
  const found = documentsIn("src/linear/acme.ts", source);
  expect(found.problems).toEqual([]);
  expect(found.documents.map((document) => document.text)).toEqual([
    "query AcmeIssues { issues(first: 50) { nodes { id identifier } } }",
  ]);
});

test("an interpolated value that is not a constant is reported, not skipped", () => {
  const source = "const run = (name: string) => `query Acme { ${name} { id } }`;";
  expect(documentsIn("src/linear/acme.ts", source).problems).toEqual([
    {
      file: "src/linear/acme.ts",
      line: 1,
      api: "linear",
      message: "interpolates a value that is not a constant in this file",
    },
  ]);
});

test("only GitHub and Linear modules are checked", () => {
  expect(apiForFile("src/github/readiness.ts")).toBe("github");
  expect(apiForFile("src/linear/sessions.ts")).toBe("linear");
  expect(apiForFile("src/doctor/probe.ts")).toBe("linear");
  expect(apiForFile("src/merge/advance.ts")).toBeNull();
});

test("every GitHub and Linear document in src matches the published schemas", async () => {
  expect(await checkRepository(root)).toEqual([]);
});
