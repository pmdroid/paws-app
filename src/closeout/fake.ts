import type { CloseoutDecision, CloseoutGate, CloseoutRunInput, CloseoutVerdict } from "./gate";

export type FakeCloseoutGate = CloseoutGate & {
  runs: CloseoutRunInput[];
  /** Calls to `decide`, which run no command and no review. */
  decisions: CloseoutRunInput[];
  next: CloseoutVerdict;
  /** What `decide` returns. Defaults to `next`. */
  decided?: CloseoutVerdict;
  /** While set, `run` records the call and waits for it: the checks are still running. */
  held?: Promise<void>;
};

export function createFakeCloseoutGate(decision: CloseoutDecision = "accepted"): FakeCloseoutGate {
  const runs: CloseoutRunInput[] = [];
  const decisions: CloseoutRunInput[] = [];
  const gate: FakeCloseoutGate = {
    runs,
    decisions,
    next: { decision, exhausted: false, summary: `fake ${decision}` },
    async run(input) {
      runs.push(input);
      await gate.held;
      return gate.next;
    },
    async decide(input) {
      decisions.push(input);
      return gate.decided ?? gate.next;
    },
  };
  return gate;
}
