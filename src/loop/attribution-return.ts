import { COAUTHOR_REJECTION } from "../core";

const ATTRIBUTION_HANDOFF = "Paws could not publish your last turn because a commit's attribution";
const SHORT_REJECTION = /^Run failed during \w+: Commit attribution rejected\.$/;

export function attributionReturnHandoff(
  errorMessage: string | undefined,
  handoff: string | undefined,
): string | null {
  if (!errorMessage || handoff?.startsWith(ATTRIBUTION_HANDOFF)) return null;
  const at = errorMessage.indexOf(COAUTHOR_REJECTION);
  const short = SHORT_REJECTION.test(errorMessage.trim());
  if (at < 0 && !short) return null;
  const detail = short
    ? "The runner did not say which commit or trailer. Check that every new commit uses the configured App bot as author and committer."
    : errorMessage.slice(at);
  return `${ATTRIBUTION_HANDOFF} does not match the run's policy:\n\n${detail}\n\nEvery new commit must carry exactly the Co-authored-by trailers named in your instructions, and no others. Amend or recreate the commits that don't, without changing their content; if your checkout no longer has your last changes, make them again. Then run the checks again.`;
}
