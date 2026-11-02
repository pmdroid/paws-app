import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluate/evaluate";
import { parsePolicy } from "./policy/document";
import { loadMemoryPolicy, type TreePolicy } from "./policy/resolve";
import { decodePolicyFiles, encodePolicyFiles } from "./policy/transfer";
import { previewAccept, type PreviewAcceptInput } from "./preview";
import type { EvidenceApproval, ResolvedPolicyPresent } from "./types";

const S = "1".repeat(40);
const NEXT = "2".repeat(40);
const POLICY = [
  'specVersion: "0.1"',
  "items:",
  "  - id: live-preview",
  "    kind: preview",
  "    gate: beforePR",
  "    approval: human",
  '    paths: ["src/web/**", "landing/**"]',
  "",
].join("\n");

function policy(): TreePolicy {
  const loaded = loadMemoryPolicy(new Map([[".agents/closeout.yaml", bytes(POLICY)]]));
  if (!loaded.ok || loaded.absent) throw new Error("the preview policy did not load");
  return loaded.policy;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function judge(head: string, changedPaths: string[], approvals: EvidenceApproval[]) {
  const present: ResolvedPolicyPresent = {
    ...policy(),
    source: "repo",
    entryPath: ".agents/closeout.yaml",
  };
  const document = evaluate(present, [], {
    base: "a".repeat(40),
    head,
    gate: "beforePR",
    task: "task",
    candidate: { session: "s", model: "m", provider: "p" },
    changedPaths,
    approvals,
  });
  return { decision: document.decision, item: document.items[0] };
}

function accept(overrides: Partial<PreviewAcceptInput> = {}) {
  return previewAccept({
    task: "task",
    checkId: "live-preview",
    head: S,
    url: "https://paws-preview-1.example.ts.net/",
    acceptedBy: "member",
    acceptedAt: Date.UTC(2026, 10, 1),
    via: "paws",
    delegatedBy: "member",
    projectLead: "lead",
    ...overrides,
  });
}

function accepted(head = S): EvidenceApproval {
  const result = accept({ head });
  if (!result.ok) throw new Error(result.reason);
  return result.approval;
}

describe("the preview check in the policy", () => {
  test("parses and resolves with its paths and human approval", () => {
    expect(policy().items).toEqual([
      {
        id: "live-preview",
        kind: "preview",
        gate: "beforePR",
        approval: "human",
        paths: ["src/web/**", "landing/**"],
      },
    ]);
  });

  test("requires approval: human", () => {
    expect(parsePolicy(POLICY.replace("    approval: human\n", "")).ok).toBe(false);
    expect(parsePolicy(POLICY.replace("approval: human", "approval: robot")).ok).toBe(false);
  });

  test("round-trips through the transfer to the runner", () => {
    const sent = policy();
    const files = new Map([[".agents/closeout.yaml", bytes(POLICY)]]);
    const decoded = decodePolicyFiles(
      encodePolicyFiles({ ok: true, absent: false, digest: sent.digest, files }),
    );
    if (!decoded.ok || decoded.absent) throw new Error("the policy did not survive the transfer");
    expect(decoded.digest).toBe(sent.digest);
    const received = loadMemoryPolicy(decoded.files);
    if (!received.ok || received.absent) throw new Error("the runner could not load the policy");
    expect(received.policy.digest).toBe(sent.digest);
    expect(received.policy.items).toEqual(sent.items);
  });
});

describe("judging a preview check", () => {
  test("a matching change is held until Accept", () => {
    const held = judge(S, ["src/web/page.ts"], []);
    expect(held.decision).toBe("blocked");
    expect(held.item?.state).toBe("missing");
    expect(judge(S, ["src/web/page.ts"], [accepted()]).decision).toBe("accepted");
  });

  test("Accept on head S passes S, and a new head needs a new Accept", () => {
    const passed = judge(S, ["src/web/page.ts"], [accepted(S)]);
    expect(passed.item?.state).toBe("passed");
    expect(passed.item?.message).toContain("accepted by member");
    expect(passed.item?.message).toContain("https://paws-preview-1.example.ts.net/");
    const stale = judge(NEXT, ["src/web/page.ts"], [accepted(S)]);
    expect(stale.decision).toBe("blocked");
    expect(stale.item?.state).toBe("missing");
    expect(judge(NEXT, ["src/web/page.ts"], [accepted(S), accepted(NEXT)]).decision).toBe(
      "accepted",
    );
  });

  test("an Accept for another task or check does not count", () => {
    const other = { ...accepted(), task: "other" };
    const visual = { ...accepted(), checkId: "visual-proof" };
    expect(judge(S, ["landing/index.html"], [other, visual]).item?.state).toBe("missing");
  });

  test("a non-matching change does not require the check", () => {
    const result = judge(S, ["src/loop/index.ts"], []);
    expect(result.decision).toBe("accepted");
    expect(result.item?.state).toBe("skipped");
  });
});

describe("recording an Accept", () => {
  test("holds who accepted, when, and the previewed head and URL", () => {
    expect(accept()).toEqual({
      ok: true,
      approval: {
        task: "task",
        checkId: "live-preview",
        evidenceIds: [],
        approvedBy: "member",
        approvedAt: "2026-11-01T00:00:00.000Z",
        commit: S,
        url: "https://paws-preview-1.example.ts.net/",
      },
    });
  });

  test("the delegating member or the project lead can accept, nobody else", () => {
    expect(accept({ acceptedBy: "lead" }).ok).toBe(true);
    expect(accept({ acceptedBy: "someone" }).ok).toBe(false);
    expect(accept({ acceptedBy: "", delegatedBy: "", projectLead: null }).ok).toBe(false);
  });

  test("a Linear reply cannot accept", () => {
    expect(accept({ via: "linear" })).toEqual({
      ok: false,
      reason: "A Linear reply cannot accept a preview.",
    });
  });

  test("refuses a head that is not a commit or a URL that is not http(s)", () => {
    expect(accept({ head: "main" }).ok).toBe(false);
    expect(accept({ url: "javascript:alert(1)" }).ok).toBe(false);
  });
});
