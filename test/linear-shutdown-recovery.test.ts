import { expect, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listOutbox, migrate, openDatabase } from "../src/db";
import { attachOrchestrator } from "../src/loop";
import {
  createFakeTracker,
  createInboxStore,
  openLinear,
  type AcceptedLinearEvent,
} from "../src/linear";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

for (const shutdown of ["application", "linear"] as const) {
  test.each(["throw", "false", "return"])(
    `${shutdown} shutdown preserves interrupted %s intake for recovery`,
    async (outcome) => {
      const home = tempHome();
      const path = join(home, "paws.db");
      let db = openDatabase(path);
      migrate(db);
      const event: AcceptedLinearEvent = {
        dedupeKey: "session:session:created",
        deliveryId: null,
        source: "poll",
        action: "created",
        sessionId: "session",
        issueId: "issue",
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: 1,
        payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
      };
      const tracker = createFakeTracker([
        {
          linearIssueId: "issue",
          identifier: "PAS-372",
          title: "Recover",
          description: null,
          subIssues: [],
        },
      ]);
      let jobs = new JobLoop(db, systemClock);
      const makeOrchestrator = () =>
        attachOrchestrator({
          db,
          admission: workspaceAdmission(db),
          tracker,
          pawsRoot: home,
          jobs,
          repositories: ["one", "two"].map((repo) => ({
            owner: "fixture",
            repo,
            remoteUrl: `/unused/${repo}`,
          })),
          launch: () => {
            throw new Error("Repository selection must ask before launching");
          },
          outbox: new OutboxDispatcher(db, systemClock),
        });
      let orchestrator = makeOrchestrator();
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const linear = openLinear({
        db,
        secretsDir: join(home, "secrets"),
        env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
        publicUrl: null,
        signal: controller.signal,
        isAuthorized: () => false,
        fetch: async () => {
          throw new Error("unexpected provider request");
        },
        progressReporter: (accepted) => orchestrator.sessionProgressReporter(accepted),
        followUp: async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "throw") throw new Error("The operation was aborted");
          if (outcome === "false") return false;
        },
      });
      const running = linear.start(0);
      let store = createInboxStore(db);
      store.commit(event);
      const delivery = Promise.resolve(linear.webhook.onEvent!(event)).then(() =>
        store.markHandled(event.dedupeKey),
      );
      const rejected = delivery.then(
        () => null,
        (error: unknown) => error,
      );
      await entered.promise;
      if (shutdown === "application") controller.abort();
      const stopping = shutdown === "linear" ? running.stop() : undefined;
      release.resolve();
      expect(await rejected).toBeInstanceOf(Error);
      await stopping;
      await running.stop();
      await orchestrator.shutdown();
      expect(store.listUnhandled()).toHaveLength(1);
      expect(tracker.progress).toEqual([]);
      expect(
        listOutbox(db).filter(
          (entry) =>
            entry.status === "pending" &&
            (entry.payload as { body?: string }).body === "Picked up this issue.",
        ),
      ).toHaveLength(1);
      expect(
        listOutbox(db).some((entry) => (entry.payload as { kind?: string }).kind === "error"),
      ).toBe(false);
      db.close();
      db = openDatabase(path);
      store = createInboxStore(db);
      jobs = new JobLoop(db, systemClock);
      orchestrator = makeOrchestrator();
      const recovered = openLinear({
        db,
        secretsDir: join(home, "secrets"),
        env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
        publicUrl: null,
        isAuthorized: () => false,
        fetch: async () => {
          throw new Error("unexpected provider request");
        },
        progressReporter: (accepted) => orchestrator.sessionProgressReporter(accepted),
        followUp: (accepted) => orchestrator.onLinearEvent(accepted),
      });
      try {
        await recovered.webhook.onEvent!(store.listUnhandled()[0]!);
        store.markHandled(event.dedupeKey);
        await recovered.webhook.onEvent!(event);
        await jobs.tick();
        await jobs.tick();
        expect(tracker.questions).toHaveLength(1);
        expect(tracker.questions[0]?.body).toContain("Which repository");
        expect(store.listUnhandled()).toHaveLength(0);
        expect(db.query("SELECT id FROM work_item").all()).toHaveLength(1);
        expect(
          tracker.progress.filter((update) => update.body.startsWith("Picked up")),
        ).toHaveLength(1);
        expect(listOutbox(db).filter((entry) => entry.status === "dropped")).toHaveLength(0);
      } finally {
        await recovered.start(0).stop();
        await orchestrator.shutdown();
        db.close();
      }
    },
  );
}
