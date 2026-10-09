import { describe, expect, test } from "bun:test";
import { interpretCloseoutOutput, parseDecisionJson } from "./parse";
import { exitMeaning } from "./types";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: "0.1",
    decision: "accepted",
    gate: "beforePR",
    base: SHA_A,
    head: SHA_B,
    candidate: { session: "impl", model: "claude", provider: "anthropic" },
    policy: { path: ".agents/closeout.yaml", digest: `sha256:${"c".repeat(64)}`, absent: false },
    items: [{ id: "typecheck", kind: "command", state: "passed", message: "exited 0" }],
    warnings: [],
    ...overrides,
  };
}

describe("closeout exit codes", () => {
  test("maps 0, 1, 2, and 3", () => {
    expect(exitMeaning(0)).toBe("accepted");
    expect(exitMeaning(1)).toBe("rejected");
    expect(exitMeaning(2)).toBe("invalid");
    expect(exitMeaning(3)).toBe("blocked");
    expect(exitMeaning(null)).toBe("invalid");
    expect(exitMeaning(9)).toBe("invalid");
  });

  test("accepts a JSON decision whose exit agrees", () => {
    const parsed = interpretCloseoutOutput(0, JSON.stringify(decision()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision.decision).toBe("accepted");
  });

  test("does not accept when the exit disagrees with the document", () => {
    const parsed = interpretCloseoutOutput(0, JSON.stringify(decision({ decision: "rejected" })));
    expect(parsed.ok).toBe(false);
  });

  test("treats exit 2 as an invalid invocation even with a body", () => {
    const parsed = interpretCloseoutOutput(2, JSON.stringify(decision()));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("invalid");
  });

  test("rejects unknown fields and a missing warnings array", () => {
    expect(parseDecisionJson(JSON.stringify(decision({ extra: true }))).ok).toBe(false);
    const withoutWarnings = decision();
    delete withoutWarnings.warnings;
    expect(parseDecisionJson(JSON.stringify(withoutWarnings)).ok).toBe(false);
  });
});
