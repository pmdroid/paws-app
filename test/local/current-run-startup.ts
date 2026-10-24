import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  bindWorkItemRepository,
  beginImplementRun,
  markRun,
  saveTaskClassification,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  OutboxDispatcher,
  saveTaskMode,
} from "../../src/db";
import { FakeHostGitHubAuth, Orchestrator } from "../../src/loop";
import { migratedDatabase } from "../helpers";
import { workspaceAdmission } from "../fake-workspace";

export async function probeCurrentRunStartup(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const mode of ["code", "artifact", "clarified-artifact"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { mode: 0o700 });
    const db = migratedDatabase(join(home, "paws.db"));
    const clock = new FakeClock(1000);
    const jobs = new JobLoop(db, clock);
    const item = insertQueuedItem(db, { id: `item-${mode}`, sessionKey: `session-${mode}` });
    if (mode === "clarified-artifact") {
      const taskKey = "clarification-task";
      db.run("UPDATE work_item SET task_key=? WHERE id=?", [
        `${taskKey}:item:${item.linearIssueId}`,
        item.id,
      ]);
      saveTaskClassification(db, taskKey, { mode: "clarify", question: "Which page?" });
      const previous = beginImplementRun(db, item.id, clock.now());
      markRun(db, previous.run.id, "ended", clock.now());
    } else saveTaskMode(db, item.id, mode, 0, mode === "artifact");
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "/unused-fixture-repository",
    };
    if (mode !== "clarified-artifact") bindWorkItemRepository(db, item.id, repository);
    let probes = 0;
    let launches = 0;
    const host = Object.assign(new FakeHostGitHubAuth(), {
      integration: {
        check: async () => ++probes === 1 && mode === "artifact",
        identity: () => "workspace-installation-repository",
        administrators: () => [],
        recoveryUrl: "https://paws.example/status/#/settings/integrations",
      },
    });
    const orchestrator = new Orchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      clock,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: home,
      home,
      githubAuth: host,
      repositories: [repository],
      ...(mode === "clarified-artifact"
        ? {
            remoteExecution: {
              agentForSession: () => async (input: import("../../src/acp").RunAgentOptions) => {
                await input.onEvent?.({
                  type: "session_update",
                  sessionId: "classifier",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: JSON.stringify({ mode: "artifact", repository: true }),
                    },
                  },
                });
                return {
                  role: input.role,
                  stopReason: "end_turn" as const,
                  timedOut: false,
                  cancelled: false,
                  authRequired: false,
                  agentExited: true,
                };
              },
              agentForItem: () => async () => {
                throw new Error("Unavailable installation must prevent remote work");
              },
            },
          }
        : {}),
      linearTaskModes: true,
      channel: "agent-session",
      launch: () => {
        launches++;
        throw new Error("An unavailable installation must prevent agent launch");
      },
    });
    try {
      enqueueJob(db, {
        queue: mode === "clarified-artifact" ? JOB_KIND.resume : JOB_KIND.start,
        payload: {
          itemId: item.id,
          ...(mode === "clarified-artifact" ? { handoff: "Capture the create VM dialog" } : {}),
        },
        now: clock.now(),
      });
      await jobs.tick();
      const current = getWorkItem(db, item.id)!;
      const hold = db
        .query<{ current_run_id: string; status: string }, []>(
          "SELECT current_run_id,status FROM github_integration_hold",
        )
        .get();
      assert.equal(current.state, "awaiting_input");
      assert.ok(current.currentRunId);
      assert.equal(hold?.current_run_id, current.currentRunId);
      assert.equal(hold?.status, "pending");
      assert.equal(launches, 0);
      observations.push({ mode, passed: true, state: current.state, probes, launches });
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  }
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  return observations;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Pass a disposable evidence directory");
  console.log(JSON.stringify(await probeCurrentRunStartup(root)));
}
