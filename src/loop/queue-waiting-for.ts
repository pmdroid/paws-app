import { RUNNER_FULL, type ItemRunnerVerdicts, type QueueWaitingFor } from "../db";

export function queueWaitingFor(
  verdicts: ItemRunnerVerdicts | null,
  open: boolean,
  slots: string,
): QueueWaitingFor {
  if (open) return { kind: "slots", text: slots };
  if (!verdicts) return { kind: "runner", text: "Waiting for placement scope to become available" };
  const subject = verdicts.repository ?? "this item";
  if (!verdicts.runners.length)
    return {
      kind: "runner",
      text: `No runner can take ${subject}: no paired runners available to its owner`,
    };
  if (
    verdicts.runners.some((runner) => runner.rejection === null || runner.rejection === RUNNER_FULL)
  )
    return { kind: "slots", text: slots };
  const cooling = verdicts.runners
    .flatMap((runner) => (runner.cooldown ? [runner.cooldown] : []))
    .sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity))[0];
  if (cooling)
    return {
      kind: "quota",
      text: `Waiting for an agent account's quota: ${cooling.account} ${
        cooling.until === null
          ? "reset time unknown"
          : `resets at ${new Date(cooling.until).toISOString().slice(0, 16).replace("T", " ")} UTC`
      }`,
      ...(cooling.until === null ? {} : { until: cooling.until }),
    };
  return {
    kind: "runner",
    text: `No runner can take ${subject}: ${verdicts.runners
      .map((runner) => `${runner.name}: ${runner.rejection}`)
      .join("; ")}`,
  };
}
