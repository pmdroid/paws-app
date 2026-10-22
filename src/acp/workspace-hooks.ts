import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HookAgent, type HookEvent, type WorkspaceHook } from "../core";
import { ALLOWED_AGENT_ENV } from "./env";

/** Extra seconds the agent waits past the hook's own timeout, so the wrapper records the timeout first. */
const AGENT_TIMEOUT_GRACE_SECONDS = 5;

/** Variables a hook keeps on top of the agent allowlist: the project dir and commit identity. */
const HOOK_EXTRA_ENV = [
  "CLAUDE_PROJECT_DIR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

export const HOOK_FAILURES_FILE = "hook-failures.jsonl";

type AgentEvent = { name: "PreToolUse" | "PostToolUse" | "Stop"; key: string; matcher?: string };

/** Each agent's own hook event and tool matcher for a workspace hook. */
export function agentHookEvent(
  agent: HookAgent,
  event: HookEvent,
  matcher: string | null,
): AgentEvent {
  switch (event) {
    case "after_edit":
      return {
        name: "PostToolUse",
        key: "post_tool_use",
        matcher:
          agent === "claude" ? "Edit|Write|MultiEdit|NotebookEdit" : "apply_patch|Edit|Write",
      };
    case "before_shell":
      return { name: "PreToolUse", key: "pre_tool_use", matcher: "Bash" };
    case "before_tool":
      return { name: "PreToolUse", key: "pre_tool_use", ...(matcher ? { matcher } : {}) };
    case "stop":
      return { name: "Stop", key: "stop" };
  }
}

export type InstalledWorkspaceHook = {
  hook: WorkspaceHook;
  event: AgentEvent;
  /** Wrapper that runs the hook with the stripped environment. */
  scriptPath: string;
  /** What the agent waits for, in seconds. */
  timeout: number;
};

/** The hooks that apply to `agent`, in the order they were registered. */
export function hooksForAgent(
  hooks: readonly WorkspaceHook[] | undefined,
  agent: string,
): WorkspaceHook[] {
  return (hooks ?? []).filter((hook) => (hook.agents as readonly string[]).includes(agent));
}

/** Write one wrapper per hook into the run directory. */
export async function installWorkspaceHooks(input: {
  agent: HookAgent;
  hooks: readonly WorkspaceHook[];
  runDirectory: string;
  pythonPath: string;
}): Promise<InstalledWorkspaceHook[]> {
  const installed: InstalledWorkspaceHook[] = [];
  for (const [index, hook] of hooksForAgent(input.hooks, input.agent).entries()) {
    const scriptPath = join(input.runDirectory, `workspace-hook-${index}`);
    await writeFile(
      scriptPath,
      workspaceHookScript({
        agent: input.agent,
        hook,
        pythonPath: input.pythonPath,
        failuresPath: join(input.runDirectory, HOOK_FAILURES_FILE),
      }),
      { mode: 0o700 },
    );
    await chmod(scriptPath, 0o700);
    installed.push({
      hook,
      event: agentHookEvent(input.agent, hook.event, hook.matcher),
      scriptPath,
      timeout: hook.timeoutSeconds + AGENT_TIMEOUT_GRACE_SECONDS,
    });
  }
  return installed;
}

type HookGroup = { matcher?: string; hooks: Record<string, unknown>[] };
export type AgentHooks = Partial<Record<AgentEvent["name"], HookGroup[]>>;

/**
 * Closeout's Stop hook first, then each workspace hook in its own group.
 * A workspace hook only ever adds a group, so it cannot remove or take the place of Closeout's.
 */
export function mergeHooks(
  closeout: HookGroup,
  workspace: readonly InstalledWorkspaceHook[],
  command: (hook: InstalledWorkspaceHook) => Record<string, unknown>,
): AgentHooks {
  const merged: AgentHooks = { Stop: [closeout] };
  for (const hook of workspace) {
    const groups = (merged[hook.event.name] ??= []);
    groups.push({
      ...(hook.event.matcher ? { matcher: hook.event.matcher } : {}),
      hooks: [{ type: "command", ...command(hook), timeout: hook.timeout }],
    });
  }
  return merged;
}

/** `[hooks.state]` entries that trust each Codex hook, keyed the way Codex lists them. */
export function codexHookTrust(
  hooksPath: string,
  document: AgentHooks,
  hash: (body: Record<string, unknown>) => string,
): { key: string; hash: string }[] {
  const entries: { key: string; hash: string }[] = [];
  const keys = { PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", Stop: "stop" } as const;
  for (const [name, groups] of Object.entries(document) as [keyof typeof keys, HookGroup[]][]) {
    for (const [group, entry] of groups.entries())
      for (const [index, handler] of entry.hooks.entries())
        entries.push({
          key: `${hooksPath}:${keys[name]}:${group}:${index}`,
          hash: hash({
            event_name: keys[name],
            ...(entry.matcher ? { matcher: entry.matcher } : {}),
            hooks: [{ async: false, ...handler }],
          }),
        });
  }
  return entries;
}

export type HookFailure = { id: string; event: HookEvent; command: string; reason: string };

/** Read failures the wrappers appended since `offset`. */
export function readHookFailures(
  path: string,
  offset: number,
): { failures: HookFailure[]; offset: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { failures: [], offset };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { failures: [], offset };
    const bytes = Buffer.alloc(Math.min(size - offset, 1_048_576));
    const read = readSync(fd, bytes, 0, bytes.length, offset);
    const text = bytes.subarray(0, read).toString("utf8");
    const end = text.lastIndexOf("\n") + 1;
    const failures: HookFailure[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      try {
        const value = JSON.parse(line) as Partial<HookFailure>;
        if (
          typeof value.id === "string" &&
          typeof value.event === "string" &&
          typeof value.command === "string" &&
          typeof value.reason === "string"
        )
          failures.push({
            id: value.id,
            event: value.event,
            command: value.command.slice(0, 512),
            reason: value.reason.slice(0, 1024),
          });
      } catch {}
    }
    return { failures, offset: offset + Buffer.byteLength(text.slice(0, end)) };
  } finally {
    closeSync(fd);
  }
}

/** Poll the run's failure file and report each failed hook once. */
export function watchHookFailures(
  runDirectory: string,
  report: (failure: HookFailure) => void,
  intervalMs = 1_000,
): () => void {
  const path = join(runDirectory, HOOK_FAILURES_FILE);
  let offset = 0;
  const drain = () => {
    const next = readHookFailures(path, offset);
    offset = next.offset;
    for (const failure of next.failures) report(failure);
  };
  const timer = setInterval(drain, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    drain();
  };
}

/**
 * The wrapper the agent runs for one workspace hook. It keeps only the agent allowlist in the
 * environment, enforces the timeout on the whole process group, drops `continue`/`stopReason`
 * so a hook cannot end the session past Closeout, and records failures for the run page.
 */
export function workspaceHookScript(input: {
  agent: HookAgent;
  hook: WorkspaceHook;
  pythonPath: string;
  failuresPath: string;
}): string {
  const { hook } = input;
  const skillDir =
    hook.skill === null
      ? null
      : input.agent === "claude"
        ? { base: "CLAUDE_CONFIG_DIR", fallback: ".claude", path: `skills/${hook.skill}` }
        : { base: null, fallback: ".agents", path: `skills/${hook.skill}` };
  return `#!${input.pythonPath}
import json, os, signal, subprocess, sys, time
HOOK = json.loads(${python({ id: hook.id, event: hook.event, command: hook.command, timeout: hook.timeoutSeconds })})
ALLOWED = set(json.loads(${python([...ALLOWED_AGENT_ENV, ...HOOK_EXTRA_ENV])}))
FAILURES = json.loads(${python(input.failuresPath)})
SKILL = json.loads(${python(skillDir)})
def record(reason):
    try:
        with open(FAILURES, "a") as out:
            out.write(json.dumps({"id": HOOK["id"], "event": HOOK["event"], "command": HOOK["command"], "reason": reason, "at": int(time.time() * 1000)}) + "\\n")
    except Exception:
        pass
def sanitize(out):
    try:
        value = json.loads(out)
    except Exception:
        return out
    if not isinstance(value, dict):
        return out
    value.pop("continue", None)
    value.pop("stopReason", None)
    return (json.dumps(value, separators=(",", ":")) + "\\n").encode()
def main():
    env = {k: v for k, v in os.environ.items() if k in ALLOWED}
    if SKILL is not None:
        base = env.get(SKILL["base"]) if SKILL["base"] else None
        base = base or os.path.join(env.get("HOME", "/"), SKILL["fallback"])
        env["PAWS_SKILL_DIR"] = os.path.join(base, SKILL["path"])
    data = sys.stdin.buffer.read()
    try:
        child = subprocess.Popen(["/bin/sh", "-c", HOOK["command"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    except Exception as error:
        record("could not start: " + str(error))
        return 0
    try:
        out, err = child.communicate(data, timeout=HOOK["timeout"])
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except Exception:
            pass
        child.communicate()
        record("timed out after %ds" % HOOK["timeout"])
        return 0
    sys.stdout.buffer.write(sanitize(out))
    sys.stderr.buffer.write(err)
    code = child.returncode
    if code not in (0, 2):
        last = err.decode("utf-8", "replace").strip().splitlines()
        record(("exited with %d" % code) + (": " + last[-1][:300] if last else ""))
    return code if code >= 0 else 1
if __name__ == "__main__":
    sys.exit(main())
`;
}

/** A Python string literal holding `value` as JSON, so `null` and escapes survive. */
function python(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}
