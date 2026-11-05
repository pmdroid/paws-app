import type { TurnPass } from "../closeout";
import type { AgentCloseoutEvent } from "../db";

export function turnPasses(events: readonly AgentCloseoutEvent[]): TurnPass[] {
  const last = new Map<string, AgentCloseoutEvent>();
  for (const event of events)
    if (event.progress.type === "finished") last.set(event.progress.id, event);
  const passes: TurnPass[] = [];
  for (const { at, progress } of last.values()) {
    if (
      progress.type !== "finished" ||
      progress.state !== "passed" ||
      progress.exitCode !== 0 ||
      progress.timedOut ||
      progress.clean !== true ||
      !progress.base ||
      !progress.policyDigest ||
      !progress.head
    )
      continue;
    passes.push({
      id: progress.id,
      command: progress.command,
      head: progress.head,
      base: progress.base,
      policyDigest: progress.policyDigest,
      at,
      durationMs: progress.durationMs,
      stdout: progress.stdout,
      stderr: progress.stderr,
      truncated: progress.truncated,
    });
  }
  return passes;
}
