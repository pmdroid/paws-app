import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

function emptyCatches(file: string, source: string): number[] {
  const parsed = parseSync(file, source);
  expect(parsed.errors).toEqual([]);
  const offsets: number[] = [];
  new Visitor({
    VariableDeclarator(node) {
      // Standalone onboarding pages carry JavaScript in an inline SCRIPT template.
      if (node.id.type !== "Identifier" || !/SCRIPT$/.test(node.id.name)) return;
      const init = node.init;
      const template = init?.type === "TaggedTemplateExpression" ? init.quasi : init;
      if (template?.type !== "TemplateLiteral" || template.expressions.length !== 0) return;
      const raw = template.quasis[0]?.value.raw;
      if (!raw) return;
      const baseLine = source.slice(0, template.start).split("\n").length - 1;
      for (const line of emptyCatches(`${file}.inline.js`, raw)) {
        // Reuse the source offset representation for the final line-number conversion.
        const targetLine = baseLine + line;
        let offset = 0;
        for (let index = 1; index < targetLine; index++) offset = source.indexOf("\n", offset) + 1;
        offsets.push(offset);
      }
    },
    CatchClause(node) {
      if (node.body.body.length === 0) offsets.push(node.start);
    },
    CallExpression(node) {
      if (
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.property.type !== "Identifier" ||
        node.callee.property.name !== "catch"
      )
        return;
      const callback = node.arguments[0];
      if (
        callback &&
        (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression") &&
        callback.body?.type === "BlockStatement" &&
        callback.body.body.length === 0
      )
        offsets.push(callback.start);
    },
  }).visit(parsed.program);
  return offsets.map((offset) => source.slice(0, offset).split("\n").length);
}

test("rejects empty and comment-only catch blocks, including promise handlers", () => {
  expect(emptyCatches("example.ts", "try {} catch {} ")).toHaveLength(1);
  expect(emptyCatches("example.ts", "try {} catch (error) { /* ignored */ } ")).toHaveLength(1);
  expect(emptyCatches("example.ts", "task.catch(() => { /* ignored */ });")).toHaveLength(1);
  expect(emptyCatches("example.ts", "task.catch(function (error) {});")).toHaveLength(1);
  expect(emptyCatches("example.ts", "try {} catch (error) { throw error; }")).toEqual([]);
  expect(emptyCatches("example.tsx", '<div>{"catch {}"}</div>')).toEqual([]);
  expect(emptyCatches("example.ts", "const SCRIPT = String.raw`try {} catch {}`;")).toHaveLength(1);
});

test("src contains no empty catches", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const violations: string[] = [];
  for (const file of readdirSync(root, { recursive: true })) {
    if (typeof file !== "string" || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const line of emptyCatches(file, readFileSync(join(root, file), "utf8")))
      violations.push(`${file}:${line}`);
  }
  expect(violations).toEqual([]);
});
