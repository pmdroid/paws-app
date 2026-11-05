import { journalCaught } from "../journal";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceHook } from "../core";
import {
  codexHookTrust,
  installWorkspaceHooks,
  mergeHooks,
  type AgentHooks,
  type InstalledWorkspaceHook,
} from "./workspace-hooks";

export const CLOSEOUT_STOP_TIMEOUT_SECONDS = 30;
/** How long the stop hook waits for `closeout_finish`, inside the agent's own limit. */
const CLOSEOUT_STOP_WAIT_SECONDS = 25;

const FINISH_UNAVAILABLE_REASON = "Cannot finish yet. Closeout status is unavailable.";

export const CLOSEOUT_FINISH_UNAVAILABLE = JSON.stringify({
  decision: "block",
  reason: FINISH_UNAVAILABLE_REASON,
});

export type CloseoutStopAgent = "claude" | "codex" | "grok" | "opencode";

export type InstalledCloseoutStopHook = {
  scriptPath: string;
  env: Record<string, string>;
  sessionMeta?: Record<string, unknown>;
};

export function closeoutFinishLine(report: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch (caughtError1) {
    journalCaught(caughtError1, "closeout-hook.closeoutFinishLine.parse", null);
    return CLOSEOUT_FINISH_UNAVAILABLE;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return CLOSEOUT_FINISH_UNAVAILABLE;
  }
  const record = parsed as Record<string, unknown>;
  const pending = record.pending;
  const blocked = record.blocked;
  if (!Array.isArray(pending) || pending.some((id) => typeof id !== "string" || id.length === 0)) {
    return CLOSEOUT_FINISH_UNAVAILABLE;
  }
  if (blocked !== null && typeof blocked !== "string") return CLOSEOUT_FINISH_UNAVAILABLE;
  const ids = pending.filter((id): id is string => typeof id === "string");
  const required = Array.isArray(record.required) ? record.required : [];
  const onlyExhausted =
    ids.length === 0 &&
    required.some((item) => item?.status === "exhausted") &&
    required.every(
      (item) =>
        item?.status === "exhausted" || item?.status === "passed" || item?.kind === "review",
    );
  if (onlyExhausted) return "{}";
  if (typeof blocked === "string" && blocked.length > 0) {
    const lead = blocked.startsWith("Cannot finish yet.")
      ? blocked
      : `Cannot finish yet. ${blocked}`;
    const extra =
      ids.length === 0
        ? ""
        : `${lead.endsWith(".") ? "" : "."} Pending checks: ${ids.join(", ")}. Call get_closeout.`;
    return block(`${lead}${extra}`);
  }
  if (ids.length > 0) {
    const joined = ids.join(", ");
    const sentence =
      ids.length === 1 ? `Check ${joined} is not finished.` : `Checks ${joined} are not finished.`;
    return block(`Cannot finish yet. ${sentence} Call get_closeout.`);
  }
  return "{}";
}

export function codexStopHookTrustHash(command: string, timeoutSeconds: number): string {
  return codexHookHash({
    event_name: "stop",
    hooks: [{ async: false, command, timeout: timeoutSeconds, type: "command" }],
  });
}

/** The `currentHash` Codex lists for a hook group: SHA-256 of its canonical JSON. */
export function codexHookHash(body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

export function codexConfigWithStopHook(
  source: string,
  stateKey: string,
  trustedHash: string,
): string {
  return codexConfigWithTrustedHooks(source, [{ key: stateKey, hash: trustedHash }]);
}

/** Turn hooks on and trust each listed hook, the same way for Closeout's and the workspace's. */
export function codexConfigWithTrustedHooks(
  source: string,
  trusted: readonly { key: string; hash: string }[],
): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let table = "";
  let featuresHeader = -1;
  let featuresInline = -1;
  let hooksAssignment = -1;
  let dotted = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const header = /^\[([^[\]]+)]\s*(?:#.*)?$/.exec(trimmed);
    if (header?.[1]) {
      table = header[1].trim();
      if (table === "features" && featuresHeader < 0) featuresHeader = index;
      continue;
    }
    if (table === "features" && /^hooks\s*=/.test(trimmed) && hooksAssignment < 0) {
      hooksAssignment = index;
      dotted = false;
      continue;
    }
    if (table !== "") continue;
    if (/^features\.hooks\s*=/.test(trimmed) && hooksAssignment < 0) {
      hooksAssignment = index;
      dotted = true;
      continue;
    }
    if (/^features\s*=\s*\{/.test(trimmed) && featuresInline < 0) {
      featuresInline = index;
      if (/hooks\s*=/.test(trimmed) && hooksAssignment < 0) hooksAssignment = index;
    }
  }
  if (hooksAssignment >= 0) {
    const current = lines[hooksAssignment] ?? "";
    lines[hooksAssignment] = dotted
      ? "features.hooks = true"
      : current.trim().startsWith("features")
        ? current.replace(/hooks\s*=\s*false\b/, "hooks = true")
        : "hooks = true";
  } else if (featuresHeader >= 0) {
    lines.splice(featuresHeader + 1, 0, "hooks = true");
  } else if (featuresInline >= 0) {
    const current = lines[featuresInline] ?? "";
    lines[featuresInline] = current.replace(/\s*\}\s*$/, ", hooks = true }");
  } else {
    if (lines.length > 0) lines.push("");
    lines.push("[features]", "hooks = true");
  }
  for (const { key, hash } of trusted) {
    const quoted = key.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    lines.push(
      "",
      `[hooks.state."${quoted}"]`,
      `trusted_hash = ${JSON.stringify(hash)}`,
      "enabled = true",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The stop hook the agent runs: a self-contained TypeScript file for Bun, importing only Node
 * built-ins, so it reads nothing from the Paws tree and a Paws update mid-run cannot change it.
 */
export function closeoutStopScript(socketPath: string, bunPath: string): string {
  return `#!${bunPath}
import { connect } from "node:net";

const SOCKET = ${JSON.stringify(socketPath)};
const UNAVAILABLE = ${JSON.stringify(CLOSEOUT_FINISH_UNAVAILABLE)};
const WAIT_MS = ${CLOSEOUT_STOP_WAIT_SECONDS * 1000};
const MAX_BYTES = 65536;

let done = false;
function finish(line: string): void {
  if (done) return;
  done = true;
  process.stdout.write(\`\${line}\\n\`, () => process.exit(0));
}

function decide(data: Buffer): string {
  const message: unknown = JSON.parse(data.toString("utf8").split("\\n", 1)[0] ?? "");
  if (!message || typeof message !== "object" || Array.isArray(message)) return UNAVAILABLE;
  const answer = (message as Record<string, unknown>).answer;
  if (typeof answer !== "string") return UNAVAILABLE;
  const decision: unknown = JSON.parse(answer);
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return UNAVAILABLE;
  const record = decision as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys === "") return "{}";
  if (keys === "decision,reason" && record.decision === "block" && typeof record.reason === "string")
    return JSON.stringify({ decision: "block", reason: record.reason });
  return UNAVAILABLE;
}

process.stdin.on("data", () => {});
process.stdin.on("error", () => {});
setTimeout(() => finish(UNAVAILABLE), WAIT_MS);
try {
  let data = Buffer.alloc(0);
  const settle = () => {
    try {
      finish(decide(data));
    } catch {
      finish(UNAVAILABLE);
    }
  };
  const client = connect(SOCKET, () =>
    client.write('{"id":1,"tool":"closeout_finish","arguments":{}}\\n'),
  );
  client.on("data", (chunk: Buffer) => {
    data = Buffer.concat([data, chunk]);
    if (data.includes(10) || data.length >= MAX_BYTES) {
      client.destroy();
      settle();
    }
  });
  client.on("end", settle);
  client.on("error", () => finish(UNAVAILABLE));
} catch {
  finish(UNAVAILABLE);
}
`;
}

/** The shell command Codex runs for the stop hook: Bun with the script. */
export function closeoutStopCommand(bunPath: string, scriptPath: string): string {
  return `${shellQuote(bunPath)} ${shellQuote(scriptPath)}`;
}

export async function installCloseoutStopHook(input: {
  agent: CloseoutStopAgent;
  runDirectory: string;
  socketPath: string;
  sourceEnv: NodeJS.ProcessEnv;
  /** Registered workspace hooks. Each one runs after Closeout's, never in its place. */
  workspaceHooks?: readonly WorkspaceHook[];
  skillRoot?: string;
  codexSkills?: string;
}): Promise<InstalledCloseoutStopHook | undefined> {
  if (input.agent === "grok" || input.agent === "opencode") return undefined;
  const bunPath = process.execPath;
  try {
    await access(bunPath, constants.X_OK);
  } catch (error) {
    throw new Error(`the closeout stop hook runs with Bun at ${bunPath}, which is not executable`, {
      cause: error,
    });
  }
  await mkdir(input.runDirectory, { recursive: true, mode: 0o700 });
  const scriptPath = join(input.runDirectory, "closeout-stop.ts");
  await writeFile(scriptPath, closeoutStopScript(input.socketPath, bunPath), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  const workspace = await installWorkspaceHooks({
    agent: input.agent,
    hooks: input.workspaceHooks ?? [],
    runDirectory: input.runDirectory,
    skillRoot: input.skillRoot,
  });
  if (input.agent === "claude") {
    return {
      scriptPath,
      env: {},
      sessionMeta: claudeStopMeta(bunPath, scriptPath, workspace),
    };
  }
  const overlay = join(input.runDirectory, "codex-home");
  const hooksPath = join(overlay, "hooks.json");
  const sourceConfig = await linkCodexHome(
    codexSourceHome(input.sourceEnv),
    overlay,
    input.codexSkills,
  );
  const document = codexHooksDocument(closeoutStopCommand(bunPath, scriptPath), workspace);
  await writeFile(hooksPath, `${JSON.stringify(document)}\n`, {
    mode: 0o600,
  });
  await chmod(hooksPath, 0o600);
  const configPath = join(overlay, "config.toml");
  await writeFile(
    configPath,
    codexConfigWithTrustedHooks(
      sourceConfig ?? "",
      codexHookTrust(hooksPath, document.hooks, codexHookHash),
    ),
    {
      mode: 0o600,
    },
  );
  await chmod(configPath, 0o600);
  await chmod(overlay, 0o700);
  return { scriptPath, env: { CODEX_HOME: overlay } };
}

function claudeStopMeta(
  bunPath: string,
  scriptPath: string,
  workspace: readonly InstalledWorkspaceHook[],
): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        settingSources: ["user", "project"],
        settings: {
          attribution: { commit: "", pr: "" },
          hooks: mergeHooks(
            {
              hooks: [
                {
                  type: "command",
                  command: bunPath,
                  args: [scriptPath],
                  timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
                },
              ],
            },
            workspace,
            (hook) => ({ command: hook.interpreter, args: [hook.scriptPath] }),
          ),
        },
        env: {
          CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "100",
        },
      },
    },
  };
}

function codexHooksDocument(
  command: string,
  workspace: readonly InstalledWorkspaceHook[],
): { hooks: AgentHooks } {
  return {
    hooks: mergeHooks(
      {
        hooks: [{ type: "command", command, timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS }],
      },
      workspace,
      (hook) => ({ command: hook.scriptPath }),
    ),
  };
}

function codexSourceHome(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return resolve(configured);
  const home = env.HOME?.trim();
  if (home) return join(resolve(home), ".codex");
  return undefined;
}

export async function installCodexSkillsHome(input: {
  runDirectory: string;
  sourceEnv: NodeJS.ProcessEnv;
  codexSkills: string;
}): Promise<Record<string, string>> {
  await mkdir(input.runDirectory, { recursive: true, mode: 0o700 });
  const overlay = join(input.runDirectory, "codex-home");
  await linkCodexHome(codexSourceHome(input.sourceEnv), overlay, input.codexSkills, []);
  await chmod(overlay, 0o700);
  return { CODEX_HOME: overlay };
}

async function linkCodexHome(
  source: string | undefined,
  overlay: string,
  skills?: string,
  replaced: readonly string[] = ["config.toml", "hooks.json"],
): Promise<string | undefined> {
  await mkdir(overlay, { recursive: true, mode: 0o700 });
  if (skills) await linkCodexSkills(source, overlay, skills);
  if (!source) return undefined;
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      journalCaught(
        error,
        "closeout-hook.linkCodexHome.readdir",
        null,
        "optional file may be absent",
      );
      return undefined;
    }
    throw error;
  }
  for (const entry of entries) {
    if (replaced.includes(entry.name) || (skills && entry.name === "skills")) continue;
    await symlink(join(source, entry.name), join(overlay, entry.name));
  }
  const configPath = join(source, "config.toml");
  try {
    await lstat(configPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      journalCaught(
        error,
        "closeout-hook.linkCodexHome.lstat",
        null,
        "optional file may be absent",
      );
      return undefined;
    }
    throw error;
  }
  return readFile(configPath, "utf8");
}

async function linkCodexSkills(
  source: string | undefined,
  overlay: string,
  skills: string,
): Promise<void> {
  const folder = join(overlay, "skills");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const versioned = await names(skills);
  if (source)
    for (const name of await names(join(source, "skills")))
      if (!versioned.includes(name))
        await symlink(join(source, "skills", name), join(folder, name));
  for (const name of versioned) await symlink(join(skills, name), join(folder, name));
}

async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      journalCaught(error, "closeout-hook.names.readdir", null, "optional file may be absent");
      return [];
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function block(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}
