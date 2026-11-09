import { schema as githubSchema } from "@octokit/graphql-schema";
import { buildSchema, GraphQLSchema, parse, validate, type GraphQLError } from "graphql";
import { Glob, gunzipSync } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Api = "github" | "linear";

export type GraphqlDocument = { file: string; line: number; api: Api; text: string };

export type GraphqlProblem = { file: string; line: number; api: Api; message: string };

const OPERATION = /^\s*(query|mutation|subscription)\b/;
const LITERAL = /`([^`]*)`|"((?:query|mutation)\b[^"\\]*\{[^"\\]*(?:\\.[^"\\]*)*)"/gs;
const INTERPOLATION = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

export function apiForFile(file: string): Api | null {
  if (file.startsWith("src/github/")) return "github";
  if (file.startsWith("src/linear/") || file === "src/doctor/probe.ts") return "linear";
  return null;
}

const VARIANTS: Record<string, Record<string, string>[]> = {
  "src/linear/start-session.ts": [
    { operation: "agentSessionCreateOnIssue", inputType: "AgentSessionCreateOnIssue" },
    { operation: "agentSessionCreateOnComment", inputType: "AgentSessionCreateOnComment" },
  ],
};

function constants(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const declaration =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:`([^`]*)`|"([^"\\]*(?:\\.[^"\\]*)*)"|(\d+)\s*;)/gs;
  for (const match of source.matchAll(declaration))
    found.set(match[1]!, match[2] ?? match[4] ?? JSON.parse(`"${match[3]}"`));
  return found;
}

function resolve(text: string, known: Map<string, string>, depth = 0): string | null {
  if (depth > 5) return null;
  let unresolved = false;
  const expanded = text.replace(INTERPOLATION, (_, name: string) => {
    const value = known.get(name);
    if (value === undefined) {
      unresolved = true;
      return "";
    }
    return resolve(value, known, depth + 1) ?? ((unresolved = true), "");
  });
  return unresolved ? null : expanded;
}

export function documentsIn(
  file: string,
  source: string,
): { documents: GraphqlDocument[]; problems: GraphqlProblem[] } {
  const api = apiForFile(file);
  if (api === null) return { documents: [], problems: [] };
  const shared = constants(source);
  const variants = VARIANTS[file] ?? [{}];
  const documents: GraphqlDocument[] = [];
  const problems: GraphqlProblem[] = [];
  for (const match of source.matchAll(LITERAL)) {
    const raw = match[1] ?? match[2]!;
    if (!OPERATION.test(raw)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    for (const variant of variants) {
      const text = resolve(raw, new Map([...shared, ...Object.entries(variant)]));
      if (text === null) {
        problems.push({
          file,
          line,
          api,
          message: "interpolates a value that is not a constant in this file",
        });
        break;
      }
      documents.push({ file, line, api, text });
    }
  }
  return { documents, problems };
}

export function checkDocument(document: GraphqlDocument, schema: GraphQLSchema): GraphqlProblem[] {
  let errors: readonly GraphQLError[];
  try {
    errors = validate(schema, parse(document.text));
  } catch (error) {
    errors = [error as GraphQLError];
  }
  return errors.map((error) => ({
    file: document.file,
    line: document.line,
    api: document.api,
    message: error.message,
  }));
}

export function loadSchemas(root: string): Record<Api, GraphQLSchema> {
  const linear = gunzipSync(readFileSync(join(root, "scripts/graphql-schemas/linear.graphql.gz")));
  return {
    github: buildSchema(githubSchema.idl, { assumeValidSDL: true }),
    linear: buildSchema(new TextDecoder().decode(linear), { assumeValidSDL: true }),
  };
}

export async function checkRepository(root: string): Promise<GraphqlProblem[]> {
  const schemas = loadSchemas(root);
  const problems: GraphqlProblem[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(root)) {
    if (/\.test\.ts$|(^|\/)fake\.ts$|\/testing\//.test(file)) continue;
    const found = documentsIn(file, await Bun.file(join(root, file)).text());
    problems.push(...found.problems);
    for (const document of found.documents)
      problems.push(...checkDocument(document, schemas[document.api]));
  }
  return problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const problems = await checkRepository(process.cwd());
  for (const problem of problems)
    console.error(`${problem.file}:${problem.line} (${problem.api}) ${problem.message}`);
  if (problems.length > 0) {
    console.error(`${problems.length} GraphQL problem(s) against the published schemas`);
    process.exit(1);
  }
  console.log("GraphQL documents match the GitHub and Linear schemas");
}
