export const CLOSEOUT_STEP_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "exhausted",
] as const;

export const CLOSEOUT_STEP_KINDS = ["setup", "command", "review"] as const;

export type CloseoutStepState = (typeof CLOSEOUT_STEP_STATES)[number];
export type CloseoutStepKind = (typeof CLOSEOUT_STEP_KINDS)[number];
export type CloseoutOutputStream = "stdout" | "stderr";

export type CloseoutProgressIdentity = {
  taskId: string;
  base: string;
  head: string;
  policyDigest: string;
  policyPath: string | null;
};

export type CloseoutProgressStep = {
  id: string;
  kind: CloseoutStepKind;
  state: CloseoutStepState;
  command: string;
  detail: string | null;
  attempt: number;
  timeoutSeconds: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  timeoutReason: string | null;
  truncated: boolean;
  logPath: string | null;
  evidencePath: string | null;
  findings: string | null;
  ordinal: number;
  durationMs?: number | null;
  tokens?: number | null;
};

export interface CloseoutProgress {
  begin(identity: CloseoutProgressIdentity): void;
  step(identity: CloseoutProgressIdentity, step: CloseoutProgressStep): void;
  output(
    identity: CloseoutProgressIdentity,
    stepId: string,
    stream: CloseoutOutputStream,
    text: string,
    truncated: boolean,
  ): void;
  finish(identity: CloseoutProgressIdentity, decision: string): void;
}
