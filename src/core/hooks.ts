/** When a workspace hook runs. Paws maps each one onto every agent's own hook event. */
export const HOOK_EVENTS = [
  "after_edit",
  "before_shell",
  "before_tool",
  "stop",
  "session_start",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_EVENT_LABELS: Record<HookEvent, string> = {
  after_edit: "After a file edit",
  before_shell: "Before a shell command",
  before_tool: "Before a tool call",
  stop: "When the agent stops",
  session_start: "When a session starts",
};

/** Agents with a hook system Paws can inject into. Grok has none, so it also runs without Closeout's hook. */
export const HOOK_AGENTS = ["claude", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export const HOOK_COMMAND_MAX_LENGTH = 4096;
export const HOOK_MATCHER_MAX_LENGTH = 256;
export const HOOK_TIMEOUT_DEFAULT_SECONDS = 60;
export const HOOK_TIMEOUT_MAX_SECONDS = 600;
export const WORKSPACE_HOOK_LIMIT = 20;

/** A hook an owner or admin registered for every run, next to Paws's own Closeout Stop hook. */
export type WorkspaceHook = {
  id: string;
  event: HookEvent;
  /** Tool name pattern, only for `before_tool`. Absent means every tool. */
  matcher: string | null;
  /** Shell command. With `skill`, `$PAWS_SKILL_DIR` is that skill's installed folder. */
  command: string;
  timeoutSeconds: number;
  agents: HookAgent[];
  /** A registered skill whose bundle holds the hook's script. */
  skill: string | null;
};

/** Why the hook cannot be saved, or null when it is valid. */
export function workspaceHookProblem(hook: Omit<WorkspaceHook, "id">): string | null {
  if (!HOOK_EVENTS.includes(hook.event)) return "Choose when the hook runs.";
  const command = hook.command;
  if (!command.trim()) return "Enter the hook's command.";
  if (command.length > HOOK_COMMAND_MAX_LENGTH)
    return `Keep the command under ${HOOK_COMMAND_MAX_LENGTH} characters.`;
  if (/[\0\r\n]/.test(command)) return "Put the command on one line.";
  if (hook.matcher !== null) {
    if (hook.event !== "before_tool")
      return "Only a hook that runs before a tool call takes a tool matcher.";
    if (
      !hook.matcher.trim() ||
      hook.matcher.length > HOOK_MATCHER_MAX_LENGTH ||
      /[\0\r\n]/.test(hook.matcher)
    )
      return `Keep the tool matcher on one line, under ${HOOK_MATCHER_MAX_LENGTH} characters.`;
  }
  if (
    !Number.isInteger(hook.timeoutSeconds) ||
    hook.timeoutSeconds < 1 ||
    hook.timeoutSeconds > HOOK_TIMEOUT_MAX_SECONDS
  )
    return `Set a timeout between 1 and ${HOOK_TIMEOUT_MAX_SECONDS} seconds.`;
  if (
    hook.agents.length === 0 ||
    hook.agents.some((agent) => !HOOK_AGENTS.includes(agent)) ||
    new Set(hook.agents).size !== hook.agents.length
  )
    return "Choose the agents the hook applies to.";
  if (hook.skill !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(hook.skill))
    return "Choose a registered skill.";
  return null;
}
