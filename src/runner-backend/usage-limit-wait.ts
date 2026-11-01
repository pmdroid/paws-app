import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import type { RunAgentOptions } from "../acp";
import { endUsagePause, startUsagePause, usagePause } from "../db";
import type { UsageLimitWait } from "./failover";

export function usageLimitWait(
  options: { db: Database; now: () => number; mono: () => number; interval: number },
  target: () => { itemId: string; runId: string } | null,
  input: RunAgentOptions,
): UsageLimitWait {
  const { db, now, mono, interval } = options;
  return {
    now,
    async pause(limit, profilesChanged) {
      const run = target();
      if (!run) throw limit;
      const { itemId, runId } = run;
      const agent = agentName(limit.agent);
      startUsagePause(
        db,
        {
          runId,
          itemId,
          agent: limit.agent,
          runnerId: limit.runnerId,
          resetsAt: limit.resetsAt,
          resumeAt: limit.resumeAt,
          pausedAt: now(),
        },
        mono(),
      );
      let changed = false;
      try {
        await input.onEvent?.({
          type: "progress",
          text: `Paused: ${agent} reached its usage limit. Paws continues at ${clockTime(limit.resumeAt, now())}.`,
        });
        for (;;) {
          const wait = (usagePause(db, runId)?.resumeAt ?? 0) - now();
          changed = profilesChanged?.() ?? false;
          if (wait <= 0 || changed) break;
          if ((await limit.readyRunners?.())?.length) break;
          await delay(Math.min(wait, interval * 20), undefined, { signal: input.signal });
        }
      } finally {
        endUsagePause(db, runId, mono(), now());
      }
      input.signal?.throwIfAborted();
      await input.onEvent?.({
        type: "progress",
        text: changed
          ? "Continuing: Paws is trying the updated agent settings."
          : `Continuing: Paws is trying ${agent} again after its usage limit.`,
      });
    },
  };
}

export function agentName(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function clockTime(at: number, now: number): string {
  const time = new Date(at).toISOString();
  const day =
    time.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? "" : `${time.slice(0, 10)} `;
  return `${day}${time.slice(11, 16)} UTC`;
}
