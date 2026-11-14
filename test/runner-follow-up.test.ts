import { expect, test } from "bun:test";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { runWithFollowUps } from "../src/runner-worker";

const finished = (cancelled: boolean): RunAgentResult => ({
  role: "implementer",
  stopReason: cancelled ? "cancelled" : "end_turn",
  cancelled,
  timedOut: false,
  authRequired: false,
  agentExited: true,
});

test("a follow-up interrupts the running turn and continues in the same workspace", async () => {
  const prompts: string[] = [];
  const worktrees = new Set<string>();
  let started = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const result = await runWithFollowUps(
    {
      role: "implementer",
      itemId: "item",
      runId: "run",
      prompt: "Build the gallery",
      worktreePath: "/work/tree",
      pawsRoot: "/nonexistent-follow-up",
    },
    async (sequence, signal) => {
      if (sequence === 1) {
        await running;
        return "Also cover the empty state";
      }
      return new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
    async (options: RunAgentOptions) => {
      prompts.push(options.prompt);
      worktrees.add(options.worktreePath);
      if (prompts.length > 1) return finished(false);
      started();
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { ...finished(true), stopReason: "error", interrupted: true, errorMessage: "Error." };
    },
  );
  expect(result.stopReason).toBe("end_turn");
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toBe("Build the gallery");
  expect(prompts[1]).toContain("Also cover the empty state");
  expect(prompts[1]).toContain("Build the gallery");
  expect([...worktrees]).toEqual(["/work/tree"]);
});

test("without a follow-up the run finishes with its first turn", async () => {
  let calls = 0;
  const result = await runWithFollowUps(
    {
      role: "implementer",
      itemId: "item",
      runId: "run",
      prompt: "Build the gallery",
      worktreePath: "/work/tree",
      pawsRoot: "/nonexistent-follow-up",
    },
    (_sequence, signal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    async () => {
      calls++;
      return finished(false);
    },
  );
  expect(result.stopReason).toBe("end_turn");
  expect(calls).toBe(1);
});

for (const emptyDelivery of [true, false])
  test(`follow-up handling continues safely with empty delivery: ${emptyDelivery}`, async () => {
    let calls = 0;
    let deliveries = 0;
    const result = await runWithFollowUps(
      {
        role: "implementer",
        itemId: "item",
        runId: "run",
        prompt: "Continue the repair",
        worktreePath: "/work/tree",
        pawsRoot: "/nonexistent-follow-up",
      },
      async (_sequence, signal) => {
        if (emptyDelivery && deliveries++ === 0) return "  ";
        return new Promise<string>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
      async (options) => {
        calls++;
        if (emptyDelivery) {
          await Bun.sleep(10);
          expect(options.signal?.aborted).toBe(false);
        } else if (calls === 1) {
          return { ...finished(true), stopReason: "error", interrupted: true };
        }
        expect(options.prompt).toContain("Continue the repair");
        return finished(false);
      },
    );
    expect(result.stopReason).toBe("end_turn");
    expect(calls).toBe(emptyDelivery ? 1 : 2);
  });

test("an unsolicited cancelled stop leaves retry decisions to the backend", async () => {
  let calls = 0;
  const result = await runWithFollowUps(
    {
      role: "implementer",
      itemId: "item",
      runId: "run",
      prompt: "Repair",
      worktreePath: "/work/tree",
      pawsRoot: "/nonexistent-follow-up",
    },
    (_sequence, signal) =>
      new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    async () => {
      calls++;
      return { ...finished(true), interrupted: true };
    },
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({ stopReason: "cancelled", cancelled: true, interrupted: true });
});
