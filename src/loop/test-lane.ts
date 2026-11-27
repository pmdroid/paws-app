import type { TestPermit } from "../db";

export const TEST_LANE_ASK_MS = 2 * 60 * 60_000;
export const TEST_LANE_POLL_MS = 5_000;

export function testLaneWaitReason(runner: string): string {
  return `Closeout is waiting for the test lane on ${runner}.`;
}

export async function waitForTestLane(input: {
  runner: string;
  needed(): Promise<boolean>;
  take(): Promise<TestPermit>;
  release(): Promise<void>;
  holder(runId: string): Promise<string>;
  hold(): Promise<void>;
  waiting(reason: string | null): unknown;
  now(): number;
  sleep(ms: number): Promise<void>;
  askAfterMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const askAfterMs = input.askAfterMs ?? TEST_LANE_ASK_MS;
  let shown = false;
  let holder: string | null = null;
  try {
    for (;;) {
      if (!(await input.needed())) {
        await input.release();
        return false;
      }
      const permit = await input.take();
      if (permit.granted) return true;
      holder = permit.holder ?? holder;
      await input.hold();
      if (!shown) {
        shown = true;
        await input.waiting(testLaneWaitReason(input.runner));
      }
      if (input.now() - permit.requestedAt >= askAfterMs) {
        const name = holder === null ? "another test check" : await input.holder(holder);
        const hours = Math.round((askAfterMs / 3_600_000) * 10) / 10;
        throw new Error(
          `Closeout waited ${hours} hours for the test lane on ${input.runner}, which ${name} holds. No check failed and no attempt was used. Reply to try again once the lane is free.`,
        );
      }
      await input.sleep(input.pollMs ?? TEST_LANE_POLL_MS);
    }
  } finally {
    if (shown) await input.waiting(null);
  }
}
