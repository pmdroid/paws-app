import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type FakeStep = {
  exit: number;
  stdout?: string;
  stderr?: string;
  decision?: Record<string, unknown>;
  mutate?: "commit";
  marker?: boolean;
};

export type FakeScenario = {
  version: string;
  steps: FakeStep[];
};

export type FakeInvocation = {
  argv: string[];
  githubToken: boolean;
  ghToken: boolean;
  ssh: boolean;
  findings: unknown;
};

const SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = path.dirname(fs.realpathSync(process.argv[1]));
const scenarioPath = path.join(dir, "scenario.json");
const logPath = path.join(dir, "invocations.json");
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

let findings = null;
const findingsPath = flag("--findings");
if (findingsPath) findings = JSON.parse(fs.readFileSync(findingsPath, "utf8"));

const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
log.push({
  argv,
  githubToken: Object.prototype.hasOwnProperty.call(process.env, "GITHUB_TOKEN"),
  ghToken: Object.prototype.hasOwnProperty.call(process.env, "GH_TOKEN"),
  ssh: Object.prototype.hasOwnProperty.call(process.env, "SSH_AUTH_SOCK"),
  findings,
});
fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

if (argv.includes("--version")) {
  process.stdout.write("closeout " + scenario.version + "\\n");
  process.exit(0);
}

const step = (scenario.steps || []).shift();
fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
if (!step) {
  process.stderr.write("no scripted step\\n");
  process.exit(2);
}
if (step.mutate === "commit") {
  execFileSync("git", ["commit", "--allow-empty", "-m", "moved-during-closeout"], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
}
if (step.marker) {
  const keepDir = path.join(process.cwd(), ".closeout");
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, "keep"), "kept\\n");
}
if (step.decision) {
  const decision = step.decision;
  const base = flag("--base");
  const head = flag("--head");
  if (base) decision.base = base;
  if (head) decision.head = head;
  process.stdout.write(JSON.stringify(decision));
} else if (step.stdout) {
  process.stdout.write(step.stdout);
}
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exit);
`;

export async function writeFakeCloseout(
  parent: string,
  scenario: FakeScenario,
): Promise<{
  bin: string;
  invocations: () => Promise<FakeInvocation[]>;
}> {
  const dir = path.join(parent, "fake-closeout");
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, "closeout");
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  await writeFile(path.join(dir, "scenario.json"), JSON.stringify(scenario, null, 2));
  return {
    bin,
    async invocations() {
      try {
        const text = await readFile(path.join(dir, "invocations.json"), "utf8");
        return JSON.parse(text) as FakeInvocation[];
      } catch {
        return [];
      }
    },
  };
}
