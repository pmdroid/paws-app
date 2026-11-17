import { bindLinearSessionTask, getWorkItem, recordLinearInstallation } from "../../src/db";
import { intakeDelegatedIssue } from "../../src/intake";
import {
  createFakeTracker,
  createInboxStore,
  parsePolledUndelegation,
  startCatchUpPoller,
} from "../../src/linear";
import { stopUndelegatedIssue } from "../../src/loop";
import { tempStore } from "../pglite";
import type { Proof } from "./harness";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

export default {
  covers: ["src/linear/poller.ts", "src/linear/catchup.ts", "src/linear/administration.ts"],
  summary:
    "Without webhooks, the catch-up poll sees an issue whose delegate is no longer Paws and stops its queued task.",
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
    const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
    if (!task.ok) throw new Error("Unexpected issue cycle");
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1,
    });
    await bindLinearSessionTask(db, "session", task.delegation.id, { actorId: "human" });
    const itemId = task.items[0]!.id;
    let delegated = true;
    const poller = startCatchUpPoller({
      source: {
        poll: async () => ({
          sessions: [],
          issues: [
            {
              id: "issue",
              identifier: "ACME-1",
              updatedAtMs: Date.now() + 1_000,
              labeled: false,
              delegated,
              undelegated: !delegated,
              closed: null,
            },
          ],
          comments: [],
          activities: [],
          budget: null,
          caughtUp: true,
          queried: true,
        }),
      },
      store: createInboxStore(db),
      db,
      onEvent: async (event) => {
        const undelegation = parsePolledUndelegation(event, scope.appUserId, scope.organizationId);
        if (undelegation) await stopUndelegatedIssue(db, undelegation, { notify: () => {} });
        return false;
      },
      timer: false,
    });
    try {
      await poller.pollNow();
      const kept = (await getWorkItem(db, itemId))?.state;
      proof.expect("a delegated issue keeps its queued task", kept === "queued", kept);
      delegated = false;
      await poller.pollNow();
      const state = (await getWorkItem(db, itemId))?.state;
      proof.expect(
        "the poll stops the task once Paws is no longer the delegate",
        state === "cancelled",
        state,
      );
    } finally {
      await poller.stop();
      await close();
    }
  },
} satisfies Proof;
