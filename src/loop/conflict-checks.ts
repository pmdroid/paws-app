import type { CarriedPass, CiResult, RerunPolicy, TurnPass } from "../closeout";
import {
  getCandidateRiskSteps,
  getCloseoutProgressSteps,
  getTaskMergeSettingsSteps,
  getWorkItemSteps,
  listRebaseReturnsSteps,
  openFixRecordsSteps,
  type Db,
} from "../db";

export type ConflictChecks = {
  head: string;
  policyDigest: string;
  run: string[];
  carried: string[];
  reviews: string[];
};

export async function conflictChecksFor(
  store: Db,
  input: {
    itemId: string;
    reason: string | undefined;
    policy: { digest: string; rerun?: RerunPolicy } | null;
    briefs: boolean;
  },
): Promise<ConflictChecks | undefined> {
  const policy = input.policy;
  const run = policy?.rerun?.conflict?.run ?? [];
  if (!policy || run.length === 0 || input.reason !== "conflict" || input.briefs) return undefined;
  try {
    return await store.run(function* (q) {
      const item = yield* getWorkItemSteps(q, input.itemId);
      const records = yield* openFixRecordsSteps(q, input.itemId);
      const record = records[0];
      if (!item?.acceptedHead || records.length !== 1 || record?.reason !== "conflict") return;
      const { base, ...others } = record.triggers;
      if (!base || Object.values(others).some((value) => !Array.isArray(value) || value.length > 0))
        return;
      const returned = (yield* listRebaseReturnsSteps(q, item.id, 0)).at(-1);
      if (returned?.reason !== "merge" && returned?.reason !== "github_queue") return;
      if (record.headBefore !== item.acceptedHead) return;
      const accepted = yield* getCloseoutProgressSteps(q, item.id, item.acceptedHead);
      if (accepted?.decision !== "accepted" || accepted.finishedAt === null) return;
      if (accepted.policyDigest !== policy.digest) return;
      const risk = yield* getCandidateRiskSteps(q, item.id, item.acceptedHead);
      if (!risk || risk.tier === "high") return;
      const kept = yield* getTaskMergeSettingsSteps(q, item.id);
      if (!kept || kept.mainMoved === "closeout") return;
      const ids = new Set(accepted.steps.map((step) => step.id));
      if (!run.every((id) => ids.has(id))) return;
      const carried = accepted.steps
        .filter((step) => step.kind === "command" && step.state === "passed")
        .map((step) => step.id)
        .filter((id) => !run.includes(id));
      if (carried.length === 0) return;
      const reviews =
        policy.rerun?.conflict?.reviews === false
          ? accepted.steps
              .filter((step) => step.kind === "review" && step.state === "passed")
              .map((step) => step.id)
          : [];
      return { head: accepted.head, policyDigest: accepted.policyDigest, run, carried, reviews };
    });
  } catch {
    return undefined;
  }
}

export function conflictCarried(
  conflict: ConflictChecks,
  input: {
    head: string;
    fromCi: readonly CiResult[];
    fromTurn: readonly TurnPass[];
    paths: readonly string[] | null;
    acceptedPaths: readonly string[] | null;
  },
): CarriedPass[] | undefined {
  const passes = input.fromTurn.filter((pass) => pass.head === input.head);
  if (
    input.fromCi.length === 0 ||
    passes.length === 0 ||
    passes.some((pass) => pass.policyDigest !== conflict.policyDigest) ||
    input.paths === null ||
    input.acceptedPaths === null ||
    input.paths.some((path) => !input.acceptedPaths!.includes(path))
  )
    return undefined;
  return [...conflict.carried, ...conflict.reviews].map((id) => ({ id, head: conflict.head }));
}
