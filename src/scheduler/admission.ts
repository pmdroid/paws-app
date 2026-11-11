import type { Database } from "bun:sqlite";
import { itemDelegationIdSteps, sqliteDb, type Q, type Steps } from "../db";
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
    canDispatchDelegation: (q: Q, delegationId: string) => Steps<boolean>;
    canStart: (q: Q, itemId: string) => Steps<Admission>;
    canMerge: (q: Q, itemId: string) => Steps<Admission>;
  };
};

export function createAdmission(input: {
  db: Database;
  authority?: (delegationId: string) => boolean;
  workspace?: boolean;
}): ItemAdmission {
  const store = sqliteDb(input.db);
  function* delegationHeld(q: Q, delegationId: string): Steps<HeldReason | null> {
    return input.authority?.(delegationId) === false
      ? "project"
      : yield* delegationReadinessSteps(q, delegationId);
  }
  function* decide(q: Q, itemId: string, phase: ReadinessPhase): Steps<Admission> {
    const delegationId = yield* itemDelegationIdSteps(q, itemId);
    const held =
      delegationId === null
        ? "missing"
        : ((yield* delegationHeld(q, delegationId)) ??
          (yield* itemReadinessSteps(q, itemId, phase)));
    return held === null ? { ok: true } : { ok: false, held };
  }
  function* canDispatchDelegation(q: Q, delegationId: string): Steps<boolean> {
    return (yield* delegationHeld(q, delegationId)) === null;
  }
  function* canMerge(q: Q, itemId: string): Steps<Admission> {
    return yield* decide(q, itemId, "merge");
  }
  function* canStart(q: Q, itemId: string): Steps<Admission> {
    return input.workspace === false
      ? { ok: false, held: "workspace" }
      : yield* decide(q, itemId, "start");
  }
  return {
    canDispatchDelegation: (delegationId) =>
      store.run((q) => canDispatchDelegation(q, delegationId)),
    canStart: (itemId) => store.run((q) => canStart(q, itemId)),
    canMerge: (itemId) => store.run((q) => canMerge(q, itemId)),
    steps: { canDispatchDelegation, canStart, canMerge },
  };
}
