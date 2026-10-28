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
 * narrowed type are breaking. Optional event fields and new routes are additive. New
 * command fields and variants also protect older strict command readers.
 *
 * Runs as `bun api-contract.ts --base <sha> --head <sha> --repo <checkout>` with the
 * candidate checked out at `--head`. Dependencies must be in Bun's offline cache. Both trees are
 * read from git. Exits 0 when nothing breaks and 1 otherwise, listing each break.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

// --- Static extraction. Source expressions are never imported or executed.

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
  if (!node) return null;
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
    if (node.type === "BinaryExpression" && /^[!=]==?$/.test(node.operator as string)) {
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
 * Routes tested by `if`, `?:`, `switch` and anchored regular expressions in Request handlers.
 * Bare boolean classifiers are excluded.
 */
function routesIn(program: Node, constants: Map<string, Set<string>>, into: Set<string>) {
  const add = (paths: string[], methods: string[]) => {
    for (const path of paths)
      for (const method of methods.length ? methods : ["*"]) into.add(`${method} ${path}`);
  };
  walk(program, (node, ancestors) => {
    const handler = ancestors.findLast(isFunction);
    if (!handler) return;
    const request = ((handler.params as Node[]) ?? []).some((param) => {
      const annotation = param.typeAnnotation as Node | undefined;
      return annotation && JSON.stringify(annotation).includes('"Request"');
    });
    if (!request) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const argument = (node.arguments as Node[])[0];
      if (
        callee.type === "MemberExpression" &&
        ["exec", "test"].includes(String((callee.property as Node).name)) &&
        argument &&
        isPathRead(argument)
      ) {
        const re = (callee.object as Node).regex as { pattern: string; flags: string } | undefined;
        if (re?.pattern.startsWith("^\\/"))
          add([`regex:/${re.pattern}/${re.flags}`], methodsBelow(handler.body as Node, constants));
      }
    }
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
      const negativeGuard =
        test.type === "BinaryExpression" && String(test.operator).startsWith("!");
      add(
        paths,
        methods.length
          ? methods
          : methodsBelow(
              negativeGuard ? (handler.body as Node) : (node.consequent as Node),
              constants,
            ),
      );
    }
  });
}

/** Only this interpreter calls trusted Zod constructors. Candidate expressions are data. */
async function staticContract(
  root: string,
  parseSync: Parser,
  z: typeof import("zod").z,
): Promise<Contract> {
  const programs = new Map<string, { source: string; program: Node }>();
  for (const file of await sourceFiles(root, "src")) {
    const source = await readFile(join(root, file), "utf8");
    const parsed = parseSync(file, source);
    if (parsed.errors?.length) throw new Error(`Cannot parse ${file}`);
    programs.set(file, { source, program: parsed.program });
  }
  const cache = new Map<string, unknown>();
  const active = new Set<string>();
  const resolveFile = (file: string, spec: string) => {
    const path = join(dirname(file), spec);
    for (const next of [path, `${path}.ts`, join(path, "index.ts")])
      if (programs.has(next)) return next;
    throw new Error(`Unresolved contract import ${file}: ${spec}`);
  };
  const declarations = new Map<string, Map<string, Node>>();
  const imports = new Map<string, Map<string, { file: string; name: string }>>();
  for (const [file, { program }] of programs) {
    const locals = new Map<string, Node>();
    const bindings = new Map<string, { file: string; name: string }>();
    for (let statement of program.body as Node[]) {
      if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
        const spec = String((statement.source as Node).value);
        for (const binding of statement.specifiers as Node[]) {
          if (binding.importKind === "type") continue;
          const name = String((binding.local as Node).name);
          if (spec === "zod" && name === "z") bindings.set(name, { file: "zod", name: "z" });
          else if (spec.startsWith("."))
            bindings.set(name, {
              file: join(dirname(file), spec),
              name: keyName(binding.imported as Node) ?? "default",
            });
        }
      }
      if (statement.type === "ExportNamedDeclaration" && isNode(statement.declaration))
        statement = statement.declaration;
      if (statement.type === "VariableDeclaration")
        for (const declaration of statement.declarations as Node[])
          if ((declaration.id as Node).type === "Identifier")
            locals.set(String((declaration.id as Node).name), declaration.init as Node);
      if (statement.type === "FunctionDeclaration")
        locals.set(String((statement.id as Node).name), statement);
    }
    declarations.set(file, locals);
    imports.set(file, bindings);
  }
  type Helper = { helper: Node; file: string };
  const forbidden = new Set(["__proto__", "prototype", "constructor"]);
  let budget = 100_000;
  function lookup(file: string, name: string): unknown {
    const key = `${file}:${name}`;
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) throw new Error(`Circular contract declaration ${key}`);
    active.add(key);
    try {
      const binding = imports.get(file)?.get(name);
      let value: unknown;
      if (binding?.file === "zod") value = z;
      else if (binding)
        value = lookup(resolveFile(file, relative(dirname(file), binding.file)), binding.name);
      else {
        const node = declarations.get(file)?.get(name);
        if (!node) throw new Error(`Unknown contract declaration ${key}`);
        value = evaluate(node, file, new Map());
      }
      cache.set(key, value);
      return value;
    } finally {
      active.delete(key);
    }
  }
  const constructors = new Set([
    "string",
    "number",
    "boolean",
    "unknown",
    "any",
    "never",
    "null",
    "undefined",
    "literal",
    "enum",
    "object",
    "strictObject",
    "looseObject",
    "array",
    "union",
    "discriminatedUnion",
    "record",
    "tuple",
    "url",
    "uuid",
  ]);
  const methods = new Set([
    "optional",
    "nullable",
    "nullish",
    "array",
    "int",
    "min",
    "max",
    "length",
    "nonnegative",
    "positive",
    "negative",
    "nonpositive",
    "regex",
    "email",
    "url",
    "uuid",
    "trim",
    "omit",
    "pick",
    "extend",
    "partial",
    "required",
    "strict",
    "passthrough",
    "default",
    "or",
    "and",
  ]);
  function evaluate(node: Node, file: string, scope: Map<string, unknown>): unknown {
    if (--budget < 0) throw new Error("Contract expression budget exceeded");
    if (!isNode(node)) throw new Error(`Missing contract expression in ${file}`);
    if (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type))
      return evaluate(node.expression as Node, file, scope);
    if (node.type === "Literal") {
      if (node.regex) {
        const re = node.regex as { pattern: string; flags: string };
        return new RegExp(re.pattern, re.flags);
      }
      return node.value;
    }
    if (node.type === "Identifier")
      return scope.has(String(node.name))
        ? scope.get(String(node.name))
        : lookup(file, String(node.name));
    if (
      ["FunctionDeclaration", "ArrowFunctionExpression", "FunctionExpression"].includes(node.type)
    )
      return { helper: node, file } satisfies Helper;
    if (node.type === "ArrayExpression")
      return (node.elements as Node[]).flatMap((item) =>
        item.type === "SpreadElement"
          ? (evaluate(item.argument as Node, file, scope) as unknown[])
          : [evaluate(item, file, scope)],
      );
    if (node.type === "ObjectExpression") {
      const object: Record<string, unknown> = Object.create(null);
      for (const prop of node.properties as Node[]) {
        if (prop.type === "SpreadElement")
          Object.assign(object, evaluate(prop.argument as Node, file, scope));
        else {
          const key = keyName(prop.key as Node);
          if (!key || prop.computed || prop.method || prop.kind !== "init" || forbidden.has(key))
            throw new Error(`Unsupported contract property in ${file}`);
          object[key] = evaluate(prop.value as Node, file, scope);
        }
      }
      return object;
    }
    if (node.type === "MemberExpression" && !node.computed) {
      const key = String((node.property as Node).name);
      if (
        (node.object as Node).type === "Identifier" &&
        (node.object as Node).name === "Number" &&
        key === "MAX_SAFE_INTEGER"
      )
        return Number.MAX_SAFE_INTEGER;
      const receiver = evaluate(node.object as Node, file, scope);
      if (forbidden.has(key)) throw new Error("Forbidden contract property");
      if (receiver instanceof z.ZodType && key === "shape")
        return (receiver as import("zod").ZodObject).shape;
      if (Array.isArray(receiver) && key === "length") return receiver.length;
      if (receiver && Object.hasOwn(receiver, key))
        return (receiver as Record<string, unknown>)[key];
      throw new Error(`Unsupported contract property ${key}`);
    }
    if (node.type === "BinaryExpression") {
      const a = evaluate(node.left as Node, file, scope),
        b = evaluate(node.right as Node, file, scope);
      if (typeof a !== "number" || typeof b !== "number")
        throw new Error("Contract arithmetic requires numbers");
      switch (node.operator) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "**":
          return a ** b;
      }
    }
    if (node.type === "UnaryExpression" && node.operator === "-") {
      const value = evaluate(node.argument as Node, file, scope);
      if (typeof value === "number") return -value;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "MemberExpression" && !callee.computed) {
        const receiver = evaluate(callee.object as Node, file, scope);
        const method = String((callee.property as Node).name);
        // These callbacks affect output or impose custom refinements. Never execute them.
        if (
          receiver instanceof z.ZodType &&
          ["transform", "pipe", "refine", "superRefine"].includes(method)
        )
          return receiver;
        if (
          (receiver === z && constructors.has(method)) ||
          (receiver instanceof z.ZodType && methods.has(method))
        ) {
          const args = (node.arguments as Node[]).map((argument) =>
            evaluate(argument, file, scope),
          );
          return (receiver as unknown as Record<string, (...args: unknown[]) => unknown>)[
            method
          ]!.apply(receiver, args);
        }
      } else if (callee.type === "Identifier") {
        const helper = evaluate(callee, file, scope) as Helper;
        if (helper && isNode(helper.helper)) {
          const body = helper.helper.body as Node;
          const returns =
            body.type === "BlockStatement"
              ? (body.body as Node[]).filter((item) => item.type === "ReturnStatement")
              : [];
          if (
            body.type === "BlockStatement" &&
            ((body.body as Node[]).length !== 1 || returns.length !== 1)
          )
            throw new Error(`Unsupported schema helper ${String(callee.name)}`);
          const bindings = new Map(scope);
          (helper.helper.params as Node[]).forEach((param, i) => {
            if (param.type !== "Identifier") throw new Error("Unsupported schema helper parameter");
            bindings.set(String(param.name), evaluate((node.arguments as Node[])[i]!, file, scope));
          });
          return evaluate(
            body.type === "BlockStatement" ? (returns[0]!.argument as Node) : body,
            helper.file,
            bindings,
          );
        }
      }
    }
    throw new Error(`Unsupported contract expression ${file}: ${node.type}`);
  }
  function exportsOf(
    file: string,
    seen = new Set<string>(),
  ): Map<string, { file: string; name: string }> {
    if (seen.has(file)) throw new Error(`Circular contract export ${file}`);
    seen.add(file);
    const exports = new Map<string, { file: string; name: string }>();
    for (const statement of (programs.get(file)?.program.body as Node[]) ?? []) {
      if (statement.exportKind === "type") continue;
      if (statement.type === "ExportAllDeclaration") {
        for (const [name, value] of exportsOf(
          resolveFile(file, String((statement.source as Node).value)),
          new Set(seen),
        ))
          exports.set(name, value);
      }
      if (statement.type !== "ExportNamedDeclaration") continue;
      const declaration = statement.declaration as Node | null;
      if (declaration?.type === "VariableDeclaration")
        for (const item of declaration.declarations as Node[]) {
          const name = String((item.id as Node).name);
          exports.set(name, { file, name });
        }
      for (const spec of statement.specifiers as Node[]) {
        if (spec.exportKind === "type") continue;
        const name = keyName(spec.local as Node)!;
        exports.set(keyName(spec.exported as Node)!, {
          file: statement.source
            ? resolveFile(file, String((statement.source as Node).value))
            : file,
          name,
        });
      }
    }
    return exports;
  }
  const contract: Contract = { schemas: {}, constants: {}, status: {}, routes: [] };
  if (programs.has(PROTOCOL))
    for (const [name, binding] of exportsOf(PROTOCOL)) {
      const node = declarations.get(binding.file)?.get(binding.name);
      if (!node || isFunction(node)) continue;
      const value = lookup(binding.file, binding.name);
      if (!(value instanceof z.ZodType)) continue;
      contract.schemas[name] = z.toJSONSchema(value, {
        io: "input",
        unrepresentable: "any",
      }) as Json;
    }
  const status = programs.get(STATUS);
  if (status) {
    contract.status = statusShapes(status.source, status.program);
    for (const [name, binding] of exportsOf(STATUS)) {
      if (!declarations.get(binding.file)?.has(binding.name)) continue;
      const node = declarations.get(binding.file)!.get(binding.name)!;
      if (isFunction(node)) continue;
      const value = lookup(binding.file, binding.name);
      if (typeof value === "string" || typeof value === "number" || Array.isArray(value))
        contract.constants[name] = value as Json;
    }
  }
  const routes = new Set<string>();
  for (const [file, { program }] of programs) {
    const constants = new Map<string, Set<string>>();
    for (const name of [
      ...(declarations.get(file)?.keys() ?? []),
      ...(imports.get(file)?.keys() ?? []),
    ]) {
      try {
        const value = lookup(file, name);
        if (typeof value === "string") constants.set(name, new Set([value]));
      } catch {
        /* Not a contract constant. */
      }
    }
    routesIn(program, constants, routes);
  }
  contract.routes = [...routes].sort();
  return contract;
}
type Parser = (file: string, source: string) => { program: Node; errors?: unknown[] };

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
    for (const key of [...new Set(["type", "kind", ...Object.keys(variant.properties)])]) {
      const field = variant.properties[key];
      if (isObject(field) && typeof field.const === "string") return `${key}=${field.const}`;
    }
  }
  if (isObject(variant)) {
    const props = isObject(variant.properties) ? variant.properties : {};
    return `${String(variant.type ?? "unknown")}:${(Array.isArray(variant.required) ? variant.required.map(String) : Object.keys(props)).sort().join(",")}`;
  }
  return JSON.stringify(variant);
}

function variants(schema: { [key: string]: Json }): Map<string, Json> {
  const list = schema.anyOf ?? schema.oneOf;
  const result = new Map<string, Json>();
  for (const item of Array.isArray(list) ? list : []) {
    const key =
      isObject(item) && item.const !== undefined
        ? `const=${JSON.stringify(item.const)}`
        : tag(item);
    if (result.has(key)) throw new Error(`Ambiguous contract union variant ${key}`);
    result.set(key, item);
  }
  return result;
}

type Found = (at: string, kind: string) => void;
type Added = (at: string) => void;

/** Detects removed inputs and narrowed readers. Commands also protect the old strict reader.
 * Event optional fields remain additive by policy, including strict event objects.
 */
function compareSchema(
  base: Json,
  next: Json,
  at: string,
  found: Found,
  added: Added,
  command = false,
): void {
  if (!isObject(base) || !isObject(next)) return;
  const nextTypes = types(next);
  const removedTypes = [...types(base)].filter(
    (type) =>
      nextTypes.size > 0 &&
      !nextTypes.has(type) &&
      !(type === "integer" && nextTypes.has("number")),
  );
  if (removedTypes.length) found(at, `narrowed: ${removedTypes.join(", ")} no longer accepted`);
  const finite = (schema: { [key: string]: Json }): Json[] | undefined =>
    schema.const !== undefined
      ? [schema.const]
      : Array.isArray(schema.enum)
        ? schema.enum
        : undefined;
  const oldValues = finite(base),
    newValues = finite(next);
  if (newValues) {
    if (!oldValues)
      found(
        at,
        `narrowed: only ${newValues.map((value) => JSON.stringify(value)).join(", ")} accepted`,
      );
    else
      for (const value of oldValues)
        if (!newValues.some((item) => JSON.stringify(item) === JSON.stringify(value)))
          found(at, `narrowed: ${JSON.stringify(value)} removed`);
  }
  for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"]) {
    if (typeof next[key] === "number" && (typeof base[key] !== "number" || next[key] > base[key]))
      found(at, `narrowed: ${key} increased to ${next[key]}`);
  }
  for (const key of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"]) {
    if (typeof next[key] === "number" && (typeof base[key] !== "number" || next[key] < base[key]))
      found(at, `narrowed: ${key} decreased to ${next[key]}`);
  }
  for (const key of ["pattern", "format", "multipleOf"])
    if (next[key] !== undefined && JSON.stringify(base[key]) !== JSON.stringify(next[key]))
      found(at, `narrowed: ${key} changed`);
  if (base.additionalProperties !== false && next.additionalProperties === false)
    found(at, "narrowed: unknown properties rejected");
  const before = variants(base);
  const after = variants(next);
  const keys = [...before.keys()];
  for (const [key, variant] of before) {
    const match = after.get(key);
    if (match === undefined)
      found(at, `variant ${key.length > 40 ? `#${keys.indexOf(key)}` : key} removed`);
    else compareSchema(variant, match, `${at}<${key}>`, found, added, command);
  }
  for (const key of after.keys())
    if (!before.has(key)) {
      if (command) found(`${at}<${key}>`, "new command variant rejected by old reader");
      else added(`${at}<${key}>`);
    }
  const props = isObject(base.properties) ? base.properties : {};
  const nextProps = isObject(next.properties) ? next.properties : {};
  const required = new Set(Array.isArray(base.required) ? base.required.map(String) : []);
  for (const key of Object.keys(props)) {
    if (!(key in nextProps)) found(`${at}.${key}`, "removed");
    else compareSchema(props[key]!, nextProps[key]!, `${at}.${key}`, found, added, command);
  }
  for (const key of Object.keys(nextProps))
    if (!(key in props)) {
      if (command && base.additionalProperties === false)
        found(`${at}.${key}`, "new field rejected by old strict reader");
      else added(`${at}.${key}`);
    }
  for (const key of Array.isArray(next.required) ? next.required.map(String) : [])
    if (!required.has(key))
      found(`${at}.${key}`, key in props ? "became required" : "required field added");
  if (base.items !== undefined && next.items !== undefined)
    compareSchema(base.items, next.items, `${at}[]`, found, added, command);
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
    else
      compareSchema(
        schema,
        next.schemas[name]!,
        "",
        protocol.found(name),
        protocol.added(name),
        name === "RunnerCommandSchema",
      );
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

// Only the trusted base supplies executable dependencies and installation metadata.
// Both source trees are archived as data. No child starts in either source tree.
async function tree(sha: string, dir: string): Promise<void> {
  // Read blobs directly: .gitattributes export-ignore must not hide a contract.
  const entries = await run(["git", "ls-tree", "-r", "-z", sha], repo);
  for (const entry of entries.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [mode, kind, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (!path.startsWith("src/") && path !== "package.json" && path !== "bun.lock") continue;
    if (kind !== "blob" || !["100644", "100755"].includes(mode!))
      throw new Error(`Contract tree requires regular files: ${path}`);
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await run(["git", "cat-file", "blob", oid!], repo));
  }
}
const head = await commit(values.head);
if ((await commit("HEAD")) !== head) throw new Error("Candidate HEAD does not match --head");
const scratch = await mkdtemp(join(tmpdir(), "api-contract-"));
try {
  const baseDir = join(scratch, "base"),
    nextDir = join(scratch, "next"),
    deps = join(scratch, "dependencies");
  for (const dir of [baseDir, nextDir, deps]) await mkdir(dir);
  await tree(await commit(values.base), baseDir);
  await tree(head, nextDir);
  for (const file of ["package.json", "bun.lock"])
    await writeFile(join(deps, file), await readFile(join(baseDir, file)));
  await writeFile(join(deps, "bunfig.toml"), "");
  await run(
    [
      process.execPath,
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      `--config=${join(deps, "bunfig.toml")}`,
    ],
    deps,
  );
  const { parseSync } = (await import(Bun.resolveSync("oxc-parser", deps))) as {
    parseSync: Parser;
  };
  const { z } = (await import(Bun.resolveSync("zod", deps))) as typeof import("zod");
  const before = await staticContract(baseDir, parseSync, z);
  const after = await staticContract(nextDir, parseSync, z);
  const { breaks, additions } = diff(before, after);
  for (const change of breaks) console.log(`${change.surface}\t${change.name}\t${change.kind}`);
  for (const addition of additions) console.log(`${addition}\tadded`);
  console.log(
    `${breaks.length} breaking changes · ${additions.length} additive · ${after.routes.length} routes, ${Object.keys(after.schemas).length} runner schemas, ${Object.keys(after.status).length} status types`,
  );
  process.exitCode = breaks.length ? 1 : 0;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
