import { journal } from "./db";

/** Cleanup groups keep the total async wait below systemd's stop deadline. */
const STOP_WAIT_MS = 5_000;

type StopStage = { name: string; stop: () => unknown };
type StopFailure = { stage: string; error: unknown };

export class PawsStopError extends Error {
  constructor(
    readonly failures: readonly StopFailure[],
    readonly stateFlushed: boolean,
  ) {
    super("Paws shutdown encountered cleanup failures", { cause: failures[0]?.error });
    this.name = "PawsStopError";
  }
}

/** Attempt every cleanup, including the durable state flush, even after a failure. */
export async function stopPawsComponents(input: {
  groups: readonly (readonly StopStage[])[];
  flush: () => void;
  close: () => void;
  waitMs?: number;
}): Promise<void> {
  const failures: StopFailure[] = [];
  const waitMs = input.waitMs ?? STOP_WAIT_MS;
  const stop = async (stage: StopStage) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(stage.stop),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`did not stop within ${waitMs}ms`)), waitMs);
        }),
      ]);
    } catch (error) {
      failures.push({ stage: stage.name, error });
    } finally {
      clearTimeout(timer);
    }
  };
  for (const group of input.groups) await Promise.all(group.map(stop));
  let stateFlushed = false;
  try {
    input.flush();
    stateFlushed = true;
  } catch (error) {
    failures.push({ stage: "state flush", error });
  }
  try {
    input.close();
  } catch (error) {
    stateFlushed = false;
    failures.push({ stage: "database close", error });
  }
  if (failures.length > 0) throw new PawsStopError(failures, stateFlushed);
}

/** Shared by signal shutdown and startup failure so stop rejections reach the journal. */
export async function shutdownPaws(
  paws: { stop: () => Promise<void> },
  requestedCode = 0,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  let code = requestedCode;
  try {
    await paws.stop();
  } catch (error) {
    const failures = error instanceof PawsStopError ? error.failures : [{ stage: "stop", error }];
    for (const failure of failures) {
      const message = String(failure.error);
      const stack = failure.error instanceof Error ? failure.error.stack : undefined;
      const detail = stack?.startsWith(message)
        ? stack
        : [message, stack].filter(Boolean).join("\n");
      journal(`Paws shutdown failed at ${failure.stage}: ${detail}`);
    }
    if (!(error instanceof PawsStopError && error.stateFlushed)) code = 1;
  }
  exit(code);
}
