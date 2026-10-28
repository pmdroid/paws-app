import type { CiResult } from "../closeout";
import type { PassedCheck, PullCi } from "../github";
import type { FailedCiCheck } from "../merge";

/** How often a merge-queue re-check reads CI again while it waits, and for how long at most. */
export const CI_RECHECK_POLL_MS = 15_000;
export const CI_RECHECK_WAIT_MS = 45 * 60_000;

/** A Closeout command check and the CI check names that run the same command (`ci:`). */
export type CiMapping = { id: string; ci: string };

/**
 * What a merge-queue re-check of a head does about CI. `check` runs Closeout with `fromCi`
 * taken from green CI (empty when nothing maps or CI could not tell). `ci-failed` sends the
 * item to a CI fix round instead of running the checks.
 */
export type CiRecheck =
  | { kind: "check"; fromCi: CiResult[] }
  | { kind: "ci-failed"; checks: FailedCiCheck[] };

/**
 * Reads CI on the pull request's head for a merge-queue re-check. Green CI gives each mapped
 * check its result; pending CI is waited for, up to `maxWaitMs`; failed CI goes to the CI fix.
 * When GitHub cannot say, or the head is not the pull request's, the checks run as before.
 */
export async function ciForRecheck(input: {
  mappings: readonly CiMapping[];
  read: () => Promise<PullCi>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs?: number;
  maxWaitMs?: number;
  /** Called with each new reason the re-check is waiting. */
  onWait?: (message: string) => void;
}): Promise<CiRecheck> {
  if (input.mappings.length === 0) return { kind: "check", fromCi: [] };
  const deadline = input.now() + (input.maxWaitMs ?? CI_RECHECK_WAIT_MS);
  let previous = "";
  for (;;) {
    const ci = await input.read();
    if (ci.state === "green")
      return { kind: "check", fromCi: fromGreenCi(input.mappings, ci.checks) };
    if (ci.state === "failed") return { kind: "ci-failed", checks: ci.failedChecks };
    if (ci.state === "unknown" || input.now() >= deadline) return { kind: "check", fromCi: [] };
    if (ci.message !== previous) input.onWait?.(ci.message);
    previous = ci.message;
    await input.sleep(input.pollMs ?? CI_RECHECK_POLL_MS);
  }
}

/**
 * The mapped checks green CI covers. A mapping takes CI's result when at least one check
 * matches its pattern and every match succeeded; a skipped or neutral match runs the check.
 */
export function fromGreenCi(
  mappings: readonly CiMapping[],
  checks: readonly PassedCheck[],
): CiResult[] {
  return mappings.flatMap((mapping) => {
    const pattern = ciPattern(mapping.ci);
    const matched = checks.filter((check) => pattern.test(check.name));
    if (matched.length === 0 || matched.some((check) => check.conclusion !== "SUCCESS")) return [];
    return [
      {
        id: mapping.id,
        run: runUrl(matched.find((check) => check.url !== null)?.url ?? null),
        checks: matched.map((check) => ({
          name: check.name,
          conclusion: check.conclusion.toLowerCase(),
          url: check.url,
        })),
      },
    ];
  });
}

/** A `ci:` value as a whole-name match, where `*` is any text. */
export function ciPattern(ci: string): RegExp {
  const escaped = ci
    .trim()
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** The Actions workflow run of a job's page, or the page itself. */
function runUrl(url: string | null): string | null {
  if (url === null) return null;
  const run = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+)(?:\/job\/\d+.*)?$/.exec(
    url,
  );
  return run?.[1] ?? url;
}
