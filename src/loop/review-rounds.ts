import {
  emitJobReady,
  getWorkItemSteps,
  saveCheckpointSteps,
  saveCloseoutRecoverySteps,
  type LinkAskRounds,
  type WorkItemRecord,
  type Db,
} from "../db";
import { reviewRoundsDetail, type StoredQuestion } from "../questions";
import type { CloseoutHelp } from "./closeout-help";
import { askWithLinkSteps } from "./link-ask";

/** The rounds a Keep going grants, read from the exhausted check: "4 of 4 allowed failed review attempts used." */
export function reviewRoundLimit(detail: string | null | undefined): number | null {
  const match = /of (\d+) allowed failed review attempts/.exec(detail ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Review attempts ran out: ask the delegator or the project lead on the item
 * page whether to rethink the approach, keep going, or stop. The recovery row
 * keeps the retry baseline, so Rethink and Keep going start a new round budget.
 */
export async function askReviewRounds(
  store: Db,
  input: {
    item: WorkItemRecord;
    help: CloseoutHelp;
    rounds: LinkAskRounds;
    findings?: string;
    publicUrl: string | null;
    now: number;
  },
): Promise<StoredQuestion | null> {
  const asked = await store.transaction(function* (q) {
    const item = yield* getWorkItemSteps(q, input.item.id);
    if (item === null || item.state === "cancelled") return null;
    const { question } = yield* askWithLinkSteps(q, {
      item,
      runId: item.currentRunId,
      kind: "rounds",
      head: input.help.head,
      detail: reviewRoundsDetail(input.rounds),
      ...(input.findings ? { findings: input.findings } : {}),
      rounds: input.rounds,
      publicUrl: input.publicUrl,
      now: input.now,
    });
    yield* saveCloseoutRecoverySteps(q, { ...input.help, questionId: question.id });
    yield* saveCheckpointSteps(q, item.id, {
      phase: "awaiting_input",
      baseSha: input.help.base,
      wipCommit: input.help.head,
    });
    return question;
  });
  if (asked !== null) emitJobReady(store);
  return asked;
}
