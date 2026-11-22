import type { CloseoutFocus } from "../closeout";
import { getCloseoutProgressSteps, latestCloseoutIdentitySteps, type Db } from "../db";
import type { CiChecks } from "./ci-checks";
import type { ConflictChecks } from "./conflict-checks";

export async function closeoutFocus(
  store: Db,
  itemId: string,
  reason: string | undefined,
  conflict?: ConflictChecks,
  ci?: CiChecks,
): Promise<CloseoutFocus | undefined> {
  if (conflict)
    return {
      scope: "failed",
      head: conflict.head,
      policyDigest: conflict.policyDigest,
      passed: conflict.carried,
    };
  if (ci)
    return {
      scope: "changed",
      head: ci.head,
      policyDigest: ci.policyDigest,
      passed: ci.passed,
      ...(ci.since.length > 0 ? { since: ci.since } : {}),
    };
  if (reason !== "findings" && reason !== "review") return undefined;
  const run = await store.run(function* (q) {
    const latest = yield* latestCloseoutIdentitySteps(q, itemId);
    return latest && (yield* getCloseoutProgressSteps(q, itemId, latest.head));
  });
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
