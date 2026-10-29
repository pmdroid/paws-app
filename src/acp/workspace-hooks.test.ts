import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { WorkspaceHook } from "../core";
import {
  CLOSEOUT_STOP_TIMEOUT_SECONDS,
  codexHookHash,
  codexStopHookTrustHash,
  installCloseoutStopHook,
} from "./closeout-hook";
import { HOOK_FAILURES_FILE, agentHookEvent, readHookFailures } from "./workspace-hooks";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-hooks-"));
  roots.push(root);
  return root;
}

function hook(overrides: Partial<WorkspaceHook>): WorkspaceHook {
  return {
    id: "hook_fmt",
    event: "after_edit",
    matcher: null,
    command: "bun run fmt",
    timeoutSeconds: 30,
    agents: ["claude", "codex"],
    skill: null,
    ...overrides,
  };
}

type Handler = { type: string; command: string; args?: string[]; timeout: number };
type Group = { matcher?: string; hooks: Handler[] };
type Hooks = Record<string, Group[]>;

async function install(agent: "claude" | "codex", hooks: WorkspaceHook[], skillRoot?: string) {
  const root = temp();
  const runDirectory = join(root, "run");
  const installed = await installCloseoutStopHook({
    agent,
    runDirectory,
    socketPath: join(runDirectory, "ask-team.sock"),
    sourceEnv: { HOME: join(root, "home") },
    workspaceHooks: hooks,
    skillRoot,
  });
  return { installed: installed!, runDirectory };
}

function claudeHooks(meta: Record<string, unknown> | undefined): Hooks {
  const claude = meta?.claudeCode as { options: { settings: { hooks: Hooks } } } | undefined;
  if (!claude) throw new Error("Claude session metadata is missing");
  return claude.options.settings.hooks;
}

async function runWrapper(
  script: string,
  input: string,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([script, ...args], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

test("a Claude session's settings carry the workspace hook and the Closeout hook", async () => {
  const { installed, runDirectory } = await install("claude", [
    hook({}),
    hook({
      id: "hook_guard",
      event: "before_shell",
      command: "guard-secrets.sh",
      agents: ["claude"],
    }),
    hook({ id: "hook_codex", event: "stop", command: "codex-only", agents: ["codex"] }),
  ]);
  const hooks = claudeHooks(installed.sessionMeta);
  const closeout = hooks.Stop?.[0]?.hooks[0];
  expect(closeout?.args).toEqual([installed.scriptPath]);
  expect(closeout?.timeout).toBe(CLOSEOUT_STOP_TIMEOUT_SECONDS);
  // The Codex-only Stop hook stays out of Claude's settings.
  expect(hooks.Stop).toHaveLength(1);
  expect(hooks.PostToolUse?.[0]?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
  expect(hooks.PostToolUse?.[0]?.hooks[0]?.args).toEqual([join(runDirectory, "workspace-hook-0")]);
  expect(hooks.PostToolUse?.[0]?.hooks[0]?.timeout).toBe(35);
  expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
  expect(readFileSync(join(runDirectory, "workspace-hook-0"), "utf8")).toContain("bun run fmt");
  expect(readFileSync(join(runDirectory, "workspace-hook-1"), "utf8")).toContain(
    "guard-secrets.sh",
  );
});

test("the Codex overlay carries the workspace hook and the Closeout hook, both trusted", async () => {
  const { installed, runDirectory } = await install("codex", [
    hook({}),
    hook({ id: "hook_any", event: "before_tool", matcher: "mcp__.*", command: "audit-tool" }),
    hook({ id: "hook_stop", event: "stop", command: "notify-stop" }),
  ]);
  const overlay = installed.env.CODEX_HOME!;
  const hooksPath = join(overlay, "hooks.json");
  const hooks = (JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Hooks }).hooks;
  expect(hooks.Stop?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: installed.scriptPath,
    timeout: CLOSEOUT_STOP_TIMEOUT_SECONDS,
  });
  const edit = join(runDirectory, "workspace-hook-0");
  expect(hooks.PostToolUse?.[0]).toEqual({
    matcher: "apply_patch|Edit|Write",
    hooks: [{ type: "command", command: edit, timeout: 35 }],
  });
  expect(hooks.PreToolUse?.[0]?.matcher).toBe("mcp__.*");
  expect(hooks.Stop?.[1]?.hooks[0]?.command).toBe(join(runDirectory, "workspace-hook-2"));

  const config = readFileSync(join(overlay, "config.toml"), "utf8");
  const closeoutHash = codexStopHookTrustHash(installed.scriptPath, CLOSEOUT_STOP_TIMEOUT_SECONDS);
  expect(config).toContain(
    `[hooks.state."${hooksPath}:stop:0:0"]\ntrusted_hash = "${closeoutHash}"`,
  );
  const editHash = codexHookHash({
    event_name: "post_tool_use",
    matcher: "apply_patch|Edit|Write",
    hooks: [{ async: false, type: "command", command: edit, timeout: 35 }],
  });
  expect(config).toContain(
    `[hooks.state."${hooksPath}:post_tool_use:0:0"]\ntrusted_hash = "${editHash}"`,
  );
  expect(config).toContain(`[hooks.state."${hooksPath}:pre_tool_use:0:0"]`);
  expect(config).toContain(`[hooks.state."${hooksPath}:stop:1:0"]`);
});

test("a workspace hook cannot replace or remove the Closeout hook", async () => {
  for (const agent of ["claude", "codex"] as const) {
    const root = temp();
    const runDirectory = join(root, "run");
    const closeoutPath = join(runDirectory, "closeout-stop");
    const installed = await installCloseoutStopHook({
      agent,
      runDirectory,
      socketPath: join(runDirectory, "ask-team.sock"),
      sourceEnv: { HOME: join(root, "home") },
      // A Stop hook that names Closeout's own script and tries to end the session.
      workspaceHooks: [
        hook({
          id: "hook_evil",
          event: "stop",
          command: `${closeoutPath}; echo '{"continue":false}'`,
        }),
      ],
    });
    const hooks =
      agent === "claude"
        ? claudeHooks(installed!.sessionMeta)
        : (
            JSON.parse(readFileSync(join(installed!.env.CODEX_HOME!, "hooks.json"), "utf8")) as {
              hooks: Hooks;
            }
          ).hooks;
    expect(hooks.Stop).toHaveLength(2);
    const first = hooks.Stop?.[0]?.hooks[0];
    expect(agent === "claude" ? first?.args : [first?.command]).toEqual([closeoutPath]);
    const second = hooks.Stop?.[1]?.hooks[0];
    expect(agent === "claude" ? second?.args : [second?.command]).toEqual([
      join(runDirectory, "workspace-hook-0"),
    ]);
    // Closeout's script is untouched and still refuses to finish without Paws.
    expect(readFileSync(closeoutPath, "utf8")).toContain("closeout_finish");
  }
});

test("a hook's output cannot end the session past Closeout", async () => {
  const { runDirectory } = await install("claude", [
    hook({
      event: "stop",
      command: `printf '{"continue":false,"stopReason":"done","decision":"block","reason":"lint"}'`,
    }),
  ]);
  const ran = await runWrapper(join(runDirectory, "workspace-hook-0"), "{}", {
    PATH: process.env.PATH!,
  });
  expect(ran.status).toBe(0);
  expect(JSON.parse(ran.stdout)).toEqual({ decision: "block", reason: "lint" });
});

test("a hook's environment holds no Paws secrets", async () => {
  const { runDirectory } = await install("claude", [hook({ command: "env; cat" })]);
  const ran = await runWrapper(join(runDirectory, "workspace-hook-0"), '{"tool_name":"Edit"}', {
    PATH: process.env.PATH!,
    HOME: "/var/lib/paws-runner-members/member",
    LANG: "C.UTF-8",
    CLAUDE_PROJECT_DIR: "/work/repo",
    LINEAR_API_KEY: "lin_api_secret",
    GITHUB_TOKEN: "ghs_secret",
    PAWS_WEBHOOK_SECRET: "whsec_secret",
    PAWS_RUNNER_TOKEN: "runner_secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-secret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    AWS_SECRET_ACCESS_KEY: "aws_secret",
  });
  expect(ran.status).toBe(0);
  const env = Object.fromEntries(
    ran.stdout
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  expect(env.HOME).toBe("/var/lib/paws-runner-members/member");
  expect(env.CLAUDE_PROJECT_DIR).toBe("/work/repo");
  expect(ran.stdout).toContain('{"tool_name":"Edit"}');
  expect(ran.stdout).not.toMatch(/secret|SSH_AUTH_SOCK/);
  for (const key of ["LINEAR_API_KEY", "GITHUB_TOKEN", "PAWS_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"])
    expect(env[key]).toBeUndefined();
});

test("a skill hook finds its script in the agent's installed skill folder", async () => {
  const { runDirectory } = await install("claude", [
    hook({ command: 'printf %s "$PAWS_SKILL_DIR"', skill: "guard" }),
  ]);
  const ran = await runWrapper(join(runDirectory, "workspace-hook-0"), "{}", {
    PATH: process.env.PATH!,
    HOME: "/home/agent",
  });
  expect(ran.stdout).toBe("/home/agent/.claude/skills/guard\n".trimEnd());
});

test("a skill hook executes from the supplied per-run skill root", async () => {
  for (const agent of ["claude", "codex"] as const) {
    const root = temp();
    const versioned = join(root, "skill-set");
    const skillRoot = agent === "claude" ? versioned : join(versioned, ".codex", "skills");
    const skillDirectory =
      agent === "claude" ? join(skillRoot, ".claude", "skills", "guard") : join(skillRoot, "guard");
    mkdirSync(skillDirectory, { recursive: true });
    const script = join(skillDirectory, "check");
    writeFileSync(script, "#!/bin/sh\nprintf 'executed:%s' \"$0\"\n", { mode: 0o700 });

    const { runDirectory } = await install(
      agent,
      [hook({ command: '"$PAWS_SKILL_DIR/check"', skill: "guard" })],
      skillRoot,
    );
    const ran = await runWrapper(join(runDirectory, "workspace-hook-0"), "{}", {
      PATH: process.env.PATH!,
      HOME: join(root, "legacy-home"),
    });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toBe(`executed:${script}`);
  }
});

test("a failing or slow hook is recorded for the run page and does not block the agent", async () => {
  const { runDirectory } = await install("claude", [
    hook({ command: "echo 'lint failed' >&2; exit 3" }),
    hook({ id: "hook_slow", event: "before_shell", command: "sleep 5", timeoutSeconds: 1 }),
    hook({ id: "hook_block", event: "before_shell", command: "echo no >&2; exit 2" }),
  ]);
  const env = { PATH: process.env.PATH! };
  expect((await runWrapper(join(runDirectory, "workspace-hook-0"), "{}", env)).status).toBe(3);
  expect((await runWrapper(join(runDirectory, "workspace-hook-1"), "{}", env)).status).toBe(0);
  // Exit 2 is the hook deliberately blocking a tool, not a failure.
  expect((await runWrapper(join(runDirectory, "workspace-hook-2"), "{}", env)).status).toBe(2);
  const { failures, offset } = readHookFailures(join(runDirectory, HOOK_FAILURES_FILE), 0);
  expect(failures).toEqual([
    {
      id: "hook_fmt",
      event: "after_edit",
      command: "echo 'lint failed' >&2; exit 3",
      reason: "exited with 3: lint failed",
    },
    { id: "hook_slow", event: "before_shell", command: "sleep 5", reason: "timed out after 1s" },
  ]);
  expect(readHookFailures(join(runDirectory, HOOK_FAILURES_FILE), offset).failures).toEqual([]);
});

test("a session start hook maps to SessionStart for Claude and Codex, without a matcher", () => {
  for (const agent of ["claude", "codex"] as const)
    expect(agentHookEvent(agent, "session_start", null)).toEqual({
      name: "SessionStart",
      key: "session_start",
    });
});

test("a session start hook runs once when a Claude or Codex session starts", async () => {
  for (const agent of ["claude", "codex"] as const) {
    const marker = join(temp(), "started");
    const { installed } = await install(agent, [
      hook({ id: "hook_start", event: "session_start", command: `echo started >> ${marker}` }),
      hook({ id: "hook_edit", command: `echo edited >> ${marker}` }),
    ]);
    const hooksPath = agent === "codex" ? join(installed.env.CODEX_HOME!, "hooks.json") : "";
    const hooks =
      agent === "claude"
        ? claudeHooks(installed.sessionMeta)
        : (JSON.parse(readFileSync(hooksPath, "utf8")) as { hooks: Hooks }).hooks;
    expect(hooks.SessionStart).toHaveLength(1);
    const [group] = hooks.SessionStart!;
    expect(group?.matcher).toBeUndefined();
    expect(group?.hooks).toHaveLength(1);
    const handler = group!.hooks[0]!;
    const ran = await runWrapper(
      handler.command,
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      { PATH: process.env.PATH! },
      handler.args,
    );
    expect(ran.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("started\n");
    if (agent === "codex")
      expect(readFileSync(join(installed.env.CODEX_HOME!, "config.toml"), "utf8")).toContain(
        `[hooks.state."${hooksPath}:session_start:0:0"]`,
      );
  }
});
