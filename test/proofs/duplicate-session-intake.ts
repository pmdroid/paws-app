import { listWorkItems } from "../../src/db";
import { intakeDelegatedIssue } from "../../src/intake";
import {
  createFakeTracker,
  createInboxStore,
  createLinearIntake,
  startCatchUpPoller,
  type AcceptedLinearEvent,
} from "../../src/linear";
import { tempStore } from "../pglite";
import { waitFor } from "../wait-for";
import type { Proof } from "./harness";

export default {
  covers: ["src/linear/poller.ts", "src/linear/inbox.ts", "src/linear/intake-queue.ts"],
  summary:
    "A session delivered by webhook and found again by the catch-up poll, as an issue intake and as its first prompt, is taken in once.",
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
    const store = createInboxStore(db);
    const followUps: string[] = [];
    const { onEvent, queue } = createLinearIntake({
      store,
      tracker,
      signal: new AbortController().signal,
      pollMs: 5,
      followUp: async (event) => {
        followUps.push(event.dedupeKey);
        await intakeDelegatedIssue(db, tracker, {
          linearIssueId: "issue",
          sessionId: event.sessionId,
        });
      },
    });
    const now = Date.now();
    const webhook: AcceptedLinearEvent = {
      dedupeKey: "session:session:created",
      deliveryId: "delivery",
      source: "webhook",
      action: "created",
      sessionId: "session",
      issueId: "issue",
      activityId: "prompt",
      body: "Work on ACME-1",
      signal: null,
      updatedAtMs: now - 60_000,
      payload: JSON.stringify({
        agentSession: { id: "session", issue: { id: "issue", identifier: "ACME-1" } },
        agentActivity: { id: "prompt", content: { type: "prompt", body: "Work on ACME-1" } },
      }),
    };
    const activity = (id: string, body: string) => ({
      id,
      issueId: "issue",
      sessionId: "session",
      body,
      signal: null,
      updatedAtMs: now - 30_000,
    });
    let activities = [activity("prompt", "Work on ACME-1")];
    const poller = startCatchUpPoller({
      source: {
        poll: async () => ({
          sessions: [
            {
              id: "session",
              issueId: "issue",
              createdAtMs: now - 60_000,
              updatedAtMs: now - 30_000,
            },
          ],
          issues: [
            {
              id: "issue",
              identifier: "ACME-1",
              updatedAtMs: now - 30_000,
              labeled: false,
              delegated: true,
            },
          ],
          comments: [],
          activities,
          budget: null,
          caughtUp: true,
          queried: true,
        }),
      },
      store,
      intake: queue,
      onEvent,
      db,
      timer: false,
    });
    try {
      if ((await store.commit(webhook)).inserted) queue.arrive(webhook);
      await poller.pollNow();
      await waitFor(() => followUps.length >= 1);
      await queue.idle();
      const items = await listWorkItems(db);
      proof.expect(
        "the webhook, the poll's issue intake and the poll's first prompt start one intake",
        followUps.length === 1 && items.length === 1,
        { followUps, items: items.map((item) => item.sessionKey) },
      );
      activities = [activity("second", "Also add a test")];
      await poller.pollNow();
      await waitFor(() => followUps.length >= 2);
      await queue.idle();
      proof.expect(
        "a second, new prompt in the same session is still taken in",
        followUps.join(",") === "session:session:created,activity:second",
        followUps,
      );
    } finally {
      await poller.stop();
      await queue.stop();
      await onEvent.close();
      await close();
    }
  },
} satisfies Proof;
