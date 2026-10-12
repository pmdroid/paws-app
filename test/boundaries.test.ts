import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

const MODULES = [
  "config",
  "credentials",
  "slack",
  "core",
  "db",
  "linear",
  "intake",
  "acp",
  "closeout",
  "closeout-spec",
  "github",
  "questions",
  "server",
  "settings",
  "web",
  "host",
  "loop",
  "doctor",
  "comments",
  "install",
  "deployment",
  "setup",
  "auth",
  "runner-protocol",
  "runner-execution",
  "runner-repositories",
  "process",
  "runner-worker",
  "runner-answers",
  "workspace",
  "runner-identity",
  "runner-control",
  "runner-daemon",
  "runner-work",
  "runner-results",
  "runner-health",
  "runner-coordinator",
] as const;

type ModuleName = (typeof MODULES)[number];

/** Who may import whose public index. Enforced so parallel issues stay in their directory. */
const ALLOWED: Record<ModuleName | "root", readonly (ModuleName | "root")[]> = {
  root: MODULES,
  config: ["core", "credentials"],
  credentials: ["db"],
  slack: ["config", "credentials"],
  core: [],
  db: ["core"],
  linear: ["core", "credentials"],
  intake: ["core", "linear"],
  acp: ["core", "config", "process"],
  closeout: ["closeout-spec"],
  "closeout-spec": ["core"],
  github: ["process"],
  questions: ["core"],
  web: ["db"],
  server: [
    "slack",
    "config",
    "linear",
    "github",
    "web",
    "auth",
    "settings",
    "db",
    "workspace",
    "deployment",
  ],
  settings: ["config"],
  host: ["core", "db"],
  loop: ["core", "db", "linear", "intake", "acp", "closeout", "github", "questions", "config"],
  doctor: [
    "credentials",
    "config",
    "acp",
    "comments",
    "github",
    "install",
    "auth",
    "closeout-spec",
  ],
  comments: ["core", "linear", "questions"],
  install: ["acp", "config"],
  deployment: ["config"],
  // setup is the wizard. It is allowed to import install (and comments) through index.ts.
  setup: [
    "db",
    "credentials",
    "config",
    "core",
    "linear",
    "comments",
    "github",
    "acp",
    "install",
    "auth",
  ],
  auth: ["config", "github", "credentials"],
  workspace: ["db", "linear", "slack"],
  "runner-identity": ["credentials"],
  "runner-protocol": [],
  "runner-execution": ["runner-protocol"],
  "runner-repositories": ["github", "runner-protocol"],
  process: [],
  "runner-worker": ["acp", "runner-execution", "runner-answers", "install"],
  "runner-answers": ["runner-execution"],
  "runner-control": ["db", "workspace", "runner-identity"],
  "runner-daemon": ["db", "credentials", "runner-identity", "runner-protocol"],
  "runner-work": ["db", "workspace", "runner-protocol", "questions"],
  "runner-results": ["db", "runner-work", "runner-protocol"],
  "runner-health": ["db", "workspace", "runner-work", "runner-protocol"],
  "runner-coordinator": [
    "credentials",
    "runner-control",
    "runner-identity",
    "runner-work",
    "runner-results",
    "runner-health",
    "workspace",
  ],
};

describe("module boundaries", () => {
  test("every module has an index and only imports allowed public APIs", () => {
    for (const name of MODULES) {
      expect(statSync(join(SRC, name, "index.ts")).isFile()).toBe(true);
    }
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith(".ts")) continue;
      const importer = moduleOf(file);
      const text = readFileSync(file, "utf8");
      for (const spec of imports(text)) {
        if (!spec.startsWith(".")) continue;
        const resolved = resolve(dirname(file), spec);
        const target = moduleOf(resolved);
        if (target === importer) continue;
        const rel = relative(SRC, resolved);
        if (!isPublicApi(rel)) {
          violations.push(`${relative(SRC, file)} imports ${spec} (deep)`);
          continue;
        }
        const allowed = ALLOWED[importer];
        if (!allowed.includes(target as ModuleName)) {
          violations.push(`${relative(SRC, file)} imports ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function isPublicApi(rel: string): boolean {
  const parts = rel.split("/").filter((part) => part.length > 0);
  if (parts.length === 1) return isModule(parts[0]);
  if (parts.length === 2 && (parts[1] === "index" || parts[1] === "index.ts"))
    return isModule(parts[0]);
  return false;
}

function isModule(name: string | undefined): name is ModuleName {
  return MODULES.some((module) => module === name);
}

function moduleOf(path: string): ModuleName | "root" {
  const rel = relative(SRC, path);
  const [top, second] = rel.split("/");
  if (top === undefined || top.length === 0 || (second === undefined && top.endsWith(".ts")))
    return "root";
  if (!isModule(top)) return "root";
  return top;
}

function imports(source: string): string[] {
  const found: string[] = [];
  const pattern = /from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}
