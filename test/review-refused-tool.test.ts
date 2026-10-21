import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent, type AcpEvent, type RunAgentOptions } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import { createAcpCodexReviewer } from "../src/loop";
import { tempHome } from "./helpers";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const terminalCall = {
  toolCallId: "find-1",
  title: "find / -path '*react-router/package.json'",
  name: "run_terminal_command",
  kind: "execute",
  rawInput: { command: "find / -path '*react-router/package.json'" },
};

function fixture(steps: FakeScript["steps"]) {
  const home = tempHome();
  homes.push(home);
  spawnSync("git", ["init", "-q", "-b", "main", home]);
  const script = join(home, "script.json");
  const trace = join(home, "trace.json");
  writeFileSync(script, JSON.stringify({ model: "reviewer-model", steps } satisfies FakeScript));
  const events: AcpEvent[] = [];
  const runs: string[] = [];
  const review = createAcpCodexReviewer({
    pawsRoot: home,
    home,
    launch: () => ({}),
    async agentRunner(options: RunAgentOptions) {
      runs.push(options.runId);
      return runAgent({
        ...options,
        command: process.execPath,
        args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        onEvent(event) {
          events.push(event);
          return options.onEvent?.(event);
        },
      });
    },
  });
  const request = {
    worktree: home,
    taskId: "PAS-383-task",
    itemId: "independent-review",
    base: "a".repeat(40),
    head: "b".repeat(40),
    candidate: { session: "implementer", model: "implementer-model", provider: "fixture" },
  };
  return {
    review: () => review.review(request),
    events,
    runs,
    trace: () => JSON.parse(readFileSync(trace, "utf8")) as FakeResult,
  };
}

test("a refused terminal call with only allow options leaves the review turn running", async () => {
  const run = fixture([
    {
      type: "permission",
      toolCall: terminalCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
      ],
    },
    {
      type: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "[]" },
      },
    },
    { type: "end", stopReason: "end_turn" },
  ]);
  const result = await run.review();
  expect(run.runs).toHaveLength(1);
  expect(result.model).toBe("reviewer-model");
  expect(result.findings).toEqual([]);
  const permission = run.trace().permissions[0];
  expect(permission?.outcome).toBeNull();
  expect(permission?.error).toContain("Permission denied");
  expect(run.events.filter((event) => event.type === "permission")).toEqual([
    expect.objectContaining({
      toolCallId: "find-1",
      decision: "deny",
      reason: "read-only session",
      name: "run_terminal_command",
      kind: "execute",
    }),
  ]);
});

test("a review that ends cancelled after a refused tool call runs once more and names the tool", async () => {
  const run = fixture([
    { type: "permission", toolCall: terminalCall },
    { type: "end", stopReason: "cancelled" },
  ]);
  const failure = await run.review().then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(run.runs).toHaveLength(2);
  expect(new Set(run.runs).size).toBe(2);
  expect(failure?.message).toContain("Paws refused the tool call `run_terminal_command`");
  expect(failure?.message).toContain("Review did not complete: cancelled");
  const decisions = run.events.filter((event) => event.type === "permission");
  expect(decisions.map((event) => event.decision)).toEqual(["deny", "deny"]);
  expect(decisions[0]).toHaveProperty("optionId", "deny");
});
