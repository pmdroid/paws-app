import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutRecovery,
  type LinkAskRounds,
  type WorkItemRecord,
} from "../db";
import { reviewRoundsDetail, type StoredQuestion } from "../questions";
import type { CloseoutHelp } from "./closeout-help";
import { askWithLink } from "./link-ask";

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
export function askReviewRounds(
  db: Database,
  input: {
    item: WorkItemRecord;
    help: CloseoutHelp;
    rounds: LinkAskRounds;
    publicUrl: string | null;
    now: number;
  },
): StoredQuestion | null {
  return immediate(db, () => {
    const item = getWorkItem(db, input.item.id);
    if (item === null || item.state === "cancelled") return null;
    const { question } = askWithLink(db, {
      item,
      runId: item.currentRunId,
      kind: "rounds",
      head: input.help.head,
      detail: reviewRoundsDetail(input.rounds),
      rounds: input.rounds,
      publicUrl: input.publicUrl,
      now: input.now,
    });
    saveCloseoutRecovery(db, { ...input.help, questionId: question.id });
    saveCheckpoint(db, item.id, {
      phase: "awaiting_input",
      baseSha: input.help.base,
      wipCommit: input.help.head,
    });
    return question;
  });
}
