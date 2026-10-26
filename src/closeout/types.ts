/**
 * Closeout draft 0.1 shapes the gate records.
 * Policy loading, commands, review evidence, and the decision live in
 * `src/closeout-spec`. This module does not load the policy file.
 */

/** Orchestrator fix budget from QM-06. Separate from the policy retry limit. */
export const MAX_FIX_ATTEMPTS = 3;

export const CLOSEOUT_GATE = "beforePR" as const;

export type CloseoutGateName = typeof CLOSEOUT_GATE;

export type DecisionName = "accepted" | "rejected" | "blocked";

export type ItemState =
  | "passed"
  | "failed"
  | "missing"
  | "stale"
  | "unsupported"
  | "independence"
  | "untrusted"
  | "invalid"
  | "skipped"
  | "exhausted";

export type Severity = "P0" | "P1" | "P2" | "P3";

export type Finding = {
  severity: Severity;
  location: string;
  explanation: string;
  evidence: string;
};

export type CandidateIdentity = {
  session: string;
  model: string;
  provider: string;
};

export type CloseoutItem = {
  id: string;
  kind: string;
  state: ItemState;
  message: string;
  attempt?: number;
};

export type DecisionDocument = {
  specVersion: "0.1";
  decision: DecisionName;
  gate: CloseoutGateName;
  base: string;
  head: string;
  message?: string;
  candidate: {
    task?: string;
    session: string;
    model: string;
    provider: string;
  };
  policy: {
    path: string | null;
    digest: string | null;
    absent: boolean;
  };
  items: CloseoutItem[];
  warnings: Array<{ code: string; message: string }>;
};

/** How the gate finished. Only `accepted` may be published or merged. */
export type GateOutcome = "accepted" | "exhausted" | "blocked" | "invalid" | "fix_failed";

export type GateResult = {
  outcome: GateOutcome;
  taskId: string;
  base: string;
  head: string;
  fixAttempts: number;
  evaluations: number;
  exitCode: number | null;
  decision: DecisionDocument | null;
  summary: string;
  /** Detailed failed checks and output for a host-owned restart. */
  handoff?: string;
  reportPath?: string;
  bypasses?: readonly import("./bypass").CloseoutBypass[];
};
