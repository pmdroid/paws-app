import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  IndentationText,
  Node,
  Project,
  QuoteKind,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type SourceFile,
  type Type,
  type VariableDeclaration,
} from "ts-morph";

const SYNC_CALLBACKS = new Set([
  "map",
  "flatMap",
  "forEach",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "sort",
  "reduce",
  "reduceRight",
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const TEST_CALLBACKS = new Set(["test", "it", "beforeAll", "beforeEach", "afterAll", "afterEach"]);
const TRANSACTION_CALLS = new Set(["transaction", "immediate"]);
const DB_TYPES = new Set(["Db", "SqliteDb", "PgDb"]);
const LEFT_ALONE = new Set(["migrate", "appliedMigrations", "legacyMigrate", "sqliteDb"]);
const RUNNERS = new Set(["settled", "sqliteDb", "run", "transaction", "runSteps", "sync"]);

export const manipulationSettings = {
  indentationText: IndentationText.TwoSpaces,
  quoteKind: QuoteKind.Double,
};

type Fn = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;
type Site = { file: string; line: number };
export type Boundary = Site & { reason: string; wrapper: string };
export type Report = {
  wrappers: number;
  folded: number;
  calls: number;
  wrapped: number;
  asyncFunctions: number;
  boundaries: Boundary[];
  withoutSteps: (Site & { name: string })[];
  files: string[];
};

type Wrapper = {
  fn: FunctionDeclaration;
  steps: FunctionDeclaration;
  sibling?: FunctionDeclaration;
  body?: string;
};
type Plan = { wrapper: Wrapper; awaits: Map<CallExpression, boolean>; asyncs: Set<Fn> };

function site(node: Node): Site {
  return { file: node.getSourceFile().getFilePath(), line: node.getStartLineNumber() };
}

function isDatabase(type: Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol?.getName() === "Database" &&
    symbol
      .getDeclarations()
      .some(
        (d) => d.getFirstAncestorByKind(SyntaxKind.ModuleDeclaration)?.getName() === '"bun:sqlite"',
      )
  );
}

function isDb(type: Type): boolean {
  const alias = type.getAliasSymbol()?.getName();
  if (alias !== undefined && DB_TYPES.has(alias)) return true;
  return type.isUnion() && type.getUnionTypes().every(isDb);
}

function calleeName(call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

function references(decl: FunctionDeclaration | VariableDeclaration | MethodDeclaration): Node[] {
  return decl
    .findReferencesAsNodes()
    .filter(
      (ref) =>
        ref !== decl.getNameNode() &&
        !ref.getFirstAncestor(
          (n) => Node.isImportDeclaration(n) || Node.isExportDeclaration(n) || Node.isTypeQuery(n),
        ),
    );
}

function findWrappers(files: SourceFile[], dbDir: string, report: Report): Wrapper[] {
  const wrappers: Wrapper[] = [];
  for (const sf of files) {
    if (!sf.getFilePath().startsWith(`${dbDir}/`)) continue;
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name || !fn.isExported() || fn.isAsync() || fn.isGenerator() || LEFT_ALONE.has(name))
        continue;
      const first = fn.getParameters()[0];
      if (!first || !isDatabase(first.getType())) continue;
      const steps = sf.getFunction(`${name}Steps`);
      if (!steps?.isGenerator() || steps.getParameters().length !== fn.getParameters().length) {
        report.withoutSteps.push({ ...site(fn), name });
        continue;
      }
      const body = onlyRunsSteps(fn, steps) ? undefined : awaitedBody(fn);
      if (body === null) {
        report.boundaries.push({
          ...site(fn),
          reason: "body does more than run its Steps",
          wrapper: name,
        });
        continue;
      }
      const sibling = sf.getFunction(`${name}Async`);
      wrappers.push({ fn, steps, sibling: sibling?.isAsync() ? sibling : undefined, body });
    }
  }
  return wrappers;
}

function onlyRunsSteps(fn: FunctionDeclaration, steps: FunctionDeclaration): boolean {
  const statements = fn.getStatements();
  if (statements.length !== 1) return false;
  const [statement] = statements;
  if (statement!.getDescendantsOfKind(SyntaxKind.AsExpression).length > 0) return false;
  return statement!.getDescendantsOfKind(SyntaxKind.CallExpression).every((call) => {
    const name = calleeName(call);
    return name === steps.getName() || (name !== undefined && RUNNERS.has(name));
  });
}

function topLevelAwaits(sf: SourceFile): boolean {
  return /\/(test|scripts)\//.test(sf.getFilePath());
}

function plan(wrapper: Wrapper, inScope: Set<SourceFile>, report: Report): Plan | null {
  const name = wrapper.fn.getName()!;
  const result: Plan = { wrapper, awaits: new Map(), asyncs: new Set() };
  const boundaries: Boundary[] = [];
  const stop = (node: Node, reason: string) =>
    boundaries.push({ ...site(node), reason, wrapper: name });
  for (const ref of wrapper.sibling ? references(wrapper.sibling) : [])
    if (!inScope.has(ref.getSourceFile())) stop(ref, `${name}Async used outside the given files`);
  const queue: [FunctionDeclaration | VariableDeclaration | MethodDeclaration, boolean][] = [
    [wrapper.fn, true],
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [decl, isWrapper] = next;
    for (const ref of references(decl)) {
      if (ref.getFirstAncestor((n) => n === wrapper.fn)) continue;
      if (!inScope.has(ref.getSourceFile())) {
        stop(ref, "used outside the given files");
        continue;
      }
      const access = ref.getParent();
      const callee =
        Node.isPropertyAccessExpression(access) && access.getNameNode() === ref ? access : ref;
      const call = callee.getParent();
      if (!call || !Node.isCallExpression(call) || call.getExpression() !== callee) {
        stop(ref, "used as a value, not called");
        continue;
      }
      if (Node.isAwaitExpression(call.getParent())) continue;
      let wrap = false;
      if (isWrapper) {
        const arg = call.getArguments()[0];
        wrap = arg !== undefined && isDatabase(arg.getType());
        if (!wrap && (!arg || !isDb(arg.getType()))) {
          stop(call, "first argument is neither Db nor Database");
          continue;
        }
      }
      const transaction = call.getFirstAncestor(
        (n) =>
          (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) &&
          TRANSACTION_CALLS.has(calleeName(n.getParent()) ?? ""),
      );
      if (transaction) {
        stop(call, `inside a ${calleeName(transaction.getParent())}(...) body`);
        continue;
      }
      const fn = call.getFirstAncestor(isFunctionLike);
      if (!fn && topLevelAwaits(call.getSourceFile())) {
        result.awaits.set(call, wrap);
        continue;
      }
      const reason = enclosingBoundary(fn);
      if (reason) {
        stop(call, reason);
        continue;
      }
      result.awaits.set(call, wrap);
      const owner = fn as Fn;
      if (owner.isAsync() || result.asyncs.has(owner)) continue;
      result.asyncs.add(owner);
      const parent = owner.getParent();
      if (Node.isFunctionDeclaration(owner) || Node.isMethodDeclaration(owner))
        queue.push([owner, false]);
      else if (Node.isVariableDeclaration(parent)) queue.push([parent, false]);
    }
  }
  report.boundaries.push(...boundaries);
  return boundaries.length === 0 ? result : null;
}

function enclosingBoundary(fn: Node | undefined): string | undefined {
  if (!fn) return "module top level";
  if (Node.isConstructorDeclaration(fn)) return "constructor";
  if (Node.isGetAccessorDeclaration(fn)) return "getter";
  if (Node.isSetAccessorDeclaration(fn)) return "setter";
  if ((fn as Fn).isGenerator?.()) return "generator body";
  if ((fn as Fn).isAsync()) return undefined;
  const parent = fn.getParent()!;
  if (Node.isMethodDeclaration(fn)) {
    const owner = fn.getParentIfKind(SyntaxKind.ClassDeclaration);
    if (!owner) return "object literal method";
    if (owner.getHeritageClauses().length > 0) return "method of a class with a supertype";
    return undefined;
  }
  if (Node.isFunctionDeclaration(fn)) return undefined;
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === fn) return undefined;
  if (Node.isCallExpression(parent) && parent.getArguments().includes(fn)) {
    const name = calleeName(parent) ?? eachName(parent) ?? "an expression";
    if (TEST_CALLBACKS.has(name)) return undefined;
    if (SYNC_CALLBACKS.has(name)) return `sync callback (${name})`;
    return `callback passed to ${name}`;
  }
  return "function value";
}

function eachName(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (!Node.isCallExpression(callee) || calleeName(callee) !== "each") return undefined;
  const owner = callee.getExpression();
  return Node.isPropertyAccessExpression(owner) ? owner.getExpression().getText() : undefined;
}

function moduleSpecifier(from: SourceFile, to: SourceFile): string {
  const path = relative(dirname(from.getFilePath()), to.getFilePath()).replace(/\.ts$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

function ensureImport(
  sf: SourceFile,
  name: string,
  typeOnly: boolean,
  home: SourceFile,
  near?: string,
) {
  const imports = sf.getImportDeclarations();
  if (imports.some((d) => d.getNamedImports().some((n) => n.getName() === name))) return;
  if (sf === home) return;
  const exportsName = (d: (typeof imports)[number]) =>
    d.getModuleSpecifierSourceFile()?.getExportedDeclarations().has(name) === true &&
    (typeOnly || !d.isTypeOnly());
  const target =
    imports.find((d) => exportsName(d) && d.getNamedImports().some((n) => n.getName() === near)) ??
    imports.find(exportsName);
  if (target) target.addNamedImport({ name, isTypeOnly: typeOnly && !target.isTypeOnly() });
  else
    sf.addImportDeclaration({
      moduleSpecifier: moduleSpecifier(sf, home),
      namedImports: [name],
      isTypeOnly: typeOnly,
    });
}

function dropUnusedImports(sf: SourceFile) {
  for (const decl of sf.getImportDeclarations()) {
    const named = decl.getNamedImports();
    if (named.length === 0) continue;
    const seen = new Set<string>();
    for (const spec of named) {
      const local = spec.getAliasNode() ?? spec.getNameNode();
      const used = Node.isIdentifier(local)
        ? local
            .findReferencesAsNodes()
            .some(
              (ref) =>
                ref.getSourceFile() === sf &&
                !ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration),
            )
        : true;
      if (!used || seen.has(local.getText())) spec.remove();
      else seen.add(local.getText());
    }
    if (
      decl.getNamedImports().length === 0 &&
      !decl.getDefaultImport() &&
      !decl.getNamespaceImport()
    )
      decl.remove();
  }
}

function localHelpers(fn: FunctionDeclaration, seen = new Set<FunctionDeclaration>()) {
  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier))
    for (const decl of id.getSymbol()?.getDeclarations() ?? [])
      if (
        Node.isFunctionDeclaration(decl) &&
        decl !== fn &&
        !decl.isExported() &&
        decl.getSourceFile() === fn.getSourceFile() &&
        !seen.has(decl)
      ) {
        seen.add(decl);
        localHelpers(decl, seen);
      }
  return seen;
}

function awaitedBody(fn: FunctionDeclaration): string | null {
  const name = fn.getParameters()[0]!.getName();
  const body = fn.getBody()!;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const id of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name) continue;
    const call = id.getParent();
    if (!Node.isCallExpression(call) || call.getArguments()[0] !== id) return null;
    if (calleeName(call) === "emitJobReady") {
      edits.push({ start: id.getStart(), end: id.getEnd(), text: "store" });
      continue;
    }
    const access = call.getParent();
    const runner = access?.getParent();
    const outer = runner?.getParent();
    if (
      calleeName(call) !== "sqliteDb" ||
      !Node.isPropertyAccessExpression(access) ||
      !["run", "transaction"].includes(access.getName()) ||
      !Node.isCallExpression(runner) ||
      runner.getExpression() !== access ||
      !Node.isCallExpression(outer) ||
      calleeName(outer) !== "settled"
    )
      return null;
    const args = runner.getArguments().map((a) => a.getText());
    edits.push({
      start: outer.getStart(),
      end: outer.getEnd(),
      text: `(await store.${access.getName()}(${args.join(", ")}))`,
    });
  }
  if (edits.length === 0) return null;
  let text = body.getText();
  const offset = body.getStart();
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start - offset) + edit.text + text.slice(edit.end - offset);
  return text;
}

function rewriteWrapper({ fn, steps, body }: Wrapper) {
  const transaction = [fn, ...localHelpers(fn)].some((f) =>
    f.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => calleeName(c) === "transaction"),
  );
  const [, ...rest] = fn.getParameters();
  const params = ["store: Db", ...rest.map((p) => p.getText())].join(", ");
  const args = ["q", ...rest.map((p) => (p.isRestParameter() ? "..." : "") + p.getName())];
  const invoke = `store.${transaction ? "transaction" : "run"}((q) => ${steps.getName()}(${args.join(", ")}))`;
  const ret = fn.getReturnTypeNode()?.getText();
  const typeParams = fn.getTypeParameters().map((p) => p.getText());
  const docs = fn.getJsDocs().map((doc) => `${doc.getText()}\n`);
  fn.replaceWithText(
    `${docs.join("")}export async function ${fn.getName()}${typeParams.length ? `<${typeParams.join(", ")}>` : ""}(${params})` +
      `${ret ? `: Promise<${ret}>` : ""} ${body ?? `{\n  ${ret === "void" ? `await ${invoke};` : `return ${invoke};`}\n}`}`,
  );
}

export type ConvertOptions = {
  /** Reference scope: every file searched for callers. */
  files: SourceFile[];
  dbDir: string;
  /** Files whose wrappers are converted; all of `files` when absent. */
  wrappers?: SourceFile[];
};

export function convert(project: Project, options: ConvertOptions): Report {
  const report: Report = {
    wrappers: 0,
    folded: 0,
    calls: 0,
    wrapped: 0,
    asyncFunctions: 0,
    boundaries: [],
    withoutSteps: [],
    files: [],
  };
  const inScope = new Set(options.files);
  const home = project.getSourceFile(resolve(options.dbDir, "db.ts"));
  if (!home) throw new Error(`no db.ts in ${options.dbDir}`);
  const plans = findWrappers(options.wrappers ?? options.files, options.dbDir, report)
    .map((wrapper) => plan(wrapper, inScope, report))
    .filter((p): p is Plan => p !== null);
  const awaits = new Map<CallExpression, { wrap: boolean; name: string }>();
  const asyncs = new Set<Fn>();
  const changed = new Set<SourceFile>();
  const needs = new Map<SourceFile, { db?: true; sqliteDb?: string }>();
  const need = (sf: SourceFile, add: { db?: true; sqliteDb?: string }) =>
    needs.set(sf, { ...needs.get(sf), ...add });
  for (const p of plans) {
    for (const [call, wrap] of p.awaits) {
      const name = call.getExpression().getText();
      awaits.set(call, { wrap: wrap || awaits.get(call)?.wrap === true, name });
    }
    for (const fn of p.asyncs) asyncs.add(fn);
    for (const ref of p.wrapper.sibling ? references(p.wrapper.sibling) : [])
      changed.add(ref.getSourceFile());
  }
  for (const [call, { wrap, name }] of [...awaits].sort(
    (a, b) => b[0].getStart() - a[0].getStart(),
  )) {
    const sf = call.getSourceFile();
    changed.add(sf);
    if (wrap) {
      const arg = call.getArguments()[0]!;
      arg.replaceWithText(`sqliteDb(${arg.getText()})`);
      need(sf, { sqliteDb: name });
      report.wrapped += 1;
    }
    const parent = call.getParent();
    const paren =
      Node.isPropertyAccessExpression(parent) ||
      Node.isElementAccessExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      (Node.isCallExpression(parent) && parent.getExpression() === call);
    call.replaceWithText(paren ? `(await ${call.getText()})` : `await ${call.getText()}`);
    report.calls += 1;
  }
  for (const fn of asyncs) {
    changed.add(fn.getSourceFile());
    fn.setIsAsync(true);
    const ret = fn.getReturnTypeNode();
    if (ret && ret.getType().getSymbol()?.getName() !== "Promise")
      fn.setReturnType(`Promise<${ret.getText()}>`);
    report.asyncFunctions += 1;
  }
  const helpers = new Set(plans.flatMap(({ wrapper }) => [...localHelpers(wrapper.fn)]));
  for (const { wrapper } of plans) {
    const sf = wrapper.fn.getSourceFile();
    changed.add(sf);
    if (wrapper.sibling) {
      const name = wrapper.fn.getName()!;
      wrapper.fn.remove();
      wrapper.sibling.rename(name);
      report.folded += 1;
    } else {
      rewriteWrapper(wrapper);
      need(sf, { db: true });
    }
    report.wrappers += 1;
  }
  for (const helper of helpers) if (helper.findReferencesAsNodes().length === 0) helper.remove();
  for (const [sf, { db, sqliteDb }] of needs) {
    if (db) ensureImport(sf, "Db", true, home);
    if (sqliteDb) ensureImport(sf, "sqliteDb", false, home, sqliteDb);
  }
  for (const sf of changed) dropUnusedImports(sf);
  report.files = [...changed].map((sf) => sf.getFilePath()).sort();
  return report;
}

export function renderReport(report: Report, root: string): string {
  const at = (s: Site) => `${relative(root, s.file)}:${s.line}`;
  return [
    "# db-async codemod report",
    "",
    `- Wrappers converted: ${report.wrappers} (${report.folded} folded from a \`fooAsync\` sibling)`,
    `- Calls awaited: ${report.calls} (${report.wrapped} wrapped in \`sqliteDb\`)`,
    `- Functions made async: ${report.asyncFunctions}`,
    `- Files changed: ${report.files.length}`,
    "",
    `## Boundaries (${report.boundaries.length})`,
    "",
    ...report.boundaries.map((b) => `- \`${at(b)}\` ${b.reason} (\`${b.wrapper}\`)`),
    "",
    `## Exports without a Steps form (${report.withoutSteps.length})`,
    "",
    ...report.withoutSteps.map((s) => `- \`${at(s)}\` \`${s.name}\``),
    "",
  ].join("\n");
}

/** `--wrappers` takes every argument up to `--` or the end; the rest are the reference globs. */
export function parseArgs(argv: string[]): { globs: string[]; wrappers?: string[] } {
  const at = argv.indexOf("--wrappers");
  if (at === -1) return { globs: argv };
  const end = argv.indexOf("--", at + 1);
  const stop = end === -1 ? argv.length : end;
  return {
    globs: [...argv.slice(0, at), ...argv.slice(end === -1 ? stop : stop + 1)],
    wrappers: argv.slice(at + 1, stop),
  };
}

if (import.meta.main) {
  const { globs, wrappers } = parseArgs(process.argv.slice(2));
  if (globs.length === 0 || wrappers?.length === 0) {
    console.error(
      "usage: bun scripts/codemods/db-async.ts <globs…> [--wrappers <src/db files…> [--]]",
    );
    process.exit(2);
  }
  const project = new Project({ tsConfigFilePath: "tsconfig.json", manipulationSettings });
  const files = project.addSourceFilesAtPaths(globs);
  const picked = wrappers?.map((path) => {
    const file = project.getSourceFile(resolve(path));
    if (!file || !files.includes(file)) {
      console.error(`--wrappers ${path} is not among the files the globs match`);
      process.exit(2);
    }
    return file;
  });
  const report = convert(project, { files, dbDir: resolve("src/db"), wrappers: picked });
  await project.save();
  writeFileSync("codemod-report.md", renderReport(report, process.cwd()));
  if (report.files.length > 0)
    spawnSync("bun", ["x", "oxfmt", ...report.files], { stdio: "inherit" });
  console.log(renderReport(report, process.cwd()));
}
