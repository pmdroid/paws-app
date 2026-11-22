import {
  coversAnyPath,
  type CarriedPass,
  type RerunCommand,
  type RerunPolicy,
  type SinceRun,
  type TurnPass,
} from "../closeout";
import {
  getCloseoutProgressSteps,
  getPullCiFailureSteps,
  openFixRecordsSteps,
  type Db,
} from "../db";
import { ciPattern } from "./ci-recheck";

export type CiSince = SinceRun & { policyDigest: string };

export type CiChecks = {
  head: string;
  policyDigest: string;
  failed: string[];
  since: string[];
  passed: string[];
};

export async function ciChecksFor(
  store: Db,
  input: {
    itemId: string;
    reason: string | undefined;
    policy: { digest: string; rerun?: RerunPolicy; commands: readonly RerunCommand[] } | null;
  },
): Promise<CiChecks | undefined> {
  const policy = input.policy;
  if (!policy || input.reason !== "ci" || policy.rerun?.ci?.run !== "failed") return undefined;
  try {
    return await store.run(function* (q) {
      const record = (yield* openFixRecordsSteps(q, input.itemId)).find(
        (entry) => entry.reason === "ci",
      );
      const head = record?.headBefore;
      if (!head) return;
      const failure = yield* getPullCiFailureSteps(q, input.itemId, head);
      if (!failure || failure.failedChecks.length === 0) return;
      const accepted = yield* getCloseoutProgressSteps(q, input.itemId, head);
      if (accepted?.decision !== "accepted" || accepted.finishedAt === null) return;
      if (accepted.policyDigest !== policy.digest) return;
      const run = new Set<string>();
      for (const check of failure.failedChecks) {
        const matched = policy.commands.filter(
          (command) => command.ci !== undefined && ciPattern(command.ci).test(check.name),
        );
        if (matched.length === 0) return;
        for (const command of matched) run.add(command.id);
      }
      const passed = accepted.steps
        .filter((step) => step.kind === "command" && step.state === "passed")
        .map((step) => step.id)
        .filter((id) => !run.has(id));
      return {
        head,
        policyDigest: accepted.policyDigest,
        failed: failure.failedChecks.map((check) => check.name),
        since: policy.commands
          .filter((command) => run.has(command.id) && command.since)
          .map((command) => command.id),
        passed,
      };
    });
  } catch {
    return undefined;
  }
}

export function ciCarried(
  ci: CiChecks,
  input: {
    head: string;
    commands: readonly RerunCommand[];
    fromTurn: readonly TurnPass[];
    changed: readonly string[] | null;
  },
): CarriedPass[] | undefined {
  const passes = input.fromTurn.filter((pass) => pass.head === input.head);
  if (
    input.changed === null ||
    passes.length === 0 ||
    passes.some((pass) => pass.policyDigest !== ci.policyDigest)
  )
    return undefined;
  return ci.passed
    .filter((id) => {
      const command = input.commands.find((entry) => entry.id === id);
      return command !== undefined && !coversAnyPath(command, input.changed!);
    })
    .map((id) => ({ id, head: ci.head }));
}
