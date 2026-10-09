import type { Finding, Severity } from "./types";

const SEVERITIES = new Set<Severity>(["P0", "P1", "P2", "P3"]);

export function validateFindings(findings: Finding[]): string | null {
  if (!Array.isArray(findings)) return "findings must be an array";
  if (findings.length > 200) return "findings exceed 200";
  for (const finding of findings) {
    if (!SEVERITIES.has(finding.severity)) return "finding severity is invalid";
    if (!nonEmpty(finding.location, 512)) return "finding location is invalid";
    if (!nonEmpty(finding.explanation, 8000)) return "finding explanation is invalid";
    if (!nonEmpty(finding.evidence, 8000)) return "finding evidence is invalid";
  }
  return null;
}

function nonEmpty(value: string, max: number): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

const DENY = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "SSH_AUTH_SOCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

export function closeoutEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (DENY.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

export async function spawnCloseout(input: {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SpawnResult> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([input.bin, ...input.args], {
      cwd: input.cwd,
      env: input.env ?? closeoutEnv(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;
  if (typeof stdoutStream === "number" || typeof stderrStream === "number") {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: "closeout pipes were not captured",
    };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(stdoutStream).text(),
    new Response(stderrStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function versionMatches(output: string, pinned: string): boolean {
  return output.split(/\s+/).includes(pinned);
}

export function runArgs(input: { base: string; head: string; taskId: string }): string[] {
  return [
    "run",
    "--gate",
    "beforePR",
    "--base",
    input.base,
    "--head",
    input.head,
    "--task",
    input.taskId,
    "--json",
  ];
}

export function decisionArgs(input: {
  base: string;
  head: string;
  taskId: string;
  candidate: { session: string; model: string; provider: string };
}): string[] {
  const args = [
    "decision",
    "--gate",
    "beforePR",
    "--base",
    input.base,
    "--head",
    input.head,
    "--task",
    input.taskId,
    "--json",
  ];
  if (input.candidate.session !== "") args.push("--candidate-session", input.candidate.session);
  if (input.candidate.model !== "") args.push("--candidate-model", input.candidate.model);
  if (input.candidate.provider !== "") args.push("--candidate-provider", input.candidate.provider);
  return args;
}

export function evidenceAddArgs(input: {
  itemId: string;
  base: string;
  head: string;
  taskId: string;
  session: string;
  model: string;
  provider: string;
  findingsPath: string;
}): string[] {
  return [
    "evidence",
    "add",
    "--gate",
    "beforePR",
    "--item",
    input.itemId,
    "--base",
    input.base,
    "--head",
    input.head,
    "--task",
    input.taskId,
    "--session",
    input.session,
    "--model",
    input.model,
    "--provider",
    input.provider,
    "--findings",
    input.findingsPath,
  ];
}
