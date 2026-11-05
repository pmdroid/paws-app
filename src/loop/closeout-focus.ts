import type { Database } from "bun:sqlite";
import type { CloseoutFocus } from "../closeout";
import { getCloseoutProgress, latestCloseoutIdentity } from "../db";

export function closeoutFocus(
  db: Database,
  itemId: string,
  reason: string | undefined,
): CloseoutFocus | undefined {
  if (reason !== "findings" && reason !== "review") return undefined;
  const latest = latestCloseoutIdentity(db, itemId);
  const run = latest && getCloseoutProgress(db, itemId, latest.head);
  if (!run) return undefined;
  const passed = run.steps
    .filter((step) => step.kind !== "review" && step.state === "passed")
    .map((step) => step.id);
  if (passed.length === 0) return undefined;
  return {
    scope: reason === "findings" ? "failed" : "changed",
    head: run.head,
    policyDigest: run.policyDigest,
    passed,
  };
}
