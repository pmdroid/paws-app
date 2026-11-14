import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigToml } from "./file";
import { projectSkillsRoot } from "./skills";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("project skills resolve per repository", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-skills-config-"));
  roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, '[skills.projects."Acme/Demo"]\nroot = "local-skills"\n');
  const config = parseConfigToml(readFileSync(path, "utf8"));
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

test("[github] mirrors is read as a boolean and is missing by default", () => {
  expect(parseConfigToml("[github]\nmirrors = false\n").githubMirrors).toBe(false);
  expect(parseConfigToml('[github]\nrepo = "acme/app"\n').githubMirrors).toBeUndefined();
  expect(() => parseConfigToml('[github]\nmirrors = "no"\n')).toThrow();
});
