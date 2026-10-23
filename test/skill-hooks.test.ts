import { describe, expect, test } from "bun:test";
import { skillHooks } from "../src/skills";

const FOLDER = ".claude/skills/impeccable";
const SCRIPT = '"${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/impeccable"';
const IMPECCABLE = `[ ! -f ${SCRIPT} ] || ${SCRIPT} hook`;
const REWRITTEN =
  '[ ! -f "$PAWS_SKILL_DIR/scripts/impeccable" ] || "$PAWS_SKILL_DIR/scripts/impeccable" hook';

function files(entries: Record<string, unknown>) {
  return new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
    ]),
  );
}

function commandHook(text: string, timeout?: number) {
  return { type: "command", command: text, ...(timeout === undefined ? {} : { timeout }) };
}

function settings(hooks: Record<string, unknown[]>) {
  return { ".claude/settings.json": { hooks } };
}

const offered = (hooks: ReturnType<typeof skillHooks>) =>
  hooks.map(({ source, event, matcher, command, timeoutSeconds, reason }) => ({
    source,
    event,
    matcher,
    command,
    timeoutSeconds,
    reason,
  }));

describe("a skill's own hooks", () => {
  test("the impeccable repository offers its three hooks, tied to the skill folder", () => {
    const repo = files(
      settings({
        SessionStart: [{ hooks: [commandHook(IMPECCABLE, 5)] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [commandHook(IMPECCABLE, 5)] }],
        Stop: [{ hooks: [commandHook(IMPECCABLE, 30)] }],
      }),
    );
    expect(skillHooks(repo, FOLDER)).toEqual([
      {
        id: `${FOLDER}#0`,
        source: "SessionStart",
        event: "session_start",
        label: "When a session starts",
        matcher: null,
        command: REWRITTEN,
        timeoutSeconds: 5,
        reason: null,
      },
      {
        id: `${FOLDER}#1`,
        source: "PostToolUse Edit|Write",
        event: "after_edit",
        label: "After a file edit",
        matcher: null,
        command: REWRITTEN,
        timeoutSeconds: 5,
        reason: null,
      },
      {
        id: `${FOLDER}#2`,
        source: "Stop",
        event: "stop",
        label: "When the agent stops",
        matcher: null,
        command: REWRITTEN,
        timeoutSeconds: 30,
        reason: null,
      },
    ]);
  });

  test("tool events map to file edits, shell commands and tool calls", () => {
    const run = (name: string) => commandHook(`$CLAUDE_PROJECT_DIR/skills/guard/${name}`);
    const repo = files(
      settings({
        PostToolUse: [{ matcher: "Write", hooks: [run("write")] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [run("shell")] },
          { matcher: "mcp__linear__.*", hooks: [run("linear")] },
          { matcher: "*", hooks: [run("every")] },
          { hooks: [run("all")] },
        ],
      }),
    );
    expect(
      skillHooks(repo, "skills/guard").map(({ event, matcher, command }) => [
        event,
        matcher,
        command,
      ]),
    ).toEqual([
      ["after_edit", null, "$PAWS_SKILL_DIR/write"],
      ["before_shell", null, "$PAWS_SKILL_DIR/shell"],
      ["before_tool", "mcp__linear__.*", "$PAWS_SKILL_DIR/linear"],
      ["before_tool", null, "$PAWS_SKILL_DIR/every"],
      ["before_tool", null, "$PAWS_SKILL_DIR/all"],
    ]);
  });

  test("hooks Paws cannot run are listed as not supported, with the reason", () => {
    const run = commandHook("${CLAUDE_PROJECT_DIR}/skills/guard/run");
    const repo = files(
      settings({
        PostToolUse: [{ matcher: "Bash", hooks: [run] }],
        UserPromptSubmit: [{ hooks: [run] }],
        Stop: [{ hooks: [commandHook("${CLAUDE_PROJECT_DIR}/skills/guard/slow", 900)] }],
      }),
    );
    expect(offered(skillHooks(repo, "skills/guard"))).toEqual([
      {
        source: "PostToolUse Bash",
        event: null,
        matcher: null,
        command: "$PAWS_SKILL_DIR/run",
        timeoutSeconds: 60,
        reason: "Paws runs a hook after a tool only for file edits (Edit|Write).",
      },
      {
        source: "UserPromptSubmit",
        event: null,
        matcher: null,
        command: "$PAWS_SKILL_DIR/run",
        timeoutSeconds: 60,
        reason: "Paws has no UserPromptSubmit hook.",
      },
      {
        source: "Stop",
        event: null,
        matcher: null,
        command: "$PAWS_SKILL_DIR/slow",
        timeoutSeconds: 900,
        reason: "Set a timeout between 1 and 600 seconds.",
      },
    ]);
    expect(skillHooks(repo, "skills/guard").map((hook) => hook.label)).toEqual([
      "Not supported",
      "Not supported",
      "Not supported",
    ]);
  });

  test("only command hooks that point into the chosen skill folder are read", () => {
    const repo = files(
      settings({
        Stop: [
          {
            hooks: [
              { type: "prompt", prompt: "Check ${CLAUDE_PROJECT_DIR}/skills/guard" },
              commandHook("bun run fmt"),
              commandHook("${CLAUDE_PROJECT_DIR}/skills/other/run"),
              commandHook("${CLAUDE_PROJECT_DIR}/skills/guard-extra/run"),
              commandHook("${CLAUDE_PROJECT_DIR}/skills/guard/../other/run"),
              commandHook("${CLAUDE_PROJECT_DIR}/skills/guard/run ${CLAUDE_PROJECT_DIR}/scripts/x"),
              commandHook('"$CLAUDE_PROJECT_DIR"/skills/guard/run --fast'),
            ],
          },
        ],
      }),
    );
    expect(skillHooks(repo, "skills/guard").map((hook) => hook.command)).toEqual([
      '"$PAWS_SKILL_DIR"/run --fast',
    ]);
    expect(skillHooks(repo, "skills/other").map((hook) => hook.command)).toEqual([
      "$PAWS_SKILL_DIR/run",
    ]);
    expect(skillHooks(files({ ".claude/settings.json": "{ not json" }), "skills/guard")).toEqual(
      [],
    );
    expect(skillHooks(files({ ".claude/settings.json": { hooks: [] } }), "skills/guard")).toEqual(
      [],
    );
  });

  test("a skill at the repository root keeps every path under the repository", () => {
    const repo = files(
      settings({ Stop: [{ hooks: [commandHook("${CLAUDE_PROJECT_DIR}/bin/check")] }] }),
    );
    expect(skillHooks(repo, "").map((hook) => [hook.id, hook.command])).toEqual([
      ["#0", "$PAWS_SKILL_DIR/bin/check"],
    ]);
  });

  test("plugin hooks come from hooks/hooks.json and the plugin manifest, once each", () => {
    const run = (name: string) => commandHook(`\${CLAUDE_PLUGIN_ROOT}/skills/guard/${name}`, 10);
    const repo = files({
      "hooks/hooks.json": { hooks: { Stop: [{ hooks: [run("stop")] }] } },
      ".claude-plugin/plugin.json": {
        name: "guard",
        hooks: "./config/hooks.json",
      },
      "config/hooks.json": {
        hooks: {
          Stop: [{ hooks: [run("stop")] }],
          SessionStart: [{ matcher: "startup", hooks: [run("start")] }],
        },
      },
      ".claude/settings.json": {
        hooks: { Stop: [{ hooks: [commandHook("${CLAUDE_PLUGIN_ROOT}/skills/guard/project")] }] },
      },
    });
    expect(
      skillHooks(repo, "skills/guard").map(({ source, command, timeoutSeconds }) => [
        source,
        command,
        timeoutSeconds,
      ]),
    ).toEqual([
      ["Stop", "$PAWS_SKILL_DIR/stop", 10],
      ["SessionStart startup", "$PAWS_SKILL_DIR/start", 10],
    ]);
    const inline = files({
      ".claude-plugin/plugin.json": { hooks: { Stop: [{ hooks: [run("inline")] }] } },
    });
    expect(skillHooks(inline, "skills/guard").map((hook) => hook.command)).toEqual([
      "$PAWS_SKILL_DIR/inline",
    ]);
  });
});
