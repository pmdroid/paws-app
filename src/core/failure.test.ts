import { describe, expect, test } from "bun:test";
import { isTransientFailure } from "./failure";
import { PawsShutdown, RunnerSlotsBusyError } from "./user-facing-error";

function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe("isTransientFailure", () => {
  test.each([
    ["a Linear rate limit", named("LinearRateLimitError", "Linear GraphQL: RATELIMITED")],
    ["a runner that restarted or lost its lease", named("RunnerWorkFencedError")],
    ["a runner failover that ran out of runners", named("RetryableRunnerError")],
    ["an agent usage limit", named("UsageLimitPause")],
    ["no paired runner right now", named("RunnerUnavailableError")],
    [
      "a Git fetch that kept timing out",
      new Error("fetch failed: Connection timed out", { cause: named("GitTransportError") }),
    ],
    ["Paws restarting", new PawsShutdown()],
    ["a request timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["a reset connection", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [
      "a failed fetch with a network cause",
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    ],
    ["a failed fetch without a cause", new TypeError("fetch failed")],
    ["a server error status", Object.assign(new Error("GitHub 502"), { status: 502 })],
    ["a secondary rate limit status", Object.assign(new Error("GitHub 429"), { status: 429 })],
    [
      "a transient cause wrapped twice",
      new Error("outer", { cause: new Error("middle", { cause: named("TimeoutError") }) }),
    ],
  ])("%s is transient", (_label, error) => {
    expect(isTransientFailure(error)).toBe(true);
  });

  test.each([
    ["a plain error", new Error("Implementer did not report a concrete session model")],
    ["an illegal transition", named("TransitionRejectedError", "illegal_transition")],
    ["a user-facing refusal", new RunnerSlotsBusyError()],
    ["a client error status", Object.assign(new Error("GitHub 404"), { status: 404 })],
    ["a git failure", named("GitCommandError", "git push failed")],
    ["a string", "RATELIMITED"],
    ["nothing", undefined],
    [
      "a transient cause nested too deep",
      new Error("1", {
        cause: new Error("2", {
          cause: new Error("3", { cause: new Error("4", { cause: named("TimeoutError") }) }),
        }),
      }),
    ],
  ])("%s is terminal", (_label, error) => {
    expect(isTransientFailure(error)).toBe(false);
  });
});
