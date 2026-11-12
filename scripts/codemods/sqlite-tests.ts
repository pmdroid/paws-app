import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  Node,
  Project,
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
import { manipulationSettings } from "./db-async";

const RAW = new Set(["query", "prepare", "exec", "run"]);
const DB_TYPES = new Set(["Db", "SqliteDb", "PgDb"]);
const LEFT_ALONE = ["test/helpers.ts", "test/dialects.ts"];
const SQLITE_NAMES = ["tempDb", "sqliteDb", "openDatabase", "migrate", "Database"];

type Fn = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;
export type Site = { file: string; line: number; text: string };
export type Report = {
  stores: number;
  closes: number;
  unwrapped: number;
  asyncFunctions: number;
  raw: Site[];
  sources: Site[];
  unparsed: { file: string; reason: string }[];
  files: string[];
};

function site(node: Node): Site {
  const text = node.getText().replace(/\s+/g, " ").slice(0, 100);
  return { file: node.getSourceFile().getFilePath(), line: node.getStartLineNumber(), text };
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

function callee(call: CallExpression): string {
  return call.getExpression().getText();
}

function isFn(node: Node): node is Fn {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  );
}

function rawCall(call: CallExpression): boolean {
  const target = call.getExpression();
  if (!Node.isPropertyAccessExpression(target) || !RAW.has(target.getName())) return false;
  const type = target.getExpression().getType();
  if (isDatabase(type)) return true;
  const first = call.getArguments()[0]?.getType();
  return (
    isDb(type) && (target.getName() !== "run" || !!first?.isString() || !!first?.isStringLiteral())
  );
}

function memoryMigrate(decl: VariableDeclaration, init: CallExpression): Node | undefined {
  if (callee(init) !== "openDatabase" || init.getArguments()[0]?.getText() !== '":memory:"')
    return undefined;
  const next = decl.getVariableStatement()?.getNextSibling();
  const call = Node.isExpressionStatement(next) ? next.getExpression() : undefined;
  return Node.isCallExpression(call) &&
    callee(call) === "migrate" &&
    call.getArguments()[0]?.getText() === decl.getName()
    ? next
    : undefined;
}

function source(call: CallExpression): boolean {
  return (
    (callee(call) === "tempDb" && call.getArguments().length === 0) ||
    callee(call) === "openDatabase"
  );
}

function moduleSpecifier(from: SourceFile, to: string): string {
  const path = relative(dirname(from.getFilePath()), to).replace(/\.ts$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

type Edit = { node: Node; text: string };

function declaredNames(sf: SourceFile): Set<string> {
  const names = sf.getDescendantsOfKind(SyntaxKind.Identifier).filter((i) => {
    const p = i.getParent();
    return (
      (Node.isVariableDeclaration(p) ||
        Node.isParameterDeclaration(p) ||
        Node.isBindingElement(p) ||
        Node.isFunctionDeclaration(p) ||
        Node.isImportSpecifier(p)) &&
      p.getNameNode() === i
    );
  });
  return new Set(names.map((i) => i.getText()));
}

function convertFile(sf: SourceFile, pglite: string, report: Report): boolean {
  const edits: Edit[] = [];
  const asyncs = new Set<Fn>();
  const removed: Node[] = [];
  const declared = declaredNames(sf);
  let stores = 0;
  const awaitIn = (node: Node) => {
    const fn = node.getFirstAncestor((n) => isFn(n) || Node.isConstructorDeclaration(n));
    if (fn && isFn(fn) && !fn.isAsync()) asyncs.add(fn);
    return fn === undefined || isFn(fn);
  };
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) if (rawCall(call)) report.raw.push(site(call));
  for (const call of calls) {
    if (!source(call)) continue;
    const decl = call.getParent();
    const migrated = Node.isVariableDeclaration(decl) ? memoryMigrate(decl, call) : undefined;
    const name = Node.isVariableDeclaration(decl) ? decl.getNameNode() : undefined;
    if (
      !Node.isVariableDeclaration(decl) ||
      !Node.isIdentifier(name) ||
      (callee(call) === "openDatabase" && !migrated) ||
      !awaitIn(call)
    ) {
      report.sources.push(site(call));
      continue;
    }
    const x = name.getText();
    const refs = name.findReferencesAsNodes().filter((r) => r.getSourceFile() === sf && r !== name);
    const closes = refs
      .map((r) => r.getParentIfKind(SyntaxKind.PropertyAccessExpression)?.getParent())
      .filter(
        (c): c is CallExpression =>
          Node.isCallExpression(c) && c.getExpression().getText() === `${x}.close`,
      );
    const close =
      x === "db" && !declared.has("close") ? "close" : `close${x[0]!.toUpperCase()}${x.slice(1)}`;
    for (const c of closes) {
      const statement = Node.isExpressionStatement(c.getParent());
      if (statement && !awaitIn(c)) continue;
      edits.push({ node: c, text: statement ? `await ${close}()` : `${close}()` });
      report.closes += 1;
    }
    if (closes.length === 0) report.sources.push({ ...site(call), text: `${x} is never closed` });
    const binding = close === "close" ? "{ db, close }" : `{ db: ${x}, close: ${close} }`;
    edits.push(
      closes.length > 0
        ? { node: decl, text: `${binding} = await tempStore()` }
        : { node: call, text: "(await tempStore()).db" },
    );
    if (migrated) removed.push(migrated);
    stores += 1;
  }
  for (const fn of [...asyncs]) propagate(fn, asyncs, edits, awaitIn);
  for (const fn of asyncs) {
    fn.setIsAsync(true);
    const ret = fn.getReturnTypeNode();
    if (ret && /\bDatabase\b/.test(ret.getText())) fn.removeReturnType();
    else if (ret && !ret.getText().startsWith("Promise<"))
      fn.setReturnType(`Promise<${ret.getText()}>`);
    report.asyncFunctions += 1;
  }
  const seen = new Set<Node>();
  const ordered = edits
    .filter((e) => !seen.has(e.node) && seen.add(e.node))
    .sort((a, b) => b.node.getStart() - a.node.getStart() || a.node.getEnd() - b.node.getEnd());
  for (const { node, text } of ordered) if (!node.wasForgotten()) node.replaceWithText(text);
  for (const node of removed) if (Node.isStatement(node)) node.remove();
  if (stores > 0)
    sf.addImportDeclaration({
      moduleSpecifier: moduleSpecifier(sf, pglite),
      namedImports: ["tempStore"],
    });
  let unwrapped = 0;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression).reverse()) {
    const arg = call.getArguments()[0];
    if (callee(call) !== "sqliteDb" || !arg || !isDb(arg.getType())) continue;
    call.replaceWithText(arg.getText());
    unwrapped += 1;
  }
  report.stores += stores;
  report.unwrapped += unwrapped;
  if (edits.length === 0 && unwrapped === 0) return false;
  dropUnused(sf);
  return true;
}

function propagate(fn: Fn, asyncs: Set<Fn>, edits: Edit[], awaitIn: (node: Node) => boolean) {
  const parent = fn.getParent();
  const decl = Node.isFunctionDeclaration(fn)
    ? fn
    : Node.isVariableDeclaration(parent)
      ? parent
      : undefined;
  if (!decl || fn.isAsync()) return;
  for (const ref of decl.findReferencesAsNodes()) {
    const returned = ref.getParentIfKind(SyntaxKind.TypeQuery)?.getParent();
    if (Node.isTypeReference(returned) && returned.getTypeName().getText() === "ReturnType")
      edits.push({ node: returned, text: `Awaited<${returned.getText()}>` });
    const call = ref.getParentIfKind(SyntaxKind.CallExpression);
    if (!call || call.getExpression() !== ref || ref.getSourceFile() !== fn.getSourceFile())
      continue;
    const up = call.getParent();
    if (Node.isAwaitExpression(up)) continue;
    const paren =
      Node.isPropertyAccessExpression(up) ||
      Node.isElementAccessExpression(up) ||
      Node.isNonNullExpression(up);
    edits.push({
      node: call,
      text: paren ? `(await ${call.getText()})` : `await ${call.getText()}`,
    });
    const before = new Set(asyncs);
    awaitIn(call);
    for (const next of asyncs) if (!before.has(next)) propagate(next, asyncs, edits, awaitIn);
  }
}

function dropUnused(sf: SourceFile) {
  const used = new Set(
    sf
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((i) => !i.getFirstAncestorByKind(SyntaxKind.ImportDeclaration))
      .map((i) => i.getText()),
  );
  for (const decl of sf.getImportDeclarations()) {
    for (const spec of decl.getNamedImports())
      if (SQLITE_NAMES.includes(spec.getName()) && !used.has(spec.getName())) spec.remove();
    if (
      decl.getNamedImports().length === 0 &&
      !decl.getDefaultImport() &&
      !decl.getNamespaceImport()
    )
      decl.remove();
  }
}

export function convert(files: SourceFile[], options: { pglite: string }): Report {
  const report: Report = {
    stores: 0,
    closes: 0,
    unwrapped: 0,
    asyncFunctions: 0,
    raw: [],
    sources: [],
    unparsed: [],
    files: [],
  };
  const program = files[0]?.getProject().getProgram();
  for (const sf of files) {
    if (LEFT_ALONE.some((path) => sf.getFilePath().endsWith(`/${path}`))) continue;
    const syntax = program?.getSyntacticDiagnostics(sf) ?? [];
    if (syntax.length > 0) {
      report.unparsed.push({ file: sf.getFilePath(), reason: String(syntax[0]!.getMessageText()) });
      continue;
    }
    try {
      if (convertFile(sf, options.pglite, report)) report.files.push(sf.getFilePath());
    } catch (error) {
      report.unparsed.push({ file: sf.getFilePath(), reason: String(error).split("\n")[0]! });
    }
  }
  const order = (a: Site, b: Site) => a.file.localeCompare(b.file) || a.line - b.line;
  report.raw.sort(order);
  report.sources.sort(order);
  return report;
}

export function renderReport(report: Report, root: string): string {
  const at = (s: Site) => `\`${relative(root, s.file)}:${s.line}\` ${s.text}`;
  const perFile = new Map<string, number>();
  for (const s of report.raw) perFile.set(s.file, (perFile.get(s.file) ?? 0) + 1);
  return [
    "# sqlite-tests codemod report",
    "",
    `- Databases moved to \`tempStore()\`: ${report.stores} (${report.closes} closes rewritten)`,
    `- \`sqliteDb(x)\` unwrapped: ${report.unwrapped}`,
    `- Functions made async: ${report.asyncFunctions}`,
    `- Files changed: ${report.files.length}`,
    "",
    `## Raw bun:sqlite calls left, per file (${report.raw.length}, lines as given)`,
    "",
    ...[...perFile]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([file, count]) => `- \`${relative(root, file)}\` ${count}`),
    "",
    ...report.raw.map((s) => `- ${at(s)}`),
    "",
    `## Databases left on SQLite (${report.sources.length})`,
    "",
    ...report.sources.map((s) => `- ${at(s)}`),
    "",
    `## Files not converted (${report.unparsed.length})`,
    "",
    ...report.unparsed.map((u) => `- \`${relative(root, u.file)}\` ${u.reason}`),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const globs = args.filter((arg) => arg !== "--dry-run");
  if (globs.length === 0) {
    console.error("usage: bun scripts/codemods/sqlite-tests.ts [--dry-run] <globs…>");
    process.exit(2);
  }
  const project = new Project({ tsConfigFilePath: "tsconfig.json", manipulationSettings });
  const files = project.addSourceFilesAtPaths(globs);
  const report = convert(files, { pglite: resolve("test/pglite.ts") });
  writeFileSync("codemod-report.md", renderReport(report, process.cwd()));
  if (!dry) {
    await project.save();
    if (report.files.length > 0)
      spawnSync("bun", ["x", "oxfmt", ...report.files], { stdio: "inherit" });
  }
  console.log(renderReport(report, process.cwd()));
}
