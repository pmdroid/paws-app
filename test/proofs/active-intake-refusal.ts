import type { Db } from "../../src/db";
import { intakeDelegatedIssue } from "../../src/intake";
import {
  createFakeTracker,
  createInboxStore,
  createLinearIntake,
  INTAKE_RETRY_MS,
  type AcceptedLinearEvent,
} from "../../src/linear";
import { seed } from "../dialects";
import { tempStore } from "../pglite";
import type { Proof } from "./harness";

const items = async (db: Db) =>
  (await db.run((q) => q.all(q.orm.select().from(q.t.workItem)))).length;

export default {
  covers: ["src/intake/intake.ts", "src/linear/acknowledge.ts", "src/linear/intake-queue.ts"],
  summary:
    "Active-attempt refusals settle after explanation; failed explanations retry while independent sessions progress.",
  agent: () => [],
  async run(proof) {
    for (const failTransport of [false, true]) {
      const { db, close } = await tempStore();
      const tracker = createFakeTracker([
        {
          linearIssueId: "issue",
          identifier: "ACME-1",
          title: "Existing work",
          description: null,
          subIssues: [],
        },
      ]);
      await intakeDelegatedIssue(db, tracker, {
        linearIssueId: "issue",
        sessionId: "original",
        taskKey: "original",
      });
      let now = Date.now();
      let failed = false;
      const post = tracker.postProgress.bind(tracker);
      tracker.postProgress = async (update, options) => {
        if (failTransport && !failed && update.body.includes("unfinished attempt")) {
          failed = true;
          throw new Error("explanation transport unavailable");
        }
        return post(update, options);
      };
      const event = (
        key: string,
        sessionId: string,
        action: "created" | "prompted",
      ): AcceptedLinearEvent => ({
        dedupeKey: key,
        deliveryId: key,
        source: "webhook",
        action,
        sessionId,
        issueId: "issue",
        activityId: action === "prompted" ? key : null,
        body: action === "prompted" ? "new input" : null,
        signal: null,
        updatedAtMs: now,
        payload: "{}",
      });
      const refused = event("refused", "new", "created");
      const later = event("later", "new", "prompted");
      const independent = event("independent", "other", "prompted");
      const store = createInboxStore(db);
      const delivered: string[] = [];
      const intake = createLinearIntake({
        store,
        tracker,
        signal: new AbortController().signal,
        now: () => now,
        log: () => {},
        followUp: async (input) => {
          if (input.dedupeKey === "refused") {
            await intakeDelegatedIssue(db, tracker, {
              linearIssueId: "issue",
              sessionId: "new",
              taskKey: "refused",
            });
          } else delivered.push(input.dedupeKey);
        },
      });
      try {
        for (const input of [refused, later, independent]) await store.commit(input);
        intake.queue.wake();
        await intake.queue.idle();
        const pending = async () => (await store.listUnhandled()).map((input) => input.dedupeKey);
        proof.expect(
          `independent session progresses (transport failure: ${failTransport})`,
          delivered.includes("independent"),
          delivered,
        );
        if (failTransport) {
          proof.expect(
            "failed explanation retains refusal and blocks its later event",
            (await pending()).includes("refused") &&
              (await pending()).includes("later") &&
              !delivered.includes("later"),
            await pending(),
          );
          now += INTAKE_RETRY_MS[0];
          intake.queue.wake();
          await intake.queue.idle();
        }
        proof.expect(
          "refusal and next same-session event settle",
          (await pending()).length === 0 && delivered.includes("later"),
          { pending: await pending(), delivered },
        );
        proof.expect(
          "one conflict explanation is delivered",
          tracker.progress.filter((update) => update.body.includes("unfinished attempt")).length ===
            1,
          tracker.progress,
        );
        proof.expect("no second item exists", (await items(db)) === 1);
        await seed(db, (q) => q.orm.update(q.t.workItem).set({ state: "cancelled" }));
        now += 1_000_000;
        intake.queue.wake();
        await intake.queue.idle();
        proof.expect(
          "settled delegation never starts when original work ends",
          (await items(db)) === 1,
        );
        await intakeDelegatedIssue(db, tracker, {
          linearIssueId: "issue",
          sessionId: "new",
          taskKey: "fresh-input",
        });
        proof.expect("new input can start after original work ends", (await items(db)) === 2);
      } finally {
        await intake.queue.stop();
        await intake.onEvent.close();
        await close();
      }
    }
  },
} satisfies Proof;
