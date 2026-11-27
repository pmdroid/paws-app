import { COAUTHOR_REJECTION } from "../core";

const ATTRIBUTION_HANDOFF = "Paws could not publish your last turn because a commit's attribution";

export function attributionReturnHandoff(
  errorMessage: string | undefined,
  handoff: string | undefined,
): string | null {
  const at = errorMessage?.indexOf(COAUTHOR_REJECTION) ?? -1;
  if (at < 0 || handoff?.startsWith(ATTRIBUTION_HANDOFF)) return null;
  return `${ATTRIBUTION_HANDOFF} does not match the run's policy:\n\n${errorMessage!.slice(at)}\n\nEvery new commit must carry exactly the Co-authored-by trailers named in your instructions, and no others. Amend or recreate the commits that don't, without changing their content; if your checkout no longer has your last changes, make them again. Then run the checks again.`;
}
