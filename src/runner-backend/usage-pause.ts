import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRole, UsageLimitHook, UsageLimitPause } from "../acp";
import { endUsagePause, getUsagePause, saveUsagePause } from "../db";

/** Paws continues this long after the agent's reset time. */
export const USAGE_RESUME_MARGIN_MS = 60_000;

/** The earliest account cooldown that keeps an agent from being placed. */
export type UsageCooldown = {
  runnerId: string;
  accountUserId: string | null;
  cooldownUntil: number;
};

/**
 * Places work, or, while an account cooldown is what keeps every runner out,
 * waits for that cooldown to end and places it again. `usage.resetsAt` carries
 * the reset the agent reported for the attempt that hit the limit.
 */
export async function placeOrWait<T>(input: {
  place: () => Promise<T | null>;
  cooldown: () => UsageCooldown | null;
  unavailable: () => Error;
  db: Database;
  itemId: string;
  role: AgentRole;
  agent: string | undefined;
  usage: { resetsAt?: number | null; hook?: UsageLimitHook };
  now: () => number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  for (;;) {
    const selected = await input.place();
    if (selected) return selected;
    const cooldown = input.agent ? input.cooldown() : null;
    if (!input.agent || cooldown === null) throw input.unavailable();
    await waitForUsageReset({
      ...input,
      lifted: () => input.now() < cooldown.cooldownUntil && input.cooldown() === null,
      agent: input.agent,
      cooldown,
      resetsAt: input.usage.resetsAt,
      hook: input.usage.hook,
    });
    delete input.usage.resetsAt;
  }
}

/**
 * Waits until the usage limit resets, Resume now is requested, or the signal
 * aborts. `resetsAt` is the reset the agent reported: a number, null when it
 * gave none (the cooldown then is the retry interval), or undefined when only
 * the cooldown is known.
 */
export async function waitForUsageReset(input: {
  db: Database;
  itemId: string;
  role: AgentRole;
  agent: string;
  cooldown: UsageCooldown;
  resetsAt: number | null | undefined;
  now: () => number;
  pollMs: number;
  signal?: AbortSignal;
  hook?: UsageLimitHook;
  /** True when the account cooldown was cleared before it ended. */
  lifted?: () => boolean;
}): Promise<void> {
  const { db, itemId, cooldown, now } = input;
  const resetsAt = input.resetsAt === undefined ? cooldown.cooldownUntil : input.resetsAt;
  const resumeAt =
    resetsAt === null
      ? cooldown.cooldownUntil
      : Math.max(resetsAt, cooldown.cooldownUntil) + USAGE_RESUME_MARGIN_MS;
  const pausedAt = now();
  const pause: UsageLimitPause = {
    agent: input.agent,
    role: input.role,
    resetsAt,
    resumeAt,
    pausedAt,
    runnerId: cooldown.runnerId,
  };
  saveUsagePause(db, {
    itemId,
    role: input.role,
    agent: input.agent,
    runnerId: cooldown.runnerId,
    accountUserId: cooldown.accountUserId,
    resetsAt,
    resumeAt,
    pausedAt,
  });
  try {
    input.hook?.paused(pause);
    while (now() < resumeAt && !getUsagePause(db, itemId)?.resumeRequested && !input.lifted?.())
      await delay(Math.min(resumeAt - now(), input.pollMs), undefined, { signal: input.signal });
  } finally {
    endUsagePause(db, itemId, pausedAt);
  }
  input.signal?.throwIfAborted();
  input.hook?.resumed(pause);
}
