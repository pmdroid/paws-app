import { listWorkItems } from "../../src/db";
import { intakeDelegatedIssue } from "../../src/intake";
import {
  acknowledgeNewSession,
  createFakeTracker,
  createInboxStore,
  startCatchUpPoller,
} from "../../src/linear";
import { tempStore } from "../pglite";
import type { Proof } from "./harness";

export default {
  covers: ["src/linear/poller.ts", "src/linear/catchup.ts"],
  summary:
    "A delegation whose webhook never arrives and whose Linear session goes stale gets its work item from the next catch-up poll.",
  agent: () => [],
  async run(proof) {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ACME-1",
        title: "Task",
        description: null,
        subIssues: [],
      },
    ]);
    const now = Date.now();
    const poller = startCatchUpPoller({
      source: {
        poll: async () => ({
          sessions: [
            {
              id: "session",
              issueId: "issue",
              createdAtMs: now - 120_000,
              updatedAtMs: now - 60_000,
              endedAtMs: now - 60_000,
              stoppedAtMs: null,
              stale: true,
            },
          ],
          issues: [],
          comments: [],
          activities: [],
          budget: null,
          caughtUp: true,
          queried: true,
        }),
      },
      store: createInboxStore(db),
      db,
      timer: false,
      onEvent: (event) =>
        acknowledgeNewSession(tracker, event, async (accepted) => {
          await intakeDelegatedIssue(db, tracker, {
            linearIssueId: "issue",
            sessionId: accepted.sessionId,
          });
        }),
    });
    try {
      proof.expect(
        "no work item exists before catch-up",
        (await listWorkItems(db)).length === 0,
        0,
      );
      await poller.pollNow();
      const items = await listWorkItems(db);
      proof.expect(
        "catch-up creates the work item for the stale session",
        items.length === 1 && items[0]!.sessionKey === "session",
        items.map((item) => `${item.id} ${item.sessionKey}`),
      );
      await poller.pollNow();
      const again = (await listWorkItems(db)).length;
      proof.expect("a second catch-up does not duplicate it", again === 1, again);
    } finally {
      await poller.stop();
      await close();
    }
  },
} satisfies Proof;
