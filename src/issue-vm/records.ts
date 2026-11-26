import {
  closeIssueVmAwakeSteps,
  insertIssueVmSteps,
  issueVmByIdSteps,
  openIssueVmAwakeSteps,
  updateLiveIssueVmStateSteps,
  type IssueVmState,
  type NewIssueVm,
  type Q,
} from "../db";
import { issueVmSpendLimitSteps, priced } from "./spend";

export function* recordIssueVmSteps(q: Q, input: NewIssueVm) {
  yield* insertIssueVmSteps(q, input);
}

export type IssueVmStateChange =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "ended"; state: IssueVmState };

const CLOSES_AWAKE: IssueVmState[] = ["asleep", "deleted", "failed"];

function* openAwakeSteps(q: Q, id: string, now: number) {
  const vm = yield* issueVmByIdSteps(q, id);
  if (vm === null) return;
  const limit = yield* issueVmSpendLimitSteps(q, vm.workspaceId);
  const hourlyUsd = priced(vm.provider) ? limit.prices[vm.provider] : null;
  yield* openIssueVmAwakeSteps(q, { issueVmId: id, hourlyUsd, now });
}

export function* setIssueVmStateSteps(
  q: Q,
  input: { id: string; state: IssueVmState; now: number },
) {
  const changed = yield* updateLiveIssueVmStateSteps(q, input);
  if (changed > 0) {
    if (input.state === "awake") yield* openAwakeSteps(q, input.id, input.now);
    if (CLOSES_AWAKE.includes(input.state))
      yield* closeIssueVmAwakeSteps(q, { issueVmId: input.id, now: input.now });
    return { ok: true } satisfies IssueVmStateChange;
  }
  const current = yield* issueVmByIdSteps(q, input.id);
  if (current === null) return { ok: false, reason: "missing" } satisfies IssueVmStateChange;
  yield* closeIssueVmAwakeSteps(q, { issueVmId: input.id, now: input.now });
  return { ok: false, reason: "ended", state: current.state } satisfies IssueVmStateChange;
}

export function* markIssueVmAwakeSteps(q: Q, input: { id: string; now: number }) {
  return yield* setIssueVmStateSteps(q, { ...input, state: "awake" });
}

export function* markIssueVmAsleepSteps(q: Q, input: { id: string; now: number }) {
  return yield* setIssueVmStateSteps(q, { ...input, state: "asleep" });
}
