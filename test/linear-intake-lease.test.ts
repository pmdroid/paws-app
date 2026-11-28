import { expect, test } from "bun:test";
import {
  INTAKE_DEADLINE_MS,
  INTAKE_LEASE_MS,
  createInboxStore,
  createIntakeQueue,
  type AcceptedLinearEvent,
} from "../src/linear";
import { tempStore } from "./pglite";
import { waitFor } from "./wait-for";

const event: AcceptedLinearEvent = {
  dedupeKey: "session:s1:created",
  deliveryId: "delivery-1",
  source: "webhook",
  action: "created",
  sessionId: "s1",
  issueId: "issue-1",
  activityId: null,
  body: null,
  signal: null,
  updatedAtMs: 1,
  payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
};

test("the intake lease outlasts twice the per-intake deadline", () => {
  expect(INTAKE_LEASE_MS).toBeGreaterThanOrEqual(2 * INTAKE_DEADLINE_MS);
});

test("a renewal that lands after the intake finished reports no lost lease", async () => {
  const { db, close } = await tempStore();
  try {
    const inbox = createInboxStore(db);
    await inbox.commit(event);
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    let waiting = 0;
    let renewals = 0;
    const store = {
      ...inbox,
      renew: async (...args: Parameters<typeof inbox.renew>) => {
        waiting += 1;
        await gate;
        renewals += 1;
        return inbox.renew(...args);
      },
    };
    const lines: string[] = [];
    const queue = createIntakeQueue({
      store,
      arrive: async () => {},
      deliver: async () => {
        await waitFor(() => waiting > 0);
      },
      leaseMs: 40,
      pollMs: 60_000,
      log: (line) => lines.push(line),
    });
    queue.wake();
    await waitFor(async () => (await inbox.listUnhandled()).length === 0);
    open();
    await waitFor(() => renewals === waiting);
    await queue.stop();
    expect(lines.filter((line) => line.includes("lost its lease"))).toEqual([]);
  } finally {
    await close();
  }
});
