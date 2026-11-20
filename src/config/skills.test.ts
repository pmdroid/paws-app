import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigToml } from "./file";
import { projectSkillsRoot } from "./skills";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("project skills resolve per repository", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-skills-config-"));
  roots.push(root);
  const config = parseConfigToml('[skills.projects."Acme/Demo"]\nroot = "local-skills"\n');
  expect(projectSkillsRoot(config, root, "ACME/DEMO")).toBe(join(root, "local-skills"));
  expect(projectSkillsRoot(config, root, "other/repo")).toBeUndefined();
});

test.each([
  '[skills.projects."acme/demo"]\nroot = ""',
  '[skills.projects."acme/demo"]\nroot = 3',
  '[skills.projects."acme/demo"]\nroots = "skills"',
  '[skills.projects."../demo"]\nroot = "skills"',
  '[skills.projects."Acme/Demo"]\nroot = "one"\n[skills.projects."acme/demo"]\nroot = "two"',
])("invalid local skill configuration is rejected: %s", (text) => {
  expect(() => parseConfigToml(text)).toThrow();
});
