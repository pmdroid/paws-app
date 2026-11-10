import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missingToolchainQuestion } from "./toolchain";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "paws-toolchain-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const EMPTY_PATH = "/nonexistent-paws-bin";

test("a root bun.lock covers a workspace app without engines.node", () => {
  const root = repository({
    "package.json": { workspaces: ["apps/*"] },
    "bun.lock": "",
    "apps/x/package.json": { name: "x" },
  });
  const bin = join(root, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), "#!/bin/sh\n", { mode: 0o755 });
  expect(missingToolchainQuestion(root, bin)).toBeUndefined();
});

test("engines.node asks for the lowest version in its range", () => {
  const root = repository({
    "bun.lock": "",
    "apps/x/package.json": { engines: { node: ">=22.12.0" }, packageManager: "bun@1.3.5" },
  });
  const question = missingToolchainQuestion(root, EMPTY_PATH);
  expect(question).toContain("apps/x/package.json needs node");
  expect(question).toContain('node = "22.12.0"');
  expect(question).toContain("[tools] table in mise.toml");
});

test("only .tool-versions in the repository asks in its syntax", () => {
  const root = repository({
    ".tool-versions": "bun 1.4.2\n",
    "apps/x/package.json": { engines: { node: "^20.5 || >=22" } },
    "go.mod": "module x\n",
  });
  const question = missingToolchainQuestion(root, EMPTY_PATH)!;
  expect(question).toContain(".tool-versions at the repository root");
  expect(question).toContain("\nnode 20.5.0");
  expect(question).toContain("\ngo latest");
  expect(question).not.toContain("[tools]");
  expect(question).not.toContain("mise.toml");
});

test(".tool-versions beside mise.toml keeps the [tools] table", () => {
  const root = repository({
    ".tool-versions": "",
    "mise.toml": "[tools]\n",
    "package.json": {},
  });
  expect(missingToolchainQuestion(root, EMPTY_PATH)).toContain('[tools]\nnode = "lts"');
});

test("packageManager bun@ alone is a bun signal", () => {
  const root = repository({ "package.json": { packageManager: "bun@1.3.5" } });
  expect(missingToolchainQuestion(root, EMPTY_PATH)).toBeUndefined();
});

test("engines.bun alone is a bun signal", () => {
  const root = repository({ "packages/y/package.json": { engines: { bun: ">=1.3" } } });
  expect(missingToolchainQuestion(root, EMPTY_PATH)).toBeUndefined();
});

test("a package.json without a bun signal still needs node", () => {
  const root = repository({ "apps/x/package.json": { packageManager: "pnpm@9.0.0" } });
  expect(missingToolchainQuestion(root, EMPTY_PATH)).toContain('node = "lts"');
});
