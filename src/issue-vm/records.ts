import {
  insertIssueVmSteps,
  issueVmByIdSteps,
  updateLiveIssueVmStateSteps,
  type IssueVmState,
  type NewIssueVm,
  type Q,
} from "../db";

export function* recordIssueVmSteps(q: Q, input: NewIssueVm) {
  yield* insertIssueVmSteps(q, input);
}

export type IssueVmStateChange =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "ended"; state: IssueVmState };

export function* setIssueVmStateSteps(
  q: Q,
  input: { id: string; state: IssueVmState; now: number },
) {
  const changed = yield* updateLiveIssueVmStateSteps(q, input);
  if (changed > 0) return { ok: true } satisfies IssueVmStateChange;
  const current = yield* issueVmByIdSteps(q, input.id);
  if (current === null) return { ok: false, reason: "missing" } satisfies IssueVmStateChange;
  return { ok: false, reason: "ended", state: current.state } satisfies IssueVmStateChange;
}
