import { z } from "zod";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const outcomeSchema = z.enum(["pass", "violation", "error"]);

const phaseSchema = z.looseObject({
  policySha: z.string().regex(SHA).nullable(),
  policyDigest: z.string().regex(DIGEST).nullable(),
  outcome: outcomeSchema,
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  owner: z.string().optional(),
  required: z.boolean().optional(),
  reviewSha: z.string().nullable().optional(),
  reviewState: z.string().nullable().optional(),
});

const receiptSchema = z.looseObject({
  version: z.literal(1),
  baseSha: z.string().regex(SHA).nullable(),
  candidateSha: z.string().regex(SHA).nullable(),
  tools: z.looseObject({
    sourceSha: z.string().nullable(),
    node: z.string().nullable(),
    git: z.string().nullable(),
    builder: z.string().nullable(),
    evaluator: z.string().nullable(),
  }),
  phases: z.record(z.string(), phaseSchema),
  effectivePolicyDiff: z
    .looseObject({
      baseDigest: z.string(),
      proposedDigest: z.string(),
      changes: z.array(z.looseObject({ id: z.string() })),
    })
    .nullable(),
  outcome: outcomeSchema,
});

export type RulecheckReceipt = z.infer<typeof receiptSchema>;
export type RulecheckPhase = z.infer<typeof phaseSchema>;
export type RulecheckOutcome = z.infer<typeof outcomeSchema>;

export function parseRulecheckReceipt(
  text: string,
): { ok: true; receipt: RulecheckReceipt } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the receipt is not JSON" };
  }
  const parsed = receiptSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "document";
    return {
      ok: false,
      reason: `the receipt is not Rulecheck evidence v1 (${where}: ${issue?.message})`,
    };
  }
  return { ok: true, receipt: parsed.data };
}

export const REQUIRED_PHASES = [
  "base-build",
  "base-validate",
  "base-check",
  "proposed-build",
  "proposed-validate",
  "proposed-test",
  "proposed-check",
] as const;

export const OWNER_REVIEW_PHASE = "proposed-owner-review";

export function expectedPhases(receipt: RulecheckReceipt): string[] {
  if (receipt.phases.setup !== undefined) return [];
  const expected: string[] = [];
  for (const chain of ["base", "proposed"]) {
    for (const name of REQUIRED_PHASES.filter((id) => id.startsWith(`${chain}-`))) {
      expected.push(name);
      const step = receipt.phases[name];
      if (step === undefined) break;
      if ((name.endsWith("-build") || name.endsWith("-validate")) && step.outcome !== "pass") break;
    }
  }
  return expected;
}

export type RulecheckVerdict = "pass" | "violation" | "cannot-judge";

export type FailureKind = "code" | "fixtures" | "configuration" | "evaluator" | "owner-review";

export type Finding = { path: string; line: number; column: number; rule: string; message: string };

export type PhaseFailure = {
  phase: string;
  outcome: "violation" | "error";
  kind: FailureKind;
  remediation: string;
  findings: Finding[];
};

const FINDING = /^(.+?):(\d+):(\d+): \[([^\]]+)\] (.*)$/;

export function parseFindings(stdout: string | undefined): Finding[] {
  return (stdout ?? "").split("\n").flatMap((line) => {
    const match = FINDING.exec(line.trim());
    if (!match) return [];
    const [, path, row, column, rule, message] = match;
    return [
      { path: path!, line: Number(row), column: Number(column), rule: rule!, message: message! },
    ];
  });
}

export function phaseFailures(receipt: RulecheckReceipt): PhaseFailure[] {
  const order = ["setup", ...REQUIRED_PHASES, OWNER_REVIEW_PHASE];
  const names = Object.keys(receipt.phases).sort(
    (left, right) => rank(order, left) - rank(order, right) || left.localeCompare(right),
  );
  return names.flatMap((name) => {
    const step = receipt.phases[name]!;
    if (step.outcome === "pass") return [];
    return [failure(name, step, receipt)];
  });
}

function rank(order: readonly string[], name: string): number {
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function failure(name: string, step: RulecheckPhase, receipt: RulecheckReceipt): PhaseFailure {
  const outcome = step.outcome === "violation" ? "violation" : "error";
  const detail = firstLine(step.error ?? step.stderr ?? step.stdout);
  const findings =
    name.endsWith("-check") && outcome === "violation" ? parseFindings(step.stdout) : [];
  const kind = failureKind(name, outcome);
  return {
    phase: name,
    outcome,
    kind,
    remediation: remediation(name, kind, detail, findings, receipt),
    findings,
  };
}

function failureKind(name: string, outcome: "violation" | "error"): FailureKind {
  if (name === OWNER_REVIEW_PHASE) return outcome === "violation" ? "owner-review" : "evaluator";
  if (name.endsWith("-build") || name.endsWith("-validate")) return "configuration";
  if (outcome === "error") return "evaluator";
  if (name.endsWith("-test")) return "fixtures";
  if (name.endsWith("-check")) return "code";
  return "evaluator";
}

function remediation(
  name: string,
  kind: FailureKind,
  detail: string,
  findings: readonly Finding[],
  receipt: RulecheckReceipt,
): string {
  const suffix = detail ? `: ${detail}` : ".";
  switch (kind) {
    case "code": {
      const policy = name.startsWith("base-")
        ? "The base branch's policy flags the candidate; changing the rules in this pull request cannot clear it."
        : "The proposed policy flags the candidate.";
      const lines = findings.map(
        (entry) => `${entry.path}:${entry.line}:${entry.column} [${entry.rule}] ${entry.message}`,
      );
      return [
        policy,
        ...(lines.length > 0 ? [`Fix: ${lines.join("; ")}`] : [`Fix the findings${suffix}`]),
      ].join(" ");
    }
    case "fixtures":
      return `A proposed rule's fixtures fail; fix the rule or its fixtures under .rulecheck/rules${suffix}`;
    case "configuration":
      return `The ${name.split("-")[0]} policy does not build or validate; fix the rule files under .rulecheck/rules${suffix} This is a policy problem, not a finding in the code.`;
    case "owner-review":
      return `The policy change needs the policy owner's approval on ${receipt.candidateSha ?? "the candidate"}; rerun CI after approval.`;
    case "evaluator":
      return `Rulecheck could not judge this phase${suffix} Rerun after fixing the tools or the unreadable path; the code was not judged.`;
  }
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").find((entry) => entry.trim().length > 0);
  return line === undefined ? "" : line.trim().slice(0, 500);
}

export function requiredVerdict(receipt: RulecheckReceipt): RulecheckVerdict {
  const outcomes = Object.entries(receipt.phases)
    .filter(([name]) => name !== OWNER_REVIEW_PHASE)
    .map(([, step]) => step.outcome);
  if (outcomes.length === 0 || outcomes.includes("error")) return "cannot-judge";
  if (outcomes.includes("violation")) return "violation";
  return "pass";
}
