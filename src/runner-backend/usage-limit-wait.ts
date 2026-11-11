import { setTimeout as delay } from "node:timers/promises";
import type { RunAgentOptions } from "../acp";
import { usageLimitNotice } from "../core";
import { endUsagePause, startUsagePause, usagePauseSteps, type Db } from "../db";
import type { UsageLimitWait } from "./failover";

export function usageLimitWait(
  options: { store: Db; now: () => number; mono: () => number; interval: number },
  target: () =>
    | { itemId: string; runId: string }
    | null
    | Promise<{ itemId: string; runId: string } | null>,
  input: RunAgentOptions,
): UsageLimitWait {
  const { store, now, mono, interval } = options;
  return {
    now,
    async pause(limit, profilesChanged) {
      const run = await target();
      if (!run) throw limit;
      const { itemId, runId } = run;
      const agent = agentName(limit.agent);
      await startUsagePause(
        store,
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
          text: `Paused: ${usageLimitNotice(limit.agent, limit.resumeAt, now())}`,
        });
        for (;;) {
          const wait = ((await store.run((q) => usagePauseSteps(q, runId)))?.resumeAt ?? 0) - now();
          changed = (await profilesChanged?.()) ?? false;
          if (wait <= 0 || changed) break;
          if ((await limit.readyRunners?.())?.length) break;
          await delay(Math.min(wait, interval * 20), undefined, { signal: input.signal });
        }
      } finally {
        await endUsagePause(store, runId, mono(), now());
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
