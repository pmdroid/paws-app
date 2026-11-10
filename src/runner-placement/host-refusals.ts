import type { RunnerHostRefusal } from "../db";
import { journal } from "../journal";

const JOURNAL_EVERY_MS = 10 * 60_000;

function refusalLine(refusal: RunnerHostRefusal): string {
  const why =
    refusal.kind === "repository"
      ? "not in its allowed repositories"
      : `${refusal.agent} is not signed in`;
  return `${refusal.runnerName} can't take ${refusal.repository} (${why})`;
}

export function createRunnerHostRefusals() {
  let lines = new Map<string, string[]>();
  const journaledAt = new Map<string, number>();
  return {
    report(refusals: readonly RunnerHostRefusal[], now: number): void {
      const next = new Map<string, string[]>();
      for (const refusal of refusals)
        next.set(refusal.runnerId, [...(next.get(refusal.runnerId) ?? []), refusalLine(refusal)]);
      lines = next;
      for (const [runnerId, runnerLines] of next) {
        const last = journaledAt.get(runnerId);
        if (last !== undefined && now - last < JOURNAL_EVERY_MS) continue;
        journaledAt.set(runnerId, now);
        journal(`runner refuses waiting work: ${runnerLines.join("; ")}`);
      }
    },
    lines(runnerId: string): readonly string[] {
      return lines.get(runnerId) ?? [];
    },
  };
}
