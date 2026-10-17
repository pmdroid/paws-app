import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const CLOSEOUT_STOP_TIMEOUT_SECONDS = 30;

const FINISH_UNAVAILABLE_REASON = "Cannot finish yet. Closeout status is unavailable.";

export const CLOSEOUT_FINISH_UNAVAILABLE = JSON.stringify({
  decision: "block",
  reason: FINISH_UNAVAILABLE_REASON,
});

export type CloseoutStopAgent = "claude" | "codex" | "grok";

export type InstalledCloseoutStopHook = {
  scriptPath: string;
  env: Record<string, string>;
  sessionMeta?: Record<string, unknown>;
};

export function closeoutFinishLine(report: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
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
  const body = canonicalJson({
    event_name: "stop",
    hooks: [{ async: false, command, timeout: timeoutSeconds, type: "command" }],
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function codexConfigWithStopHook(
  source: string,
  stateKey: string,
  trustedHash: string,
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
  const quoted = stateKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  lines.push(
    "",
    `[hooks.state."${quoted}"]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    "enabled = true",
  );
  return `${lines.join("\n")}\n`;
}

export function closeoutStopScript(socketPath: string, pythonPath: string): string {
  return `#!${pythonPath}
import json, socket, sys, threading
SOCKET = ${JSON.stringify(socketPath)}
UNAVAILABLE = ${JSON.stringify(CLOSEOUT_FINISH_UNAVAILABLE)}
def drain():
    try:
        sys.stdin.read()
    except Exception:
        return
threading.Thread(target=drain, daemon=True).start()
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
def block():
    sys.stdout.write(UNAVAILABLE + "\\n")
def main():
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(20)
        client.connect(SOCKET)
        client.sendall(b'{"id":1,"tool":"closeout_finish","arguments":{}}\\n')
        data = b""
        while b"\\n" not in data and len(data) < 65536:
            chunk = client.recv(4096)
            if not chunk:
                break
            data += chunk
        client.close()
        message = json.loads(data.split(b"\\n", 1)[0])
        answer = message.get("answer") if isinstance(message, dict) else None
        if not isinstance(answer, str):
            block()
            return
        decision = json.loads(answer)
        if decision == {}:
            emit({})
            return
        if (
            isinstance(decision, dict)
            and decision.get("decision") == "block"
            and isinstance(decision.get("reason"), str)
            and set(decision) == {"decision", "reason"}
        ):
            emit({"decision": "block", "reason": decision["reason"]})
            return
        block()
    except Exception:
        block()
if __name__ == "__main__":
    main()
`;
}

export async function installCloseoutStopHook(input: {
  agent: CloseoutStopAgent;
  runDirectory: string;
  socketPath: string;
  sourceEnv: NodeJS.ProcessEnv;
}): Promise<InstalledCloseoutStopHook | undefined> {
  if (input.agent === "grok") return undefined;
  const pythonPath = Bun.which("python3");
  if (!pythonPath) throw new Error("python3 is required for the closeout stop hook");
  await mkdir(input.runDirectory, { recursive: true, mode: 0o700 });
  const scriptPath = join(input.runDirectory, "closeout-stop");
  await writeFile(scriptPath, closeoutStopScript(input.socketPath, pythonPath), { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  if (input.agent === "claude") {
    return {
      scriptPath,
      env: {},
      sessionMeta: claudeStopMeta(scriptPath, pythonPath),
    };
  }
  const overlay = join(input.runDirectory, "codex-home");
  const hooksPath = join(overlay, "hooks.json");
  const sourceConfig = await linkCodexHome(codexSourceHome(input.sourceEnv), overlay);
  const trustedHash = codexStopHookTrustHash(scriptPath, CLOSEOUT_STOP_TIMEOUT_SECONDS);
  const stateKey = `${hooksPath}:stop:0:0`;
  await writeFile(hooksPath, `${JSON.stringify(codexHooksDocument(scriptPath))}\n`, {
    mode: 0o600,
  });
  await chmod(hooksPath, 0o600);
  const configPath = join(overlay, "config.toml");
  await writeFile(configPath, codexConfigWithStopHook(sourceConfig ?? "", stateKey, trustedHash), {
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  await chmod(overlay, 0o700);
  return { scriptPath, env: { CODEX_HOME: overlay } };
}

function claudeStopMeta(scriptPath: string, pythonPath: string): Record<string, unknown> {
  return {
    claudeCode: {
      options: {
        settingSources: ["user", "project"],
        settings: {
          attribution: { commit: "", pr: "" },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: pythonPath,
                    args: [scriptPath],
                    timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
                  },
                ],
              },
            ],
          },
        },
        env: {
          CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "100",
        },
      },
    },
  };
}

function codexHooksDocument(scriptPath: string): Record<string, unknown> {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: scriptPath,
              timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

function codexSourceHome(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return resolve(configured);
  const home = env.HOME?.trim();
  if (home) return join(resolve(home), ".codex");
  return undefined;
}

async function linkCodexHome(
  source: string | undefined,
  overlay: string,
): Promise<string | undefined> {
  await mkdir(overlay, { recursive: true, mode: 0o700 });
  if (!source) return undefined;
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "config.toml" || entry.name === "hooks.json") continue;
    await symlink(join(source, entry.name), join(overlay, entry.name));
  }
  const configPath = join(source, "config.toml");
  try {
    await lstat(configPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return readFile(configPath, "utf8");
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

function block(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}
