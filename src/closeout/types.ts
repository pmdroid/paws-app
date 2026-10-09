/**
 * Closeout draft 0.1 shapes the gate records.
 * The pinned `closeout` binary reads `.agents/closeout.yaml` from
 * `refs/heads/main` on `origin`. This module does not load that file.
 */

/** Reference runner edition this gate is pinned to. */
export const PINNED_CLOSEOUT_VERSION = "0.1.0";

/** Orchestrator fix budget from QM-06. Separate from the policy retry limit. */
export const MAX_FIX_ATTEMPTS = 2;

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
  reportPath?: string;
};

export type ExitMeaning = DecisionName | "invalid";

export function exitMeaning(code: number | null): ExitMeaning {
  switch (code) {
    case 0:
      return "accepted";
    case 1:
      return "rejected";
    case 3:
      return "blocked";
    default:
      return "invalid";
  }
}

export function expectedExit(decision: DecisionName): 0 | 1 | 3 {
  switch (decision) {
    case "accepted":
      return 0;
    case "rejected":
      return 1;
    case "blocked":
      return 3;
  }
}
