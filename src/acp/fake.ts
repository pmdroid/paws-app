import type { AcpRunner, AcpUpdate, StartAcpRun } from "./runner";

export type FakeAcpRunner = AcpRunner & {
  starts: StartAcpRun[];
  cancels: string[];
  updates: AcpUpdate[];
};

export function createFakeAcpRunner(): FakeAcpRunner {
  const starts: StartAcpRun[] = [];
  const cancels: string[] = [];
  const updates: AcpUpdate[] = [];
  let next = 1;
  return {
    starts,
    cancels,
    updates,
    async start(input) {
      starts.push(input);
      const sessionId = `fake-acp-${next}`;
      next += 1;
      const update: AcpUpdate = { sessionId, kind: "message", summary: "fake end" };
      updates.push(update);
      input.onUpdate?.(update);
      return { sessionId };
    },
    async cancel(sessionId) {
      cancels.push(sessionId);
    },
  };
}
