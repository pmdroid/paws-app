import {
  expectedPhases,
  OWNER_REVIEW_PHASE,
  phaseFailures,
  REQUIRED_PHASES,
  requiredVerdict,
  type PhaseFailure,
  type RulecheckReceipt,
  type RulecheckVerdict,
} from "./receipt";

export type ShadowSideName = "ci" | "paws";

export type ShadowSide =
  | { receipt: RulecheckReceipt; source: string; gaps?: readonly string[] }
  | { receipt: null; source: string; reason: string };

export type ShadowInput = {
  head: string;
  ci: ShadowSide;
  paws: ShadowSide;
  mergeGroup?: { pullHead: string };
};

export type ShadowSideReport = {
  source: string;
  candidateSha: string | null;
  baseSha: string | null;
  verdict: RulecheckVerdict | null;
  outcome: RulecheckVerdict | null;
  failures: PhaseFailure[];
};

export type ShadowStatus = "agree" | "disagree" | "incomplete";

export type ShadowComparison = {
  head: string;
  status: ShadowStatus;
  authoritative: "closeout";
  enforced: false;
  gaps: string[];
  mismatches: string[];
  notes: string[];
  ci: ShadowSideReport;
  paws: ShadowSideReport;
};

const LABEL: Record<ShadowSideName, string> = { ci: "CI", paws: "Paws" };
const REQUIRED_TOOLS = ["builder", "evaluator"] as const;
const NOTED_TOOLS = ["node", "git", "sourceSha"] as const;

export function compareReceipts(input: ShadowInput): ShadowComparison {
  const gaps: string[] = [];
  const mismatches: string[] = [];
  const notes: string[] = [];
  const current = { ci: usable("ci", input, gaps), paws: usable("paws", input, gaps) };

  const { ci, paws } = current;
  if (ci && paws) {
    if (ci.baseSha !== paws.baseSha)
      mismatches.push(
        `Base SHA differs: CI ${ci.baseSha ?? "none"}, Paws ${paws.baseSha ?? "none"}.`,
      );
    for (const tool of REQUIRED_TOOLS)
      if (ci.tools[tool] !== paws.tools[tool])
        mismatches.push(
          `Tool ${tool} differs: CI ${ci.tools[tool] ?? "none"}, Paws ${paws.tools[tool] ?? "none"}.`,
        );
    for (const tool of NOTED_TOOLS)
      if (ci.tools[tool] !== paws.tools[tool])
        notes.push(
          `${tool} differs: CI ${ci.tools[tool] ?? "none"}, Paws ${paws.tools[tool] ?? "none"}.`,
        );
    comparePhases(ci, paws, mismatches);
    const ciVerdict = requiredVerdict(ci);
    const pawsVerdict = requiredVerdict(paws);
    if (ciVerdict !== pawsVerdict)
      mismatches.push(`Outcome differs: CI ${ciVerdict}, Paws ${pawsVerdict}.`);
    if (ci.phases[OWNER_REVIEW_PHASE] && !paws.phases[OWNER_REVIEW_PHASE])
      notes.push(
        `Only CI read the policy owner's review (${ci.phases[OWNER_REVIEW_PHASE].outcome}); it is not compared.`,
      );
  }

  const status: ShadowStatus =
    gaps.length > 0 ? "incomplete" : mismatches.length > 0 ? "disagree" : "agree";
  return {
    head: input.head,
    status,
    authoritative: "closeout",
    enforced: false,
    gaps,
    mismatches,
    notes,
    ci: sideReport(input.ci, current.ci),
    paws: sideReport(input.paws, current.paws),
  };
}

function usable(name: ShadowSideName, input: ShadowInput, gaps: string[]): RulecheckReceipt | null {
  const side = input[name];
  const label = LABEL[name];
  if (side.receipt === null) {
    gaps.push(`${label} has no receipt for ${input.head}: ${side.reason}`);
    return null;
  }
  const receipt = side.receipt;
  const before = gaps.length;
  for (const gap of side.gaps ?? []) gaps.push(`${label}: ${gap}`);
  if (receipt.candidateSha !== input.head) {
    gaps.push(
      name === "ci" && input.mergeGroup && receipt.candidateSha === input.mergeGroup.pullHead
        ? `Merge-group head ${input.head} needs its own CI result; the CI receipt is for pull request head ${receipt.candidateSha}.`
        : `${label} receipt is for ${receipt.candidateSha ?? "no candidate"}, not head ${input.head}. A new head needs a new receipt.`,
    );
  }
  const missing = expectedPhases(receipt).filter((phase) => receipt.phases[phase] === undefined);
  if (missing.length > 0)
    gaps.push(`${label} receipt lacks required phases: ${missing.join(", ")}.`);
  return gaps.length === before ? receipt : null;
}

function comparePhases(ci: RulecheckReceipt, paws: RulecheckReceipt, mismatches: string[]): void {
  const names = ["setup", ...REQUIRED_PHASES];
  for (const name of names) {
    const left = ci.phases[name];
    const right = paws.phases[name];
    if (left === undefined && right === undefined) continue;
    if (left === undefined || right === undefined) {
      mismatches.push(`Phase ${name} ran only in ${left ? "CI" : "Paws"}.`);
      continue;
    }
    if (left.policySha !== right.policySha)
      mismatches.push(
        `Phase ${name} read policy from different commits: CI ${left.policySha ?? "none"}, Paws ${right.policySha ?? "none"}.`,
      );
    if (left.policyDigest !== right.policyDigest)
      mismatches.push(
        `Phase ${name} policy digest differs: CI ${left.policyDigest ?? "none"}, Paws ${right.policyDigest ?? "none"}.`,
      );
    if (left.outcome !== right.outcome)
      mismatches.push(`Phase ${name} outcome differs: CI ${left.outcome}, Paws ${right.outcome}.`);
  }
}

function sideReport(side: ShadowSide, current: RulecheckReceipt | null): ShadowSideReport {
  const receipt = side.receipt;
  return {
    source: side.source,
    candidateSha: receipt?.candidateSha ?? null,
    baseSha: receipt?.baseSha ?? null,
    verdict: current ? requiredVerdict(current) : null,
    outcome: receipt ? (receipt.outcome === "error" ? "cannot-judge" : receipt.outcome) : null,
    failures: current ? phaseFailures(current) : [],
  };
}
