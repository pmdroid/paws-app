import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createFakeCloseoutGate } from "../src/closeout";
import { writeAgentSettings } from "../src/config";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listJobs,
  enqueueOutboxOnce,
  listSystemFaults,
  listWorkItems,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tickWithRestarts } from "./helpers";
import { repoLayout, writeOk } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

for (const faultClass of ["closeout-transfer", "reviewer-profile"] as const) {
  test(`${faultClass} retries without questions or review rounds and resumes every held item`, async () => {
    const layout = await repoLayout("paws-system-fault-");
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const ids = faultClass === "reviewer-profile" ? ["1", "2"] : ["1"];
    const tracker = createFakeTracker(
      ids.map((id) => ({
        linearIssueId: `issue-${id}`,
        identifier: `ENG-${id}`,
        title: "Write ok.txt",
        description: null,
        subIssues: [],
      })),
    );
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const config = (model: string) =>
      writeAgentSettings(path.join(layout.pawsRoot, "config.toml"), {
        defaults: {
          implementer: { agent: "codex", model: "implementer" },
          reviewer: { agent: "claude", model },
        },
        projects: [],
      });
    config(faultClass === "reviewer-profile" ? "broken" : "reviewer");
    let transferWorks = false;
    const gate = createFakeCloseoutGate();
    let sequence = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      tracker,
      admission: workspaceAdmission(db),
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
      closeoutGate() {
        if (faultClass === "closeout-transfer" && !transferWorks)
          gate.next = {
            decision: "blocked",
            exhausted: false,
            summary: "policy transfer failed",
            result: {
              systemFault: { faultClass, reason: "policy transfer failed" },
              outcome: "blocked",
              taskId: "task",
              base: "",
              head: "",
              fixAttempts: 0,
              evaluations: 1,
              exitCode: null,
              decision: null,
              summary: "policy transfer failed",
            },
          };
        else gate.next = { decision: "accepted", exhausted: false, summary: "accepted" };
        return gate;
      },
      launch(input) {
        if (input.role === "reviewer" && input.profile?.model === "broken")
          return { command: "/bin/false", args: [] };
        const script = path.join(layout.root, `agent-${++sequence}.json`);
        writeFileSync(
          script,
          JSON.stringify({
            model: input.role === "reviewer" ? "reviewer" : "implementer",
            steps: [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }],
          }),
        );
        return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
      },
    });
    const tickUntil = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) {
        await tickWithRestarts(jobs, orchestrator, db);
        outbox.tick();
        await outbox.idle();
        if (!done()) await Bun.sleep(10);
      }
      expect(done(), JSON.stringify(listJobs(db))).toBe(true);
    };
    try {
      for (const id of ids) await orchestrator.onLinearEvent(event(id));
      await tickUntil(() => listSystemFaults(db).length === ids.length);
      expect(tracker.questions).toEqual([]);
      expect(listJobs(db).filter((job) => job.queue === "system.fault-alert")).toHaveLength(1);
      const rounds = db.query("SELECT * FROM closeout_round").all().length;
      for (const id of ids)
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: `session-${id}`,
          idempotencyKey: `pull-request-ready:${id}`,
          payload: { sessionId: `session-${id}`, kind: "response", body: "PR ready" },
        });
      db.run("UPDATE job SET run_at=0 WHERE status='pending'");
      await tickUntil(() => listSystemFaults(db).every((hold) => hold.failures === 2));
      await jobs.tick(["system.fault-alert"]);
      outbox.tick();
      await outbox.idle();
      const alerts = tracker.systemAlerts;
      expect(alerts).toHaveLength(1);
      expect(listJobs(db).filter((job) => job.queue === "system.fault-alert")).toHaveLength(1);
      for (const id of ids) expect(alerts[0]!.body).toContain(`ENG-${id}`);
      expect(db.query("SELECT * FROM closeout_round").all()).toHaveLength(rounds);
      expect(tracker.questions).toEqual([]);
      transferWorks = true;
      config("reviewer");
      db.run("UPDATE job SET run_at=0 WHERE status='pending'");
      await tickUntil(() => listWorkItems(db).every((item) => item.state === "merge_queue"));
      expect(listSystemFaults(db)).toEqual([]);
      expect(tracker.questions).toEqual([]);
      expect(listJobs(db).filter((job) => job.status === "dead")).toEqual([]);
    } finally {
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    }
  }, 90_000);
}

function event(id: string): AcceptedLinearEvent {
  return {
    dedupeKey: `created:${id}`,
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: `session-${id}`,
    issueId: `issue-${id}`,
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
