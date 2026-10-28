/**
 * Closeout rule `api-contract`.
 *
 * Builds the API contract at the base and at the candidate and compares them:
 *
 * - `runner-protocol`: every zod schema exported by `src/runner-protocol`, as JSON Schema.
 *   A runner and Paws are updated separately and the protocol has no version.
 * - `status`: the exported interfaces and object types of `src/web/src/contract.ts`
 *   (the status snapshot) and its exported constants (paths, state lists).
 * - `route`: the HTTP routes Paws serves, read from the request branches under `src/`
 *   (`path === "/api/..."`, `path.startsWith(...)`, with the `request.method` checked
 *   in the same condition or inside the branch). `*` is any method.
 *
 * A removed schema, field, value, type or route, a field that became required or a
 * new required field in a runner schema, a status field that became optional, and a
 * narrowed type are breaking. Additions are not.
 *
 * Runs as `bun api-contract.ts --base <sha> --head <sha> --repo <checkout>` with the
 * candidate checked out at `--head` and its dependencies installed. The base tree is
 * read from git. Exits 0 when nothing breaks and 1 otherwise, listing each break.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Field = { optional: boolean; type: Shape };
type Shape = { union: string[]; fields?: Record<string, Field>; items?: Shape };
type Declaration = Shape & { extends: string[] };
type Contract = {
  schemas: Record<string, Json>;
  constants: Record<string, Json>;
  status: Record<string, Declaration>;
  routes: string[];
};
type Change = { surface: string; name: string; kind: string };

const PROTOCOL = "src/runner-protocol/index.ts";
const STATUS = "src/web/src/contract.ts";
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    repo: { type: "string" },
    extract: { type: "string" },
  },
  strict: true,
});

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}\n${err}`);
  return out;
}

// --- Extraction: runs in a child process with the tree to read as `--extract`.

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item);
    if (isNode(value)) found.push(value);
  }
  return found;
}

function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const child of children(node)) walk(child, visit, ancestors);
  ancestors.pop();
}

function text(source: string, node: Node): string {
  return source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
}

function keyName(node: Node): string | null {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal") return String(node.value);
  return null;
}

function members(source: string, nodes: Node[]): Record<string, Field> {
  const fields: Record<string, Field> = {};
  for (const member of nodes) {
    if (member.type !== "TSPropertySignature" || member.computed) continue;
    const name = keyName(member.key as Node);
    const annotation = member.typeAnnotation as Node | null;
    if (name === null || !annotation) continue;
    fields[name] = {
      optional: member.optional === true,
      type: shape(source, annotation.typeAnnotation as Node),
    };
  }
  return fields;
}

function shape(source: string, node: Node): Shape {
  while (node.type === "TSParenthesizedType") node = node.typeAnnotation as Node;
  const result: Shape = { union: [] };
  for (const member of node.type === "TSUnionType" ? (node.types as Node[]) : [node]) {
    let inner = member;
    while (inner.type === "TSParenthesizedType") inner = inner.typeAnnotation as Node;
    if (inner.type === "TSTypeLiteral") {
      result.union.push("{…}");
      result.fields = { ...result.fields, ...members(source, inner.members as Node[]) };
    } else if (inner.type === "TSArrayType") {
      result.union.push("[…]");
      result.items = shape(source, inner.elementType as Node);
    } else result.union.push(text(source, inner));
  }
  return result;
}

function statusShapes(source: string, program: Node): Record<string, Declaration> {
  const shapes: Record<string, Declaration> = {};
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ExportNamedDeclaration" || !isNode(statement.declaration)) continue;
    const declaration = statement.declaration;
    const name = (declaration.id as Node | undefined)?.name as string | undefined;
    if (!name) continue;
    if (declaration.type === "TSInterfaceDeclaration") {
      const heritage = (declaration.extends as Node[] | undefined) ?? [];
      shapes[name] = {
        union: ["{…}"],
        fields: members(source, (declaration.body as Node).body as Node[]),
        extends: heritage.map((item) => text(source, item)),
      };
    } else if (declaration.type === "TSTypeAliasDeclaration") {
      shapes[name] = { ...shape(source, declaration.typeAnnotation as Node), extends: [] };
    }
  }
  return shapes;
}

function sourceFiles(root: string, dir: string): Promise<string[]> {
  return readdir(join(root, dir), { recursive: true }).then((names) =>
    names
      .map((name) => join(dir, name))
      .filter(
        (path) =>
          path.endsWith(".ts") &&
          !path.endsWith(".d.ts") &&
          !/\.test\.ts$/.test(path) &&
          !path.startsWith("src/web/src/client/") &&
          !path.includes("/test/") &&
          !path.includes("/fixtures/"),
      ),
  );
}

/**
 * The name an incoming request path is read through: `path`, `pathname`, `url.pathname`.
 * `request.path` is an outgoing GitHub API request, not a route.
 */
function isPathRead(node: Node): boolean {
  if (node.type === "Identifier") return /^(path|pathname)$/.test(node.name as string);
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    (node.property as Node).name === "pathname"
  );
}

function isMethodRead(node: Node): boolean {
  if (node.type === "Identifier") return node.name === "method";
  return (
    node.type === "MemberExpression" && !node.computed && (node.property as Node).name === "method"
  );
}

function isFunction(node: Node): boolean {
  return /Function|ArrowFunction/.test(node.type);
}

/** Module-level `const NAME = "/api/..."`, by name across files. */
function routeConstants(program: Node, into: Map<string, Set<string>>) {
  for (let statement of program.body as Node[]) {
    if (statement.type === "ExportNamedDeclaration" && isNode(statement.declaration))
      statement = statement.declaration;
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declarator of statement.declarations as Node[]) {
      const id = declarator.id as Node;
      const init = declarator.init as Node | null;
      if (id.type !== "Identifier" || !init) continue;
      const value = literal(init, new Map());
      if (value === null || !value.startsWith("/")) continue;
      const known = into.get(id.name as string) ?? new Set<string>();
      known.add(value);
      into.set(id.name as string, known);
    }
  }
}

function literal(node: Node, constants: Map<string, Set<string>>): string | null {
  while (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
    node = node.expression as Node;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as Node[]).length === 0)
    return String(((node.quasis as Node[])[0]!.value as { cooked: string }).cooked);
  if (node.type === "Identifier") {
    const known = constants.get(node.name as string);
    if (known?.size === 1) return [...known][0]!;
  }
  return null;
}

/** Route paths a condition tests, without descending into nested functions. */
function pathsIn(test: Node, constants: Map<string, Set<string>>): string[] {
  const paths: string[] = [];
  const visit = (node: Node) => {
    if (isFunction(node)) return;
    if (node.type === "BinaryExpression" && /^[!=]==?$/.test(node.operator as string)) {
      for (const [read, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as [Node, Node][]) {
        const value = isPathRead(read) ? literal(other, constants) : null;
        if (value?.startsWith("/")) paths.push(value);
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const [argument] = node.arguments as Node[];
      if (
        callee.type === "MemberExpression" &&
        (callee.property as Node).name === "startsWith" &&
        isPathRead(callee.object as Node) &&
        argument
      ) {
        const value = literal(argument, constants);
        // `path.startsWith("/")` checks a file path is absolute.
        if (value?.startsWith("/") && value !== "/") paths.push(`${value}*`);
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(test);
  return paths;
}

function methodsIn(test: Node): string[] {
  const methods: string[] = [];
  const visit = (node: Node) => {
    if (isFunction(node)) return;
    if (node.type === "BinaryExpression" && /^===?$/.test(node.operator as string)) {
      for (const [read, other] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as [Node, Node][]) {
        if (isMethodRead(read) && other.type === "Literal" && METHODS.has(String(other.value)))
          methods.push(String(other.value));
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(test);
  return methods;
}

/** Methods checked by conditions inside a branch that test no path of their own. */
function methodsBelow(branch: Node, constants: Map<string, Set<string>>): string[] {
  const methods: string[] = [];
  walk(branch, (node) => {
    if (node.type !== "IfStatement" && node.type !== "ConditionalExpression") return;
    const test = node.test as Node;
    if (pathsIn(test, constants).length === 0) methods.push(...methodsIn(test));
  });
  return methods;
}

/**
 * Routes tested by `if`, `?:` and `switch` conditions, and by `&&` / `||` expressions
 * outside them (`return path === X && request.method === "GET"`).
 */
function routesIn(program: Node, constants: Map<string, Set<string>>, into: Set<string>) {
  const add = (paths: string[], methods: string[]) => {
    for (const path of paths)
      for (const method of methods.length ? methods : ["*"]) into.add(`${method} ${path}`);
  };
  walk(program, (node, ancestors) => {
    if (node.type === "SwitchStatement" && isPathRead(node.discriminant as Node)) {
      for (const branch of node.cases as Node[]) {
        const value = branch.test ? literal(branch.test as Node, constants) : null;
        if (value?.startsWith("/")) into.add(`* ${value}`);
      }
    } else if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      const test = node.test as Node;
      const paths = pathsIn(test, constants);
      if (paths.length === 0) return;
      const methods = methodsIn(test);
      add(paths, methods.length ? methods : methodsBelow(node.consequent as Node, constants));
    } else if (node.type === "LogicalExpression") {
      const parent = ancestors.at(-1);
      if (parent?.type === "LogicalExpression") return;
      const inTest = ancestors.some(
        (above, index) =>
          (above.type === "IfStatement" || above.type === "ConditionalExpression") &&
          (above.test === node || above.test === ancestors[index + 1]),
      );
      if (!inTest) add(pathsIn(node, constants), methodsIn(node));
    }
  });
}

async function extractRoutes(root: string): Promise<string[]> {
  if (!existsSync(join(root, "src"))) return [];
  const { parseSync } = (await import(Bun.resolveSync("oxc-parser", root))) as {
    parseSync: (file: string, source: string) => { program: Node };
  };
  const files = await sourceFiles(root, "src");
  const programs = await Promise.all(
    files.map(async (file) => parseSync(file, await readFile(join(root, file), "utf8")).program),
  );
  const constants = new Map<string, Set<string>>();
  for (const program of programs) routeConstants(program, constants);
  const routes = new Set<string>();
  for (const program of programs) routesIn(program, constants, routes);
  return [...routes].sort();
}

async function extract(root: string): Promise<Contract> {
  const contract: Contract = { schemas: {}, constants: {}, status: {}, routes: [] };
  if (existsSync(join(root, PROTOCOL))) {
    const { z } = (await import(Bun.resolveSync("zod", root))) as typeof import("zod");
    const protocol = (await import(join(root, PROTOCOL))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(protocol))
      if (value instanceof z.ZodType)
        contract.schemas[name] = z.toJSONSchema(value, { unrepresentable: "any" }) as Json;
  }
  if (existsSync(join(root, STATUS))) {
    const status = (await import(join(root, STATUS))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(status))
      if (typeof value === "string" || typeof value === "number" || Array.isArray(value))
        contract.constants[name] = value as Json;
    const { parseSync } = (await import(Bun.resolveSync("oxc-parser", root))) as {
      parseSync: (file: string, source: string) => { program: Node };
    };
    const source = await readFile(join(root, STATUS), "utf8");
    contract.status = statusShapes(source, parseSync(STATUS, source).program);
  }
  contract.routes = await extractRoutes(root);
  return contract;
}

if (values.extract !== undefined) {
  await Bun.write(Bun.stdout, JSON.stringify(await extract(values.extract)));
  process.exit(0);
}

// --- Comparison.

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function types(schema: { [key: string]: Json }): Set<string> {
  const type = schema.type;
  if (typeof type === "string") return new Set([type]);
  if (Array.isArray(type)) return new Set(type.map(String));
  return new Set();
}

function tag(variant: Json): string {
  if (isObject(variant) && isObject(variant.properties)) {
    for (const key of ["type", "kind"]) {
      const field = variant.properties[key];
      if (isObject(field) && typeof field.const === "string") return `${key}=${field.const}`;
    }
  }
  return JSON.stringify(variant);
}

function variants(schema: { [key: string]: Json }): Map<string, Json> {
  const list = schema.anyOf ?? schema.oneOf;
  return new Map(Array.isArray(list) ? list.map((item) => [tag(item), item]) : []);
}

type Found = (at: string, kind: string) => void;
type Added = (at: string) => void;

/** Compares two JSON Schemas the way a reader of `base` sees a value written to `next`. */
function compareSchema(base: Json, next: Json, at: string, found: Found, added: Added): void {
  if (!isObject(base) || !isObject(next)) return;
  const nextTypes = types(next);
  const removedTypes = [...types(base)].filter(
    (type) =>
      nextTypes.size > 0 &&
      !nextTypes.has(type) &&
      !(type === "integer" && nextTypes.has("number")),
  );
  if (removedTypes.length) found(at, `narrowed: ${removedTypes.join(", ")} no longer accepted`);
  if (base.const !== undefined && next.const !== undefined && base.const !== next.const)
    found(at, `narrowed: ${JSON.stringify(base.const)} no longer accepted`);
  else if (base.const === undefined && base.enum === undefined) {
    if (next.const !== undefined)
      found(at, `narrowed: only ${JSON.stringify(next.const)} accepted`);
    else if (Array.isArray(next.enum))
      found(
        at,
        `narrowed: only ${next.enum.map((item) => JSON.stringify(item)).join(", ")} accepted`,
      );
  }
  if (Array.isArray(base.enum) && Array.isArray(next.enum)) {
    const kept = new Set(next.enum.map((item) => JSON.stringify(item)));
    for (const value of base.enum)
      if (!kept.has(JSON.stringify(value))) found(at, `narrowed: ${JSON.stringify(value)} removed`);
  }
  const before = variants(base);
  const after = variants(next);
  const keys = [...before.keys()];
  for (const [key, variant] of before) {
    const match = after.get(key);
    if (match === undefined)
      found(at, `variant ${key.length > 40 ? `#${keys.indexOf(key)}` : key} removed`);
    else compareSchema(variant, match, `${at}<${key}>`, found, added);
  }
  for (const key of after.keys()) if (!before.has(key)) added(`${at}<${key}>`);
  const props = isObject(base.properties) ? base.properties : {};
  const nextProps = isObject(next.properties) ? next.properties : {};
  const required = new Set(Array.isArray(base.required) ? base.required.map(String) : []);
  for (const key of Object.keys(props)) {
    if (!(key in nextProps)) found(`${at}.${key}`, "removed");
    else compareSchema(props[key]!, nextProps[key]!, `${at}.${key}`, found, added);
  }
  for (const key of Object.keys(nextProps)) if (!(key in props)) added(`${at}.${key}`);
  for (const key of Array.isArray(next.required) ? next.required.map(String) : [])
    if (!required.has(key))
      found(`${at}.${key}`, key in props ? "became required" : "required field added");
  if (base.items !== undefined && next.items !== undefined)
    compareSchema(base.items, next.items, `${at}[]`, found, added);
}

/** Compares two status snapshot shapes the way the dashboard reads a snapshot. */
function compareShape(base: Shape, next: Shape, at: string, found: Found, added: Added): void {
  const kept = new Set(next.union);
  const removed = base.union.filter((member) => !kept.has(member));
  if (removed.length) found(at, `narrowed: ${removed.join(" | ")} no longer accepted`);
  for (const member of next.union) if (!base.union.includes(member)) added(`${at} | ${member}`);
  const fields = base.fields ?? {};
  const nextFields = next.fields ?? {};
  for (const [key, field] of Object.entries(fields)) {
    const after = nextFields[key];
    if (after === undefined) {
      found(`${at}.${key}`, "removed");
      continue;
    }
    if (!field.optional && after.optional) found(`${at}.${key}`, "became optional");
    compareShape(field.type, after.type, `${at}.${key}`, found, added);
  }
  for (const key of Object.keys(nextFields)) if (!(key in fields)) added(`${at}.${key}`);
  if (base.items && next.items) compareShape(base.items, next.items, `${at}[]`, found, added);
}

function routeKey(route: string): [string, string] {
  const space = route.indexOf(" ");
  return [route.slice(0, space), route.slice(space + 1)];
}

function diff(base: Contract, next: Contract): { breaks: Change[]; additions: string[] } {
  const breaks: Change[] = [];
  const additions: string[] = [];
  const surface = (name: string) => ({
    found: (prefix: string) => (at: string, kind: string) =>
      breaks.push({ surface: name, name: `${prefix}${at}`, kind }),
    added: (prefix: string) => (at: string) => additions.push(`${name}\t${prefix}${at}`),
  });

  const protocol = surface("runner-protocol");
  for (const [name, schema] of Object.entries(base.schemas)) {
    if (!(name in next.schemas))
      breaks.push({ surface: "runner-protocol", name, kind: "schema removed" });
    else compareSchema(schema, next.schemas[name]!, "", protocol.found(name), protocol.added(name));
  }
  for (const name of Object.keys(next.schemas))
    if (!(name in base.schemas)) additions.push(`runner-protocol\t${name}`);

  const status = surface("status");
  for (const [name, declaration] of Object.entries(base.status)) {
    const after = next.status[name];
    if (after === undefined) {
      breaks.push({ surface: "status", name, kind: "type removed" });
      continue;
    }
    for (const parent of declaration.extends)
      if (!after.extends.includes(parent))
        breaks.push({ surface: "status", name, kind: `no longer extends ${parent}` });
    compareShape(declaration, after, "", status.found(name), status.added(name));
  }
  for (const name of Object.keys(next.status))
    if (!(name in base.status)) additions.push(`status\t${name}`);

  for (const [name, value] of Object.entries(base.constants)) {
    const after = next.constants[name];
    if (after === undefined) breaks.push({ surface: "status", name, kind: "export removed" });
    else if (Array.isArray(value) && Array.isArray(after)) {
      const kept = new Set(after.map((item) => JSON.stringify(item)));
      for (const item of value)
        if (!kept.has(JSON.stringify(item)))
          breaks.push({ surface: "status", name, kind: `value ${JSON.stringify(item)} removed` });
      const had = new Set(value.map((item) => JSON.stringify(item)));
      for (const item of after)
        if (!had.has(JSON.stringify(item)))
          additions.push(`status\t${name}\t${JSON.stringify(item)}`);
    } else if (JSON.stringify(value) !== JSON.stringify(after)) {
      breaks.push({
        surface: "status",
        name,
        kind: `changed from ${JSON.stringify(value)} to ${JSON.stringify(after)}`,
      });
    }
  }
  for (const name of Object.keys(next.constants))
    if (!(name in base.constants)) additions.push(`status\t${name}`);

  const routes = new Set(next.routes);
  for (const route of base.routes) {
    const [method, path] = routeKey(route);
    if (routes.has(route) || routes.has(`* ${path}`)) continue;
    const others = next.routes.filter((item) => routeKey(item)[1] === path);
    breaks.push({
      surface: "route",
      name: route,
      kind: others.length
        ? `${method === "*" ? "any method" : method} no longer served; now ${others.map((item) => routeKey(item)[0]).join(", ")}`
        : "removed",
    });
  }
  const had = new Set(base.routes);
  for (const route of next.routes) if (!had.has(route)) additions.push(`route\t${route}`);
  return { breaks, additions };
}

// --- Main.

if (!values.base || !values.head || !values.repo) {
  console.error("usage: api-contract.ts --base <sha> --head <sha> --repo <candidate checkout>");
  process.exit(2);
}
const repo = values.repo;

async function commit(sha: string): Promise<string> {
  return (
    await run(["git", "rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`], repo)
  ).trim();
}

async function baseTree(sha: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "api-contract-base-"));
  const archive = join(dir, "..", `${relative(tmpdir(), dir)}.tar`);
  try {
    await run(["git", "archive", "--format=tar", `--output=${archive}`, sha], repo);
    await run(["tar", "-xf", archive, "-C", dir], repo);
  } finally {
    await rm(archive, { force: true });
  }
  if (existsSync(join(repo, "node_modules")))
    await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
  return dir;
}

async function contractAt(root: string): Promise<Contract> {
  const out = await run([process.execPath, import.meta.path, "--extract", root], root);
  return JSON.parse(out) as Contract;
}

const head = await commit(values.head);
const actual = await commit("HEAD");
if (actual !== head) {
  console.error(`candidate is at ${actual}, expected ${head}`);
  process.exit(2);
}
const baseDir = await baseTree(await commit(values.base));
try {
  const [before, after] = await Promise.all([contractAt(baseDir), contractAt(repo)]);
  const { breaks, additions } = diff(before, after);
  for (const change of breaks) console.log(`${change.surface}\t${change.name}\t${change.kind}`);
  for (const addition of additions) console.log(`${addition}\tadded`);
  console.log(
    `${breaks.length} breaking changes · ${additions.length} additive · ` +
      `${after.routes.length} routes, ${Object.keys(after.schemas).length} runner schemas, ` +
      `${Object.keys(after.status).length} status types`,
  );
  process.exitCode = breaks.length ? 1 : 0;
} finally {
  await rm(baseDir, { recursive: true, force: true });
}
