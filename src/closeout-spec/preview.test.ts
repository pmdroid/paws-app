import { expect, test } from "bun:test";
import { parsePolicy } from "./policy/document";
import { evaluate, type EvaluateRequest } from "./evaluate/evaluate";
import type { EvidenceApproval, ResolvedPolicyPresent } from "./types";

const HEAD = "b".repeat(40);
const policy: ResolvedPolicyPresent = {
  source: "repo",
  digest: `sha256:${"c".repeat(64)}`,
  entryPath: ".agents/closeout.yaml",
  setup: [],
  files: [],
  items: [
    {
      id: "live-preview",
      kind: "preview",
      gate: "beforePR",
      approval: "human",
      paths: ["src/web/**"],
    },
  ],
};
function judge(head = HEAD, approvals: EvidenceApproval[] = [], changedPaths = ["src/web/app.ts"]) {
  const request: EvaluateRequest = {
    base: "a".repeat(40),
    head,
    task: "task",
    gate: "beforePR",
    candidate: { session: "s", model: "m", provider: "p" },
    changedPaths,
    approvals,
  };
  return evaluate(policy, [], request);
}
const approval: EvidenceApproval = {
  task: "task",
  checkId: "live-preview",
  evidenceIds: [`preview:${HEAD}`],
  commit: HEAD,
  approvedBy: "lead",
  approvedAt: new Date().toISOString(),
};

test("parses the issue's preview shorthand with human approval", () => {
  const parsed = parsePolicy(
    'specVersion: "0.1"\nitems:\n  - id: live-preview\n    type: preview\n    approval: human\n    paths: ["src/web/**"]\n',
  );
  expect(parsed.ok).toBe(true);
  if (parsed.ok)
    expect(parsed.document.items?.[0]).toMatchObject({
      id: "live-preview",
      kind: "preview",
      approval: "human",
      paths: ["src/web/**"],
    });
  expect(
    parsePolicy(
      'specVersion: "0.1"\nitems:\n  - id: live-preview\n    type: preview\n    approval: agent\n',
    ).ok,
  ).toBe(false);
});
test("matching preview holds the PR until exact-commit acceptance; unrelated paths skip it", () => {
  expect(judge().decision).toBe("blocked");
  expect(judge(HEAD, [approval]).decision).toBe("accepted");
  expect(judge("d".repeat(40), [approval]).decision).toBe("blocked");
  expect(judge(HEAD, [{ ...approval, task: "other" }]).decision).toBe("blocked");
  expect(judge(HEAD, [{ ...approval, evidenceIds: ["screenshot"] }]).decision).toBe("blocked");
  expect(judge(HEAD, [], ["src/core/state.ts"]).items[0]?.state).toBe("skipped");
});
