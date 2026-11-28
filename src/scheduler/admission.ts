import {
  itemDelegationIdSteps,
  readinessInputsSteps,
  type Db,
  type Q,
  type ReadinessInputs as Reads,
  type Steps,
} from "../db";
import {
  delegationReadinessSteps,
  itemReadinessSteps,
  type ReadinessHold,
  type ReadinessPhase,
} from "../intake";

export type HeldReason = "missing" | "project" | "workspace" | ReadinessHold;
export type Admission = { ok: true } | { ok: false; held: HeldReason };
export type ItemAdmission = {
  canDispatchDelegation: (delegationId: string) => Promise<boolean>;
  canStart: (itemId: string) => Promise<Admission>;
  canMerge: (itemId: string) => Promise<Admission>;
  steps: {
    canDispatchDelegation: (q: Q, delegationId: string, inputs?: Reads) => Steps<boolean>;
    canStart: (q: Q, itemId: string, inputs?: Reads) => Steps<Admission>;
    readiness?: (q: Q, itemIds: readonly string[]) => Steps<Reads>;
    canMerge: (q: Q, itemId: string) => Steps<Admission>;
  };
};

export function createAdmission(input: {
  db: Db;
  authority?: (delegationId: string) => boolean;
  workspace?: boolean;
}): ItemAdmission {
  const store = input.db;
  function* delegationHeld(q: Q, delegationId: string, inputs?: Reads): Steps<HeldReason | null> {
    return input.authority?.(delegationId) === false
      ? "project"
      : yield* delegationReadinessSteps(q, delegationId, inputs);
  }
  function* decide(q: Q, itemId: string, phase: ReadinessPhase, inputs?: Reads): Steps<Admission> {
    const delegationId =
      inputs?.items.get(itemId)?.delegationId ?? (yield* itemDelegationIdSteps(q, itemId));
    const held =
      delegationId === null
        ? "missing"
        : ((yield* delegationHeld(q, delegationId, inputs)) ??
          (yield* itemReadinessSteps(q, itemId, phase, inputs)));
    return held === null ? { ok: true } : { ok: false, held };
  }
  function* canDispatchDelegation(q: Q, delegationId: string, inputs?: Reads): Steps<boolean> {
    return (yield* delegationHeld(q, delegationId, inputs)) === null;
  }
  function* canMerge(q: Q, itemId: string): Steps<Admission> {
    return yield* decide(q, itemId, "merge");
  }
  function* canStart(q: Q, itemId: string, inputs?: Reads): Steps<Admission> {
    return input.workspace === false
      ? { ok: false, held: "workspace" }
      : yield* decide(q, itemId, "start", inputs);
  }
  return {
    canDispatchDelegation: (delegationId) =>
      store.run((q) => canDispatchDelegation(q, delegationId)),
    canStart: (itemId) => store.run((q) => canStart(q, itemId)),
    canMerge: (itemId) => store.run((q) => canMerge(q, itemId)),
    steps: { canDispatchDelegation, canStart, canMerge, readiness: readinessInputsSteps },
  };
}
