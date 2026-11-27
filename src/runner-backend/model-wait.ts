import { RunnerCapacityWait } from "../core";

export const NO_FREE_CAPACITY = ": no free capacity";
const ACCOUNT_CONCURRENCY_LIMIT = ": account at its concurrency limit";

export function busyRunners(rejected: readonly string[]): string[] {
  return [
    ...new Set(
      rejected
        .filter(
          (reason) =>
            reason.includes(NO_FREE_CAPACITY) || reason.endsWith(ACCOUNT_CONCURRENCY_LIMIT),
        )
        .map((reason) => reason.slice(0, reason.indexOf(":"))),
    ),
  ];
}

export function modelMissWait(
  rejected: readonly string[],
  offered: readonly string[],
  detail: string,
): RunnerCapacityWait {
  const waitFor = [...new Set([...busyRunners(rejected), ...offered])];
  return waitFor.length
    ? new RunnerCapacityWait(waitFor)
    : new RunnerCapacityWait([], undefined, [detail], true);
}
