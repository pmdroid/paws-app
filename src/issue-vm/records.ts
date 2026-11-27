import {
  closeIssueVmAwakeSteps,
  insertIssueVmSteps,
  issueVmByIdSteps,
  openIssueVmAwakeSteps,
  runnerStandingSteps,
  updateLiveIssueVmStateSteps,
  updateRunnerStatusSteps,
  type IssueVm,
  type IssueVmState,
  type NewIssueVm,
  type Q,
} from "../db";
import { issueVmSpendLimitSteps, priced } from "./spend";

export function* recordIssueVmSteps(q: Q, input: NewIssueVm) {
  return yield* insertIssueVmSteps(q, input);
}

export type IssueVmStateChange =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "ended"; state: IssueVmState };

const CLOSES_AWAKE: IssueVmState[] = ["asleep", "deleted", "failed"];

export function* followIssueVmSpendSteps(q: Q, id: string, state: IssueVmState, now: number) {
  if (state === "awake") yield* openAwakeSteps(q, id, now);
  if (CLOSES_AWAKE.includes(state)) yield* closeIssueVmAwakeSteps(q, { issueVmId: id, now });
}

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
    yield* followIssueVmSpendSteps(q, input.id, input.state, input.now);
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

export function* revokeIssueVmRunnerSteps(q: Q, vm: IssueVm, now: number) {
  if (vm.runnerId === null) return;
  const standing = yield* runnerStandingSteps(q, vm.runnerId);
  if (standing === null || standing.revokedAt !== null) return;
  yield* updateRunnerStatusSteps(q, {
    runnerId: vm.runnerId,
    workspaceId: vm.workspaceId,
    userId: vm.memberUserId,
    status: "revoked",
    now,
  });
}
