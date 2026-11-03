import { describe, expect, test } from "bun:test";
import type { RunAgentOptions, RunAgentResult } from "../acp";
import { isTransient } from "../core";
import {
  AccountPolicyUnavailable,
  RetryableRunnerError,
  runWithFailover,
  UsageLimitPause,
  UsageLimitExhaustedError,
  MAX_USAGE_LIMIT_EVENTS,
  type FailoverAttempt,
  type FailoverLedger,
  type UsageLimit,
} from "./failover";

const RESET = Date.parse("2026-10-21T18:00:00.000Z");

function done(): RunAgentResult {
  return {
    role: "implementer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
  };
}

function input(signal?: AbortSignal): RunAgentOptions {
  return {
    role: "implementer",
    itemId: "item",
    runId: "run",
    prompt: "Implement the task.",
    worktreePath: "/nonexistent",
    pawsRoot: "/nonexistent",
    ...(signal ? { signal } : {}),
  };
}

function limited(runnerId: string, resetsAt: number | null) {
  return new RetryableRunnerError(
    runnerId,
    "The runner agent exhausted its observed quota.",
    "/nonexistent/acp.jsonl",
    false,
    { resetsAt },
  );
}

/** A fake runner fleet and clock: `place` decides where each attempt runs. */
function fleet(place: (limit: UsageLimit | undefined, now: number) => string | UsageLimitPause) {
  const clock = { now: RESET - 3 * 3_600_000 };
  const calls: { runnerId: string; excluded: string[]; prompt: string; at: number }[] = [];
  const pauses: { resumeAt: number; resetsAt: number | null; at: number }[] = [];
  const outcomes: (RetryableRunnerError | "done")[] = [];
  const attempt: FailoverAttempt = async (options, excluded, limit) => {
    const placed = place(limit, clock.now);
    if (placed instanceof UsageLimitPause) throw placed;
    calls.push({
      runnerId: placed,
      excluded: [...excluded],
      prompt: options.prompt,
      at: clock.now,
    });
    const outcome = outcomes.shift() ?? "done";
    if (outcome === "done") return done();
    throw outcome;
  };
  const wait = {
    now: () => clock.now,
    async pause(limit: UsageLimitPause) {
      pauses.push({ resumeAt: limit.resumeAt, resetsAt: limit.resetsAt, at: clock.now });
      clock.now = limit.resumeAt;
    },
  };
  return { clock, calls, pauses, outcomes, attempt, wait };
}

/** One runner whose account is cooled down until the limit's resume time. */
function oneRunner(limit: UsageLimit | undefined, now: number) {
  if (limit && limit.resumeAt > now)
    return new UsageLimitPause("claude", limit.resumeAt, limit.resetsAt, limit.runnerId);
  return "agentbox";
}

describe("usage limits pause the task instead of failing it", () => {
  test("a usage limit mid-run pauses until the reset plus a minute, then continues on the same runner", async () => {
    const runners = fleet(oneRunner);
    runners.outcomes.push(limited("agentbox", RESET));
    const result = await runWithFailover(
      input(),
      runners.attempt,
      async () => undefined,
      runners.wait,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(runners.pauses).toEqual([
      { resumeAt: RESET + 60_000, resetsAt: RESET, at: RESET - 3 * 3_600_000 },
    ]);
    expect(runners.calls.map((call) => call.runnerId)).toEqual(["agentbox", "agentbox"]);
    expect(runners.calls[1]!.excluded).toEqual([]);
    expect(runners.calls[1]!.at).toBe(RESET + 60_000);
    expect(runners.calls[1]!.prompt).toContain("Implement the task.");
    expect(runners.calls[1]!.prompt).toContain(
      "The agent stopped at its usage limit. Continue the same task from where it stopped.",
    );
  });

  test("a runner that always reports a usage limit exhausts a typed budget", async () => {
    const runners = fleet(oneRunner);
    for (let index = 0; index < 10; index++) runners.outcomes.push(limited("agentbox", null));
    let settled = 0;
    const run = runWithFailover(
      input(),
      runners.attempt,
      async () => {
        settled++;
      },
      runners.wait,
    );
    await expect(run).rejects.toBeInstanceOf(UsageLimitExhaustedError);
    await expect(run).rejects.toMatchObject({
      runnerId: "agentbox",
      cause: { name: "RetryableRunnerError", runnerId: "agentbox" },
    });
    expect(runners.calls).toHaveLength(MAX_USAGE_LIMIT_EVENTS);
    expect(settled).toBe(MAX_USAGE_LIMIT_EVENTS);
    expect(runners.pauses).toHaveLength(MAX_USAGE_LIMIT_EVENTS - 1);
    expect(runners.pauses[0]!.resumeAt - runners.pauses[0]!.at).toBe(15 * 60_000);
    expect(runners.calls.at(-1)!.prompt.match(/usage limit/g)).toHaveLength(1);
  });

  test("placement pauses that would not wait stop instead of spinning", async () => {
    let attempts = 0;
    const runners = fleet(() => {
      attempts++;
      return new UsageLimitPause("claude", RESET, null, null);
    });
    await expect(
      runWithFailover(input(), runners.attempt, async () => undefined, runners.wait),
    ).rejects.toBeInstanceOf(UsageLimitExhaustedError);
    expect(attempts).toBe(MAX_USAGE_LIMIT_EVENTS + 1);
    expect(runners.pauses).toHaveLength(MAX_USAGE_LIMIT_EVENTS);
    expect(runners.pauses.slice(1).every((pause) => pause.at === RESET)).toBe(true);
  });

  test("waiting for every account to recover spends no attempt budget", async () => {
    let waits = 0;
    const runners = fleet((_limit, now) => {
      if (waits >= MAX_USAGE_LIMIT_EVENTS * 2) return "agentbox";
      waits++;
      return new UsageLimitPause("claude", now + 30 * 60_000, null, null);
    });
    const result = await runWithFailover(
      input(),
      runners.attempt,
      async () => undefined,
      runners.wait,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(runners.pauses).toHaveLength(MAX_USAGE_LIMIT_EVENTS * 2);
    expect(runners.calls).toHaveLength(1);
  });

  test("an unknown reset resumes at the account's recheck time", async () => {
    const runners = fleet(oneRunner);
    runners.outcomes.push(
      new RetryableRunnerError("agentbox", "quota", undefined, false, {
        resetsAt: null,
        recheckAt: RESET - 3 * 3_600_000 + 40 * 60_000,
      }),
    );
    await runWithFailover(input(), runners.attempt, async () => undefined, runners.wait);
    expect(runners.pauses.map((pause) => pause.resumeAt)).toEqual([
      RESET - 3 * 3_600_000 + 40 * 60_000,
    ]);
  });

  test("usage-limit responses without a placement pause are also bounded", async () => {
    const runners = fleet(() => "agentbox");
    for (let index = 0; index < 10; index++) runners.outcomes.push(limited("agentbox", RESET));
    await expect(
      runWithFailover(input(), runners.attempt, async () => undefined, runners.wait),
    ).rejects.toBeInstanceOf(UsageLimitExhaustedError);
    expect(runners.calls).toHaveLength(MAX_USAGE_LIMIT_EVENTS);
    expect(runners.pauses).toHaveLength(0);
  });

  test("work that cannot start for a usage limit waits for the reset", async () => {
    let cooled = true;
    const runners = fleet((_limit, now) => {
      if (cooled) {
        cooled = false;
        return new UsageLimitPause("claude", RESET + 60_000, RESET, null);
      }
      expect(now).toBe(RESET + 60_000);
      return "agentbox";
    });
    const result = await runWithFailover(
      input(),
      runners.attempt,
      async () => undefined,
      runners.wait,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(runners.pauses).toHaveLength(1);
    expect(runners.calls).toHaveLength(1);
  });

  test("a second runner with an available account takes the work without waiting", async () => {
    const runners = fleet((limit) => (limit ? "spare-box" : "agentbox"));
    runners.outcomes.push(limited("agentbox", RESET));
    await runWithFailover(input(), runners.attempt, async () => undefined, runners.wait);
    expect(runners.pauses).toEqual([]);
    expect(runners.calls.map((call) => call.runnerId)).toEqual(["agentbox", "spare-box"]);
    expect(runners.calls[1]!.at).toBe(runners.calls[0]!.at);
  });

  test("two runners on one account both at the limit wait for the reset instead of failing", async () => {
    const runners = fleet((limit, now) => {
      if (!limit) return "agentbox";
      if (limit.runnerId === "agentbox") return "goldbox";
      if (limit.resumeAt > now)
        return new UsageLimitPause("claude", limit.resumeAt, limit.resetsAt, limit.runnerId);
      return "agentbox";
    });
    runners.outcomes.push(limited("agentbox", RESET), limited("goldbox", RESET));
    const result = await runWithFailover(
      input(),
      runners.attempt,
      async () => undefined,
      runners.wait,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(runners.pauses).toHaveLength(1);
    expect(runners.calls.map((call) => call.runnerId)).toEqual(["agentbox", "goldbox", "agentbox"]);
    expect(runners.calls[2]!.at).toBe(RESET + 60_000);
  });

  test("Stop ends the wait", async () => {
    const stop = new AbortController();
    const runners = fleet(oneRunner);
    runners.outcomes.push(limited("agentbox", RESET));
    const run = runWithFailover(input(stop.signal), runners.attempt, async () => undefined, {
      now: () => runners.clock.now,
      pause: () =>
        new Promise<void>((_resolve, reject) =>
          stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }),
        ),
    });
    await Bun.sleep(1);
    stop.abort(new Error("cancelled"));
    await expect(run).rejects.toThrow("cancelled");
    expect(runners.calls).toHaveLength(1);
  });

  test("without a pause port, a usage limit still fails over as before", async () => {
    const runners = fleet(() => "agentbox");
    runners.outcomes.push(limited("agentbox", RESET));
    await runWithFailover(input(), runners.attempt, async () => undefined);
    expect(runners.calls[1]!.excluded).toEqual(["agentbox"]);
  });
});

describe("a review whose agent is limited everywhere moves to the fallback profile", () => {
  const claude = { agent: "claude" as const, model: "opus" };
  const codex = { agent: "codex" as const, model: "gpt-6-sol" };
  function review(fallbackProfile?: typeof codex): RunAgentOptions {
    return {
      ...input(),
      role: "reviewer",
      profile: claude,
      ...(fallbackProfile ? { fallbackProfile } : {}),
    };
  }
  function reviewers() {
    const profiles: (string | null)[] = [];
    const progress: string[] = [];
    let first = true;
    const attempt: FailoverAttempt = async (options, _excluded, limit) => {
      if (options.profile?.agent === "claude" && limit && limit.resumeAt > RESET - 3_600_000)
        throw new UsageLimitPause("claude", limit.resumeAt, limit.resetsAt, limit.runnerId);
      profiles.push(options.profile ? `${options.profile.agent}/${options.profile.model}` : null);
      if (first) {
        first = false;
        throw limited("agentbox", RESET);
      }
      return { ...done(), role: "reviewer" };
    };
    const pauses: number[] = [];
    const wait = {
      now: () => RESET - 3 * 3_600_000,
      async pause(limit: UsageLimitPause) {
        pauses.push(limit.resumeAt);
      },
    };
    const onEvent: RunAgentOptions["onEvent"] = (event) => {
      if (event.type === "progress") progress.push(event.text);
    };
    return { profiles, progress, pauses, attempt, wait, onEvent };
  }

  test("Claude at its weekly limit on every runner reviews with Codex instead of waiting", async () => {
    const runners = reviewers();
    const result = await runWithFailover(
      { ...review(codex), onEvent: runners.onEvent },
      runners.attempt,
      async () => undefined,
      runners.wait,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(runners.profiles).toEqual(["claude/opus", "codex/gpt-6-sol"]);
    expect(runners.pauses).toEqual([]);
    expect(runners.progress).toEqual([
      "claude reached its usage limit on every runner. Reviewing with codex gpt-6-sol instead.",
    ]);
  });

  test("without a fallback profile the review waits for the reset as before", async () => {
    const runners = reviewers();
    await runWithFailover(review(), runners.attempt, async () => undefined, runners.wait);
    expect(runners.profiles).toEqual(["claude/opus", "claude/opus"]);
    expect(runners.pauses).toEqual([RESET + 60_000]);
  });
});

describe("agent settings changed during a quota wait", () => {
  const claude = { agent: "claude" as const, model: "opus" };
  const codex = { agent: "codex" as const, model: "gpt-6-sol" };

  test("retries the same invocation using the changed profile without its stale quota", async () => {
    let profiles: ReturnType<NonNullable<RunAgentOptions["resolveProfiles"]>> = { profile: claude };
    const attempted: string[] = [];
    await runWithFailover(
      { ...input(), ...profiles, resolveProfiles: () => profiles },
      async (options, excluded, limit) => {
        attempted.push(options.profile!.agent);
        if (attempted.length === 1) throw new UsageLimitPause("claude", RESET, RESET, null);
        expect(excluded).toEqual([]);
        expect(limit).toBeUndefined();
        return done();
      },
      async () => undefined,
      {
        now: () => RESET - 60_000,
        async pause(_limit, changed) {
          expect(changed?.()).toBe(false);
          profiles = { profile: codex };
          expect(changed?.()).toBe(true);
        },
      },
    );
    expect(attempted).toEqual(["claude", "codex"]);
  });

  test("unchanged settings preserve the active fallback after its own quota pause", async () => {
    const profiles = { profile: claude, fallbackProfile: codex };
    const attempted: string[] = [];
    await runWithFailover(
      { ...input(), ...profiles, role: "reviewer", resolveProfiles: () => ({ ...profiles }) },
      async (options) => {
        attempted.push(options.profile!.agent);
        if (attempted.length < 3)
          throw new UsageLimitPause(options.profile!.agent, RESET, RESET, null);
        return done();
      },
      async () => undefined,
      {
        now: () => RESET - 60_000,
        async pause(_limit, changed) {
          expect(changed?.()).toBe(false);
        },
      },
    );
    expect(attempted).toEqual(["claude", "codex", "codex"]);
  });

  test("settings changes do not reset the usage retry budget", async () => {
    let profiles = { profile: claude as RunAgentOptions["profile"] };
    let attempts = 0;
    let waits = 0;
    await expect(
      runWithFailover(
        { ...input(), ...profiles, resolveProfiles: () => profiles },
        async (options) => {
          attempts++;
          throw new UsageLimitPause(options.profile!.agent, RESET, RESET, null);
        },
        async () => undefined,
        {
          now: () => RESET - 60_000,
          async pause(_limit, changed) {
            waits++;
            profiles = { profile: profiles.profile!.agent === "claude" ? codex : claude };
            expect(changed?.()).toBe(true);
          },
        },
      ),
    ).rejects.toBeInstanceOf(UsageLimitExhaustedError);
    expect(attempts).toBe(MAX_USAGE_LIMIT_EVENTS);
    expect(waits).toBe(MAX_USAGE_LIMIT_EVENTS);
  });

  test("a fallback added while waiting is used", async () => {
    let profiles: ReturnType<NonNullable<RunAgentOptions["resolveProfiles"]>> = { profile: claude };
    const attempted: string[] = [];
    await runWithFailover(
      { ...input(), ...profiles, role: "reviewer", resolveProfiles: () => profiles },
      async (options) => {
        attempted.push(options.profile!.agent);
        if (options.profile!.agent === "claude")
          throw new UsageLimitPause("claude", RESET, RESET, null);
        return done();
      },
      async () => undefined,
      {
        now: () => RESET - 60_000,
        async pause(_limit, changed) {
          profiles = { profile: claude, fallbackProfile: codex };
          expect(changed?.()).toBe(true);
        },
      },
    );
    expect(attempted).toEqual(["claude", "claude", "codex"]);
  });

  test("an account order edit during a quota wait wakes it and applies to the next attempt", async () => {
    const first = {
      revision: "r1",
      profile: { agent: "claude" as const, accounts: ["A"], source: "defaults" as const },
    };
    const second = {
      revision: "r2",
      profile: { agent: "claude" as const, accounts: ["B", "A"], source: "defaults" as const },
    };
    let profiles: ReturnType<NonNullable<RunAgentOptions["resolveProfiles"]>> = {
      profile: claude,
      accounts: first,
    };
    const seen: (RunAgentOptions["accounts"] | undefined)[] = [];
    await runWithFailover(
      { ...input(), ...profiles, resolveProfiles: () => profiles },
      async (options) => {
        seen.push(options.accounts);
        if (seen.length === 1) throw new UsageLimitPause("claude", RESET, RESET, null);
        return done();
      },
      async () => undefined,
      {
        now: () => RESET - 60_000,
        async pause(_limit, changed) {
          expect(changed?.()).toBe(false);
          profiles = { profile: claude, accounts: second };
          expect(changed?.()).toBe(true);
        },
      },
    );
    expect(seen).toEqual([first, second]);
  });

  test("the reviewer fallback runs with its own accounts after the reviewer's are spent", async () => {
    const accounts = {
      revision: "r1",
      profile: { agent: "claude" as const, accounts: ["A", "B"], source: "defaults" as const },
      fallback: { agent: "codex" as const, accounts: ["X"], source: "defaults" as const },
    };
    const seen: [string, RunAgentOptions["accounts"]][] = [];
    await runWithFailover(
      { ...input(), profile: claude, fallbackProfile: codex, accounts, role: "reviewer" },
      async (options) => {
        seen.push([options.profile!.agent, options.accounts]);
        if (options.profile!.agent === "claude")
          throw new UsageLimitPause("claude", RESET, RESET, null);
        return done();
      },
      async () => undefined,
    );
    expect(seen).toEqual([
      ["claude", accounts],
      ["codex", { revision: "r1", profile: accounts.fallback }],
    ]);
  });

  test("an account order that cannot run moves review to the explicit fallback, never another account of the reviewer", async () => {
    const accounts = {
      revision: "r1",
      profile: { agent: "claude" as const, accounts: ["A"], source: "defaults" as const },
      fallback: {
        agent: "codex" as const,
        accounts: ["legacy_codex_W"],
        source: "defaults" as const,
      },
    };
    const seen: [string, RunAgentOptions["accounts"]][] = [];
    await runWithFailover(
      { ...input(), profile: claude, fallbackProfile: codex, accounts, role: "reviewer" },
      async (options) => {
        seen.push([options.profile!.agent, options.accounts]);
        if (options.profile!.agent === "claude")
          throw new AccountPolicyUnavailable("claude", "No configured Claude account is eligible");
        return done();
      },
      async () => undefined,
    );
    expect(seen).toEqual([
      ["claude", accounts],
      ["codex", { revision: "r1", profile: accounts.fallback }],
    ]);
  });

  test("without a fallback an account order that cannot run waits as a transient error", async () => {
    const error = new AccountPolicyUnavailable(
      "claude",
      "No configured Claude account is eligible",
    );
    let attempts = 0;
    await expect(
      runWithFailover(
        { ...input(), profile: claude },
        async () => {
          attempts++;
          throw error;
        },
        async () => undefined,
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(isTransient(error)).toBe(true);
  });
});

test("a failed named account binding is excluded on its own, not its whole runner", async () => {
  const excluded: string[][] = [];
  let attempts = 0;
  await runWithFailover(
    input(),
    async (_options, avoid) => {
      excluded.push([...avoid]);
      if (++attempts === 1)
        throw new RetryableRunnerError(
          "runner-1",
          "The runner agent requires sign-in.",
          undefined,
          false,
          undefined,
          false,
          false,
          "binding-a",
        );
      if (attempts === 2) throw new RetryableRunnerError("runner-2", "Interrupted");
      return done();
    },
    async () => {},
  );
  expect(excluded).toEqual([[], ["binding-a"], ["binding-a", "runner-2"]]);
});

function memoryLedger() {
  const rows: (Parameters<FailoverLedger["record"]>[0] & { closed: boolean })[] = [];
  const ledger: FailoverLedger = {
    load(policyKey) {
      const mine = rows.filter((row) => row.policyKey === policyKey && !row.closed);
      return {
        excluded: [...new Set(mine.map((row) => row.excludedKey).filter(Boolean))],
        failures: mine.filter((row) => row.outcome === "failed").length,
        usageLimits: mine.filter((row) => row.outcome === "usage_limit").length,
      };
    },
    record(entry) {
      rows.push({ ...entry, closed: false });
    },
    finish() {
      for (const row of rows) row.closed = true;
    },
  };
  return { rows, ledger };
}

describe("persisted fallback attempts", () => {
  test("a restart keeps the failed binding out instead of trying A, B, then A again", async () => {
    const { rows, ledger } = memoryLedger();
    const seen: string[][] = [];
    await expect(
      runWithFailover(
        input(),
        async (_options, avoid) => {
          seen.push([...avoid]);
          if (seen.length === 1)
            throw new RetryableRunnerError(
              "runner-1",
              "The runner agent requires sign-in.",
              undefined,
              false,
              undefined,
              false,
              false,
              "binding-a",
            );
          throw new Error("Paws stopped");
        },
        async () => {},
        undefined,
        ledger,
      ),
    ).rejects.toThrow("Paws stopped");
    const resumed: string[][] = [];
    await runWithFailover(
      input(),
      async (_options, avoid) => {
        resumed.push([...avoid]);
        return done();
      },
      async () => {},
      undefined,
      ledger,
    );
    expect(seen).toEqual([[], ["binding-a"]]);
    expect(resumed).toEqual([["binding-a"]]);
    expect(rows.map((row) => [row.outcome, row.runnerId, row.excludedKey])).toEqual([
      ["failed", "runner-1", "binding-a"],
    ]);
  });

  test("the failure budget spent before a restart is not granted again", async () => {
    const { ledger } = memoryLedger();
    const fail = (runnerId: string) => new RetryableRunnerError(runnerId, "Interrupted");
    let calls = 0;
    await expect(
      runWithFailover(
        input(),
        async () => {
          calls++;
          if (calls === 1) throw fail("runner-1");
          throw new Error("Paws stopped");
        },
        async () => {},
        undefined,
        ledger,
      ),
    ).rejects.toThrow("Paws stopped");
    const after: string[] = [];
    await expect(
      runWithFailover(
        input(),
        async () => {
          const runnerId = `runner-${after.length + 2}`;
          after.push(runnerId);
          throw fail(runnerId);
        },
        async () => {},
        undefined,
        ledger,
      ),
    ).rejects.toBeInstanceOf(RetryableRunnerError);
    expect(after).toEqual(["runner-2", "runner-3"]);
  });

  test("the old execution is recorded before it settles, so an unconfirmed teardown keeps the attempt", async () => {
    const { rows, ledger } = memoryLedger();
    const order: string[] = [];
    const tracked: FailoverLedger = {
      ...ledger,
      record(entry) {
        order.push("record");
        ledger.record(entry);
      },
    };
    await expect(
      runWithFailover(
        input(),
        async () => {
          throw new RetryableRunnerError("runner-1", "Interrupted");
        },
        async () => {
          order.push("settle");
          throw new Error("teardown unconfirmed");
        },
        undefined,
        tracked,
      ),
    ).rejects.toThrow("teardown unconfirmed");
    expect(order).toEqual(["record", "settle"]);
    expect(ledger.load(rows[0]!.policyKey)).toEqual({
      excluded: ["runner-1"],
      failures: 1,
      usageLimits: 0,
    });
  });

  test("a handover is recorded without spending an attempt, and a pure wait is not recorded", async () => {
    const { rows, ledger } = memoryLedger();
    const runners = fleet((limit, now) =>
      limit && limit.resumeAt > now
        ? new UsageLimitPause("claude", limit.resumeAt, limit.resetsAt, limit.runnerId)
        : "agentbox",
    );
    runners.outcomes.push(
      new RetryableRunnerError("old", "Handed over", undefined, false, undefined, false, true),
      limited("agentbox", RESET),
    );
    await runWithFailover(input(), runners.attempt, async () => {}, runners.wait, ledger);
    expect(runners.pauses).toHaveLength(1);
    expect(rows.map((row) => [row.outcome, row.excludedKey])).toEqual([
      ["handed_over", "old"],
      ["usage_limit", ""],
    ]);
    expect(ledger.load(rows[0]!.policyKey).failures).toBe(0);
  });

  test("usage-limit events spent before a restart stay spent", async () => {
    const { ledger } = memoryLedger();
    for (let event = 0; event < MAX_USAGE_LIMIT_EVENTS; event++)
      ledger.record({
        policyKey: JSON.stringify([null, null, null]),
        outcome: "usage_limit",
        runnerId: "agentbox",
        excludedKey: "",
      });
    let calls = 0;
    await expect(
      runWithFailover(
        input(),
        async () => {
          calls++;
          return done();
        },
        async () => {},
        fleet(oneRunner).wait,
        ledger,
      ),
    ).rejects.toBeInstanceOf(UsageLimitExhaustedError);
    expect(calls).toBe(0);
  });

  test("changed agent settings start from that configuration's own attempts", async () => {
    const { ledger } = memoryLedger();
    ledger.record({
      policyKey: "another configuration",
      outcome: "failed",
      runnerId: "runner-1",
      excludedKey: "runner-1",
    });
    const seen: string[][] = [];
    await runWithFailover(
      input(),
      async (_options, avoid) => {
        seen.push([...avoid]);
        return done();
      },
      async () => {},
      undefined,
      ledger,
    );
    expect(seen).toEqual([[]]);
  });
});

test("a finished call closes its attempts, so a later call on the same run starts fresh", async () => {
  const { rows, ledger } = memoryLedger();
  let calls = 0;
  await runWithFailover(
    input(),
    async () => {
      if (++calls === 1) throw new RetryableRunnerError("runner-1", "Interrupted");
      return done();
    },
    async () => {},
    undefined,
    ledger,
  );
  expect(rows.map((row) => row.closed)).toEqual([true]);
  const seen: string[][] = [];
  await runWithFailover(
    input(),
    async (_options, avoid) => {
      seen.push([...avoid]);
      return done();
    },
    async () => {},
    undefined,
    ledger,
  );
  expect(seen).toEqual([[]]);
});
