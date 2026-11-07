import type { Database } from "bun:sqlite";
import { itemDelegationId } from "../db";
import {
  delegationReadiness,
  itemReadiness,
  type ReadinessHold,
  type ReadinessPhase,
} from "../intake";

export type HeldReason = "missing" | "project" | "workspace" | ReadinessHold;
export type Admission = { ok: true } | { ok: false; held: HeldReason };
export type ItemAdmission = ReturnType<typeof createAdmission>;

export function createAdmission(input: {
  db: Database;
  authority?: (delegationId: string) => boolean;
  workspace?: boolean;
}) {
  const { db } = input;
  const delegationHeld = (delegationId: string): HeldReason | null =>
    input.authority?.(delegationId) === false ? "project" : delegationReadiness(db, delegationId);
  const decide = (itemId: string, phase: ReadinessPhase): Admission => {
    const delegationId = itemDelegationId(db, itemId);
    const held =
      delegationId === null
        ? "missing"
        : (delegationHeld(delegationId) ?? itemReadiness(db, itemId, phase));
    return held === null ? { ok: true } : { ok: false, held };
  };
  return {
    canDispatchDelegation: (delegationId: string) => delegationHeld(delegationId) === null,
    canStart: (itemId: string): Admission =>
      input.workspace === false ? { ok: false, held: "workspace" } : decide(itemId, "start"),
    canMerge: (itemId: string) => decide(itemId, "merge"),
  };
}
