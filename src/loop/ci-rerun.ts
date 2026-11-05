import type { Database } from "bun:sqlite";
import { hasCiRerun, recordCiRerun } from "../db";
import { CI_ALREADY_RERUN, rerunFailedCi, type CiRerunInput } from "../github";

export async function rerunItemCi(options: {
  db: Database;
  itemId: string;
  label: string;
  reason: string;
  github: Omit<CiRerunInput, "alreadyRerun">;
  now: () => number;
  journal?: ((line: string) => void) | undefined;
  requestedBy?: string;
}): Promise<string> {
  const result = await rerunFailedCi({
    ...options.github,
    alreadyRerun: (head) => hasCiRerun(options.db, options.itemId, head),
  });
  if (!result.rerun) return result.answer;
  const recorded = recordCiRerun(options.db, {
    itemId: options.itemId,
    head: result.rerun.head,
    runIds: result.rerun.runIds,
    reason: options.reason,
    at: options.now(),
  });
  if (!recorded) return CI_ALREADY_RERUN;
  options.journal?.(
    `item ${options.label} CI re-run requested by ${options.requestedBy ?? "the agent"} on ${result.rerun.head.slice(0, 7)}, workflow run ${result.rerun.runIds.join(", ")}: ${JSON.stringify(options.reason)}`,
  );
  return result.answer;
}
