import {
  HOOK_EVENT_LABELS,
  HOOK_TIMEOUT_DEFAULT_SECONDS,
  workspaceHookProblem,
  type HookEvent,
} from "../core";
import { skillPath, type SkillFiles } from "./bundle";
import { manifestJson, strings } from "./discover";

export type SkillHook = {
  id: string;
  source: string;
  event: HookEvent | null;
  label: string;
  matcher: string | null;
  command: string;
  timeoutSeconds: number;
  reason: string | null;
};

type Mapped = { event: HookEvent; matcher: string | null };

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"];

export function hookFiles(tree: string[]): string[] {
  return tree.filter(
    (path) =>
      path === ".claude/settings.json" ||
      path === ".claude-plugin/plugin.json" ||
      path === "hooks.json" ||
      path.endsWith("/hooks.json"),
  );
}

export function skillHooks(files: SkillFiles, folder: string): SkillHook[] {
  const seen = new Set<string>();
  return hookConfigs(files)
    .flatMap(({ variable, hooks }) =>
      Object.entries(record(hooks)).flatMap(([name, groups]) =>
        list(groups).flatMap((group) => {
          const matcher = record(group).matcher;
          return list(record(group).hooks).flatMap((entry) => {
            const { type, command, timeout } = record(entry);
            if (type !== "command" || typeof command !== "string") return [];
            const rewritten = skillCommand(command, variable, folder);
            if (rewritten === null) return [];
            return [
              offer(name, typeof matcher === "string" ? matcher.trim() : "", rewritten, timeout),
            ];
          });
        }),
      ),
    )
    .filter((hook) => {
      const key = `${hook.source}\0${hook.command}`;
      return !seen.has(key) && seen.add(key);
    })
    .map((hook, index) => ({ id: `${folder}#${index}`, ...hook }));
}

function hookConfigs(files: SkillFiles): { variable: string; hooks: unknown }[] {
  const declared = manifestJson(files, ".claude-plugin/plugin.json").hooks;
  const plugin = (path: string) => ({
    variable: "CLAUDE_PLUGIN_ROOT",
    hooks: manifestJson(files, skillPath(path) ?? "").hooks,
  });
  return [
    { variable: "CLAUDE_PROJECT_DIR", hooks: manifestJson(files, ".claude/settings.json").hooks },
    plugin("hooks/hooks.json"),
    ...strings(declared).map(plugin),
    { variable: "CLAUDE_PLUGIN_ROOT", hooks: Array.isArray(declared) ? {} : declared },
  ];
}

function skillCommand(command: string, variable: string, folder: string): string | null {
  let found = false;
  let inside = true;
  const pattern = new RegExp(
    `\\$(?:\\{${variable}\\}|${variable}\\b)("?)/([^\\s"'\`;|&<>()]*)`,
    "g",
  );
  const rewritten = command.replace(pattern, (whole, quote: string, rest: string) => {
    found = true;
    const target = skillPath(rest);
    const relative =
      target === null
        ? null
        : folder === "" || target.startsWith(`${folder}/`)
          ? target.slice(folder ? folder.length + 1 : 0)
          : null;
    if (relative === null) inside = false;
    return relative === null ? whole : `$PAWS_SKILL_DIR${quote}/${relative}`;
  });
  return found && inside ? rewritten : null;
}

function offer(
  name: string,
  matcher: string,
  command: string,
  timeout: unknown,
): Omit<SkillHook, "id"> {
  const timeoutSeconds =
    typeof timeout === "number" ? Math.ceil(timeout) : HOOK_TIMEOUT_DEFAULT_SECONDS;
  const source = matcher ? `${name} ${matcher}` : name;
  const mapped = hookEvent(name, matcher);
  const reason =
    typeof mapped === "string"
      ? mapped
      : workspaceHookProblem({
          ...mapped,
          command,
          timeoutSeconds,
          agents: ["claude"],
          skill: null,
        });
  if (reason !== null || typeof mapped === "string")
    return {
      source,
      event: null,
      label: "Not supported",
      matcher: null,
      command,
      timeoutSeconds,
      reason,
    };
  return {
    source,
    ...mapped,
    label: HOOK_EVENT_LABELS[mapped.event],
    command,
    timeoutSeconds,
    reason,
  };
}

function hookEvent(name: string, matcher: string): Mapped | string {
  switch (name) {
    case "PostToolUse":
      return matcher && matcher.split("|").every((tool) => EDIT_TOOLS.includes(tool.trim()))
        ? { event: "after_edit", matcher: null }
        : "Paws runs a hook after a tool only for file edits (Edit|Write).";
    case "PreToolUse":
      if (matcher === "Bash") return { event: "before_shell", matcher: null };
      return { event: "before_tool", matcher: matcher && matcher !== "*" ? matcher : null };
    case "Stop":
      return { event: "stop", matcher: null };
    case "SessionStart":
      return { event: "session_start", matcher: null };
    default:
      return `Paws has no ${name} hook.`;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
