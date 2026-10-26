import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

const MODULES = [
  "journal",
  "onboarding",
  "runner-login",
  "runner-login-worker",
  "worktree-checkout",
  "config",
  "credentials",
  "slack",
  "core",
  "db",
  "linear",
  "intake",
  "execution-controls",
  "scheduler",
  "acp",
  "closeout",
  "closeout-spec",
  "github",
  "merge",
  "runner-repository-access",
  "questions",
  "decisions",
  "server",
  "settings",
  "web",
  "host",
  "loop",
  "doctor",
  "install",
  "deployment",
  "auth",
  "runner-protocol",
  "runner-execution",
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
  "runner-placement",
  "runner-results",
  "runner-health",
  "runner-models",
  "runner-helpers",
  "runner-runtime",
  "runner-health-runtime",
  "runner-journal",
  "runner-coordinator",
  "runner-transcripts",
  "runner-transcript-config",
  "agent-sessions",
  "runner-artifacts",
  "runner-inputs",
  "evidence",
  "skills",
  "runtimes",
  "runner-mise",
  "agent-catalog",
  "provisioning",
  "member-vm",
] as const;

type ModuleName = (typeof MODULES)[number];

/** Who may import whose public index. Enforced so parallel issues stay in their directory. */
const ALLOWED: Record<ModuleName | "root", readonly (ModuleName | "root")[]> = {
  root: MODULES,
  journal: ["core"],
  onboarding: ["journal", "config", "credentials", "db", "linear", "workspace", "web"],
  "worktree-checkout": ["journal"],
  config: ["journal", "core", "credentials", "worktree-checkout"],
  credentials: ["journal", "db"],
  slack: ["journal", "config", "credentials"],
  core: [],
  db: ["journal", "core", "runner-protocol"],
  linear: ["journal", "core", "credentials"],
  intake: ["journal", "core", "db", "linear"],
  "execution-controls": ["journal", "core", "db", "workspace"],
  scheduler: ["journal", "core", "db", "intake"],
  acp: ["journal", "core", "config", "process", "worktree-checkout", "closeout-spec"],
  closeout: ["journal", "core", "closeout-spec"],
  "closeout-spec": ["journal", "core", "worktree-checkout"],
  github: ["journal", "core", "process"],
  merge: ["journal", "core", "db", "github", "questions"],
  questions: ["core", "db", "workspace"],
  decisions: ["db", "scheduler"],
  web: ["db", "core"],
  evidence: ["journal", "db"],
  server: [
    "journal",
    "runner-placement",
    "runner-protocol",
    "evidence",
    "slack",
    "config",
    "linear",
    "github",
    "web",
    "auth",
    "settings",
    "skills",
    "db",
    "workspace",
    "deployment",
  ],
  settings: ["journal", "config", "core", "db", "skills", "workspace"],
  skills: ["journal", "core", "db", "runner-protocol"],
  runtimes: ["journal"],
  "agent-catalog": ["journal", "db"],
  host: ["journal", "core", "db"],
  loop: [
    "journal",
    "workspace",
    "decisions",
    "worktree-checkout",
    "core",
    "db",
    "linear",
    "intake",
    "scheduler",
    "acp",
    "closeout",
    "github",
    "merge",
    "questions",
    "config",
    "runtimes",
  ],
  doctor: [
    "journal",
    "credentials",
    "config",
    "db",
    "acp",
    "linear",
    "github",
    "install",
    "auth",
    "closeout-spec",
  ],
  install: ["journal", "acp", "config"],
  deployment: ["config"],
  // setup is the wizard. It is allowed to import install (and comments) through index.ts.
  auth: ["journal", "config", "github", "credentials", "core"],
  workspace: ["journal", "db", "linear", "slack", "decisions"],
  "runner-identity": ["journal", "credentials"],
  "runner-repository-access": ["journal", "github", "runner-work"],
  "runner-transcript-config": ["journal", "credentials", "runner-transcripts"],
  "runner-transcripts": ["journal", "db", "runner-work"],
  "agent-sessions": ["credentials", "db", "runner-work"],
  "runner-inputs": ["journal", "runner-protocol", "runner-work"],
  "runner-artifacts": ["journal", "acp", "runner-protocol", "runner-work"],
  "runner-protocol": ["journal"],
  "runner-login": ["journal", "db", "workspace", "runner-work", "runner-protocol"],
  "runner-login-worker": ["journal", "acp", "install", "runner-protocol"],
  "runner-execution": ["journal", "runner-protocol", "process"],
  "runner-repositories": ["journal", "github", "runner-protocol", "core"],
  process: ["journal"],
  "runner-cli": [
    "journal",
    "runner-daemon",
    "runner-execution",
    "runner-worker",
    "runner-runtime",
    "runner-health-runtime",
  ],
  "runner-worker": [
    "journal",
    "runner-login-worker",
    "worktree-checkout",
    "acp",
    "runner-execution",
    "runner-answers",
    "install",
    "runner-protocol",
    "runner-mise",
  ],
  "runner-mise": ["journal"],
  "runner-answers": ["journal", "runner-execution"],
  "runner-control": [
    "journal",
    "db",
    "workspace",
    "runner-identity",
    "runner-protocol",
    "agent-catalog",
  ],
  "runner-daemon": [
    "journal",
    "db",
    "credentials",
    "runner-identity",
    "runner-protocol",
    "runner-transcripts",
  ],
  "runner-work": ["journal", "db", "workspace", "runner-protocol", "questions"],
  "runner-placement": ["journal", "db", "linear", "runner-protocol", "workspace"],
  "runner-backend": [
    "journal",
    "core",
    "config",
    "runner-placement",
    "runner-inputs",
    "runner-transcripts",
    "runner-helpers",
    "db",
    "acp",
    "runner-work",
    "runner-results",
    "runner-health",
    "runner-artifacts",
    "runner-protocol",
    "workspace",
  ],
  "runner-results": ["journal", "db", "runner-work", "runner-protocol"],
  "runner-journal": ["db", "runner-protocol"],
  "runner-helpers": ["journal", "db", "runner-protocol", "workspace"],
  "runner-runtime": [
    "journal",
    "acp",
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
  "runner-health": ["journal", "db", "workspace", "runner-work", "runner-protocol"],
  "runner-health-runtime": [
    "journal",
    "runner-answers",
    "db",
    "runner-daemon",
    "runner-execution",
    "runner-protocol",
  ],
  "runner-coordinator": [
    "journal",
    "runner-models",
    "runner-login",
    "runner-inputs",
    "runner-helpers",
    "github",
    "runner-repository-access",
    "runner-artifacts",
    "runner-transcripts",
    "agent-sessions",
    "credentials",
    "runner-control",
    "runner-identity",
    "runner-work",
    "runner-results",
    "runner-health",
    "workspace",
  ],
  "runner-models": ["journal", "db", "runner-work", "runner-protocol"],
  provisioning: ["journal", "config"],
  "member-vm": ["journal", "db", "provisioning", "workspace"],
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
  test("return and question callers use the shared operations", () => {
    for (const file of walk(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith("-harness.ts"))
        continue;
      const source = readFileSync(file, "utf8");
      expect(
        source.match(/applyWorkItemEvent\([^;]*["'](?:ejected|closeout_rejected)["']/g),
        relative(SRC, file),
      ).toBeNull();
      if (relative(SRC, file) !== "loop/operations.ts") {
        expect(
          source.match(/applyWorkItemEvent\([^;]*["']blocking_question["']/g),
          relative(SRC, file),
        ).toBeNull();
      }
    }
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
