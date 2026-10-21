import type { UsageLimitPause } from "../acp";

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

function agentName(agent: string): string {
  return AGENT_NAMES[agent] ?? agent;
}

/** "18:00 UTC", with the date when the time is not within the next day. */
function utcTime(at: number, now: number): string {
  const date = new Date(at);
  const time = `${date.toISOString().slice(11, 16)} UTC`;
  return at - now < 86_400_000
    ? time
    : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${time}`;
}

/** The Linear line posted when a task pauses for a usage limit. */
export function usagePausedText(pause: UsageLimitPause): string {
  const agent = agentName(pause.agent);
  return pause.resetsAt === null
    ? `Paused: ${agent} reached its usage limit and did not say when it resets. Paws tries again at ${utcTime(pause.resumeAt, pause.pausedAt)}.`
    : `Paused: ${agent} reached its usage limit. Paws continues at ${utcTime(pause.resetsAt, pause.pausedAt)}.`;
}

/** The Linear line posted when the paused task continues. */
export function usageResumedText(pause: UsageLimitPause): string {
  return `Continuing: Paws resumes the work ${agentName(pause.agent)} paused at its usage limit.`;
}
