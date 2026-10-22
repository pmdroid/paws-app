import type { RunnerAvailability } from "../db";

/** A runner that has not reported for this long is offline, as in placement. */
export const RUNNER_OFFLINE_MS = 60_000;
export const RUNNER_WAIT_ASK_MS = 30 * 60_000;
export const RUNNER_WAIT_POLL_MS = 5_000;
export const MOVE_TO_ANOTHER_RUNNER = "Move to another runner";
export const KEEP_WAITING = "Keep waiting";

export function runnerWaitReason(runner: RunnerAvailability | null, now: number): string | null {
  if (runner === null) return null;
  if (runner.revoked || runner.status === "revoked")
    return `Waiting: runner ${runner.name} is revoked. Pair it again on the Runners page.`;
  if (runner.status === "paused")
    return `Waiting: runner ${runner.name} is paused. Resume it on the Runners page.`;
  if (runner.lastSeenAt === null || runner.lastSeenAt <= now - RUNNER_OFFLINE_MS)
    return `Waiting: runner ${runner.name} is offline. Start it again so it reconnects.`;
  return null;
}

export function movesToAnotherRunner(answer: string): boolean {
  return /\b(move|another runner)\b/i.test(answer);
}

export type RunnerWaitQuestion = { answer: Promise<string>; cancel(): void };

/**
 * Holds Closeout before it sends work to a paused, revoked or offline runner.
 * Waiting is not an attempt. The reason is shown once per change, and after
 * `askAfterMs` the team is asked whether to move the task or keep waiting.
 */
export async function waitForRunner(input: {
  runner(): RunnerAvailability | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The reason to show on the waiting step, or null once the wait ends. */
  waiting(reason: string | null): void;
  notify(reason: string): void;
  ask(runner: RunnerAvailability, reason: string): RunnerWaitQuestion;
  askAfterMs?: number;
  pollMs?: number;
}): Promise<"available" | "move"> {
  const askAfterMs = input.askAfterMs ?? RUNNER_WAIT_ASK_MS;
  const pollMs = input.pollMs ?? RUNNER_WAIT_POLL_MS;
  let shown: string | null = null;
  let since = 0;
  let question: RunnerWaitQuestion | undefined;
  let answer: string | undefined;
  try {
    for (;;) {
      const runner = input.runner();
      const reason = runnerWaitReason(runner, input.now());
      if (runner === null || reason === null) return "available";
      if (shown === null) since = input.now();
      if (reason !== shown) {
        shown = reason;
        input.waiting(reason);
        input.notify(reason);
      }
      if (answer !== undefined) {
        if (movesToAnotherRunner(answer)) return "move";
        answer = undefined;
        question = undefined;
        since = input.now();
      }
      if (question === undefined && input.now() - since >= askAfterMs) {
        const asked = input.ask(runner, reason);
        question = asked;
        asked.answer.then(
          (value) => {
            if (question === asked) answer = value;
          },
          () => {},
        );
      }
      await input.sleep(pollMs);
    }
  } finally {
    if (shown !== null) input.waiting(null);
    if (question !== undefined && answer === undefined) question.cancel();
  }
}
