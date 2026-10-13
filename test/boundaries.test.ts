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
  "runner-repository-access",
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
  "runner-check",
  "runner-checks",
  "runner-check-runtime",
  "runner-verifier",
  "runner-repositories",
  "process",
  "runner-worker",
  "runner-cli",
  "runner-answers",
  "workspace",
  "runner-identity",
  "runner-control",
  "runner-daemon",
  "runner-work",
  "runner-backend",
  "runner-results",
  "runner-health",
  "runner-helpers",
  "runner-runtime",
  "runner-health-runtime",
  "runner-journal",
  "runner-coordinator",
  "runner-transcripts",
  "runner-transcript-config",
  "runner-artifacts",
  "runner-inputs",
  "runner-closeout",
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
  "runner-repository-access": ["github", "runner-work"],
  "runner-transcript-config": ["credentials", "runner-transcripts"],
  "runner-transcripts": ["db", "runner-work"],
  "runner-inputs": ["runner-protocol", "runner-work"],
  "runner-artifacts": ["acp", "runner-protocol", "runner-work"],
  "runner-closeout": ["closeout-spec", "runner-check"],
  "runner-protocol": [],
  "runner-execution": ["runner-protocol"],
  "runner-check": ["runner-execution"],
  "runner-checks": [
    "db",
    "runner-check",
    "runner-verifier",
    "runner-protocol",
    "runner-work",
    "workspace",
  ],
  "runner-verifier": ["runner-check"],
  "runner-check-runtime": [
    "db",
    "runner-daemon",
    "runner-execution",
    "runner-check",
    "runner-verifier",
    "runner-repositories",
    "runner-protocol",
    "github",
  ],
  "runner-repositories": ["github", "runner-protocol"],
  process: [],
  "runner-cli": [
    "runner-daemon",
    "runner-execution",
    "runner-worker",
    "runner-verifier",
    "runner-runtime",
    "runner-health-runtime",
    "runner-check-runtime",
  ],
  "runner-worker": ["acp", "runner-execution", "runner-answers", "install", "runner-protocol"],
  "runner-answers": ["runner-execution"],
  "runner-control": ["db", "workspace", "runner-identity", "runner-verifier"],
  "runner-daemon": [
    "db",
    "credentials",
    "runner-identity",
    "runner-protocol",
    "runner-transcripts",
    "runner-verifier",
    "runner-check",
  ],
  "runner-work": ["db", "workspace", "runner-protocol", "questions"],
  "runner-backend": [
    "runner-transcripts",
    "runner-helpers",
    "runner-checks",
    "runner-closeout",
    "workspace",
    "db",
    "acp",
    "runner-work",
    "runner-results",
    "runner-health",
    "runner-artifacts",
    "runner-protocol",
  ],
  "runner-results": ["db", "runner-work", "runner-protocol"],
  "runner-journal": ["db", "runner-protocol"],
  "runner-helpers": ["db", "runner-protocol", "workspace"],
  "runner-runtime": [
    "runner-transcripts",
    "runner-artifacts",
    "runner-daemon",
    "runner-execution",
    "runner-answers",
    "runner-repositories",
    "runner-protocol",
    "runner-journal",
    "github",
  ],
  "runner-health": ["db", "workspace", "runner-work", "runner-protocol"],
  "runner-health-runtime": ["db", "runner-daemon", "runner-execution", "runner-protocol"],
  "runner-coordinator": [
    "runner-inputs",
    "runner-helpers",
    "runner-checks",
    "github",
    "runner-repository-access",
    "runner-artifacts",
    "runner-transcripts",
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
