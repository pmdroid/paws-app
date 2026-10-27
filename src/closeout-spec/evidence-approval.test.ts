import { describe, expect, test } from "bun:test";
import { evaluate, type EvaluateRequest } from "./evaluate/evaluate";
import { parsePolicy } from "./policy/document";
import { policyCanonicalJson } from "./policy/canonical";
import type {
  EvidenceApproval,
  PublishedEvidence,
  ResolvedEvidence,
  ResolvedPolicyPresent,
} from "./types";

const HEAD = "b".repeat(40);

function policyText(extra: string[]): string {
  return [
    'specVersion: "0.1"',
    "items:",
    "  - id: visual-proof",
    "    kind: evidence",
    "    gate: beforePR",
    '    paths: ["src/web/**", "landing/**"]',
    ...extra,
    "",
  ].join("\n");
}

describe("approval: human in the policy", () => {
  test("parses on an evidence item", () => {
    const parsed = parsePolicy(policyText(["    approval: human"]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.items?.[0]).toEqual({
      id: "visual-proof",
      kind: "evidence",
      gate: "beforePR",
      paths: ["src/web/**", "landing/**"],
      approval: "human",
    });
  });

  test("is optional, and leaving it out keeps the item and its canonical form as before", () => {
    const parsed = parsePolicy(policyText([]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.items?.[0]).not.toHaveProperty("approval");
    expect(policyCanonicalJson({ files: [], setup: [], items: [item()] })).not.toContain(
      "approval",
    );
    expect(policyCanonicalJson({ files: [], setup: [], items: [item("human")] })).toContain(
      '"approval":"human"',
    );
  });

  test("rejects any other approval", () => {
    expect(parsePolicy(policyText(["    approval: robot"])).ok).toBe(false);
  });
});

describe("judging an approval: human check", () => {
  const first: PublishedEvidence = {
    id: "ev-1",
    checkId: "visual-proof",
    media: "image",
    commit: HEAD,
  };
  const second: PublishedEvidence = { ...first, id: "ev-2" };
  const approval: EvidenceApproval = {
    task: "task",
    checkId: "visual-proof",
    evidenceIds: ["ev-1"],
    approvedBy: "Pascal",
    approvedAt: "2026-10-22T09:00:00.000Z",
  };

  test("without the setting, published evidence passes as today", () => {
    expect(judge(item(), [first], [])).toEqual({ decision: "accepted", state: "passed" });
  });

  test("evidence without an approval is pending, which blocks without a fix round", () => {
    expect(judge(item("human"), [first], [])).toEqual({ decision: "blocked", state: "missing" });
    expect(messageOf(item("human"), [first], [])).toBe(
      "1 screenshot or video published, waiting for a visual review in Paws",
    );
  });

  test("passes with an approval for the same evidence", () => {
    expect(judge(item("human"), [first], [approval])).toEqual({
      decision: "accepted",
      state: "passed",
    });
    expect(messageOf(item("human"), [first], [approval])).toBe(
      "1 screenshot or video approved by Pascal at 2026-10-22T09:00:00.000Z",
    );
  });

  test("an approval for older evidence doesn't count", () => {
    expect(judge(item("human"), [first, second], [approval])).toEqual({
      decision: "blocked",
      state: "missing",
    });
    expect(judge(item("human"), [second], [approval])).toEqual({
      decision: "blocked",
      state: "missing",
    });
    const both = { ...approval, evidenceIds: ["ev-1", "ev-2"] };
    expect(judge(item("human"), [first, second], [approval, both])).toEqual({
      decision: "accepted",
      state: "passed",
    });
  });

  test("an approval of another task or check, or a file without an id, doesn't count", () => {
    expect(judge(item("human"), [first], [{ ...approval, task: "other" }]).state).toBe("missing");
    expect(judge(item("human"), [first], [{ ...approval, checkId: "other" }]).state).toBe(
      "missing",
    );
    const { id: _, ...unnamed } = first;
    expect(judge(item("human"), [unnamed], [approval]).state).toBe("missing");
  });

  test("too few files still fail, with the visual review hint", () => {
    expect(judge(item("human"), [], [approval])).toEqual({ decision: "rejected", state: "failed" });
    expect(messageOf(item("human"), [], [])).toContain(
      "Publish the screenshots, then a person reviews them in Paws.",
    );
  });
});

function item(approval?: "human"): ResolvedEvidence {
  return {
    id: "visual-proof",
    kind: "evidence",
    gate: "beforePR",
    media: ["image", "video"],
    minimum: 1,
    ...(approval ? { approval } : {}),
  };
}

function decide(
  evidence: ResolvedEvidence,
  published: PublishedEvidence[],
  approvals: EvidenceApproval[],
) {
  const policy: ResolvedPolicyPresent = {
    source: "repo",
    digest: `sha256:${"c".repeat(64)}`,
    entryPath: ".agents/closeout.yaml",
    setup: [],
    items: [evidence],
    files: [],
  };
  const request: EvaluateRequest = {
    base: "a".repeat(40),
    head: HEAD,
    gate: "beforePR",
    task: "task",
    candidate: { session: "s", model: "m", provider: "p" },
    changedPaths: ["src/web/page.ts"],
    published,
    approvals,
  };
  return evaluate(policy, [], request);
}

function judge(
  evidence: ResolvedEvidence,
  published: PublishedEvidence[],
  approvals: EvidenceApproval[],
): { decision: string; state: string | undefined } {
  const document = decide(evidence, published, approvals);
  return { decision: document.decision, state: document.items[0]?.state };
}

function messageOf(
  evidence: ResolvedEvidence,
  published: PublishedEvidence[],
  approvals: EvidenceApproval[],
): string | undefined {
  return decide(evidence, published, approvals).items[0]?.message;
}
