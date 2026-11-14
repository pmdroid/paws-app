export async function waitFor(
  ready: () => boolean | Promise<boolean>,
  options: { timeout?: number; what?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 5_000);
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "it"}`);
    await Bun.sleep(5);
  }
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function requestTracker(quietTurns = 20) {
  let inFlight = 0;
  return {
    async track<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
    async held<T>(gate: Promise<T>): Promise<T> {
      inFlight -= 1;
      try {
        return await gate;
      } finally {
        inFlight += 1;
      }
    },
    async idle(timeout = 10_000): Promise<void> {
      const deadline = Date.now() + timeout;
      for (let calm = 0; calm < quietTurns;) {
        await turn();
        if (inFlight === 0) {
          calm += 1;
          continue;
        }
        calm = 0;
        if (Date.now() > deadline) throw new Error(`${inFlight} dashboard requests still running`);
        await Bun.sleep(1);
      }
    },
  };
}
