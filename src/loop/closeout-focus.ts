import type { CloseoutFocus } from "../closeout";
import { getCloseoutProgressSteps, latestCloseoutIdentitySteps, type Db } from "../db";

export async function closeoutFocus(
  store: Db,
  itemId: string,
  reason: string | undefined,
): Promise<CloseoutFocus | undefined> {
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
