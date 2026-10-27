import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluate";
import { probeArgv, probeArtifactPath } from "./rule-result";
import type { CommandRecord, ResolvedPolicyPresent, ResolvedRule } from "./types";

const TASK = "PAS-789";

describe("rule results", () => {
  test("a result without a matching probe hash does not pass", () => {
    const rule = policyRule("a".repeat(64));
    const policy: ResolvedPolicyPresent = {
      source: "repo",
      digest: `sha256:${"d".repeat(64)}`,
      entryPath: ".agents/closeout.yaml",
      setup: [],
      items: [],
      rules: [rule],
      files: [],
    };
    const request = {
      base: "b".repeat(40),
      head: "c".repeat(40),
      gate: "beforePR" as const,
      candidate: { ...candidate(), task: TASK },
      changedPaths: ["src/a.ts"],
    };
    const record = (sha256: string, exec: Partial<CommandRecord["exec"]> = {}): CommandRecord => ({
      specVersion: "0.1",
      recordType: "command",
      task: TASK,
      itemId: rule.id,
      base: request.base,
      head: request.head,
      policyDigest: policy.digest,
      attempt: 1,
      evaluator: { name: "paws-closeout", version: "0.1.0" },
      producer: { name: "paws-closeout", version: "0.1.0" },
      exec: {
        argv: probeArgv(rule, request.base, request.head),
        exitCode: 0,
        timedOut: false,
        dirty: false,
        headMoved: false,
        durationMs: 5,
        truncated: false,
        ...exec,
      },
      artifacts: [{ path: probeArtifactPath(sha256, rule.probe), sha256 }],
    });

    const matching = evaluate(policy, [record(rule.probeSha256)], request);
    expect(matching.decision).toBe("accepted");
    const other = evaluate(policy, [record("e".repeat(64))], request);
    expect(other.decision).toBe("blocked");
    expect(other.items).toContainEqual(
      expect.objectContaining({
        id: "probe-rule",
        state: "invalid",
        message: "rule result does not match the policy probe hash",
      }),
    );
    const missing = evaluate(policy, [], request);
    expect(missing.decision).toBe("blocked");
    expect(missing.items).toContainEqual(
      expect.objectContaining({ id: "probe-rule", state: "missing" }),
    );

    const finding = evaluate(policy, [record(rule.probeSha256, { exitCode: 1 })], request);
    expect(finding.items).toContainEqual(
      expect.objectContaining({
        id: "probe-rule",
        state: "failed",
        message: "probe exited 1; P1 finding: The probe's rule holds.",
      }),
    );
    const timedOut = evaluate(
      policy,
      [record(rule.probeSha256, { exitCode: null, timedOut: true })],
      request,
    );
    expect(timedOut.items).toContainEqual(
      expect.objectContaining({
        id: "probe-rule",
        state: "failed",
        message: "probe timed out; the rule was not judged: The probe's rule holds.",
      }),
    );
  });
});

function policyRule(probeSha256: string): ResolvedRule {
  return {
    id: "probe-rule",
    probe: ".agents/probes/rule.ts",
    probeSha256,
    exec: ["bun"],
    summary: "The probe's rule holds.",
    failOn: "P1",
    onFail: "fix",
  };
}

function candidate() {
  return { session: "impl-session", model: "claude", provider: "anthropic" };
}
