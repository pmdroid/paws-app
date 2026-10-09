import type { CloseoutDecision, CloseoutGate, CloseoutRunInput, CloseoutVerdict } from "./gate";

export type FakeCloseoutGate = CloseoutGate & {
  runs: CloseoutRunInput[];
  next: CloseoutVerdict;
};

export function createFakeCloseoutGate(decision: CloseoutDecision = "accepted"): FakeCloseoutGate {
  const runs: CloseoutRunInput[] = [];
  const gate: FakeCloseoutGate = {
    runs,
    next: { decision, exhausted: false, summary: `fake ${decision}` },
    async run(input) {
      runs.push(input);
      return gate.next;
    },
  };
  return gate;
}
