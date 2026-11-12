import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  syncSteps,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { workspaceAdmission, workspaceDispatchPg } from "../fake-workspace";
import { tempStore } from "../pglite";

export async function probeCurrentRunStartup(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const mode of ["code", "artifact", "clarified-artifact"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { mode: 0o700 });
    const store = await tempStore();
    const db = store.db;
    const clock = new FakeClock(1000);
    const jobs = new JobLoop(db, clock);
    const item = await insertQueuedItem(db, { id: `item-${mode}`, sessionKey: `session-${mode}` });
    if (mode === "clarified-artifact") {
      const taskKey = "clarification-task";
      await db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ taskKey: `${taskKey}:item:${item.linearIssueId}` })
            .where(eq(q.t.workItem.id, item.id)),
        ),
      );
      await saveTaskClassification(db, taskKey, {
        mode: "clarify",
        question: "Which page?",
      });
      const previous = await beginImplementRun(db, item.id, clock.now());
      await markRun(db, previous.run.id, "ended", clock.now());
    } else await saveTaskMode(db, item.id, mode, 0, mode === "artifact");
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "/unused-fixture-repository",
    };
    if (mode !== "clarified-artifact") await bindWorkItemRepository(db, item.id, repository);
    let probes = 0;
    let launches = 0;
    const host = {
      check: async () => ++probes === 1 && mode === "artifact",
      identity: () => syncSteps(() => "workspace-installation-repository"),
      administrators: () => syncSteps(() => []),
      recoveryUrl: "https://paws.example/status/#/settings/integrations",
    };
    const orchestrator = new Orchestrator({
      store: db,
      admission: workspaceAdmission(db),
      jobs,
      clock,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: home,
      home,
      githubInstallation: host,
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
      launch: () => {
        launches++;
        throw new Error("An unavailable installation must prevent agent launch");
      },
    });
    try {
      if (mode !== "clarified-artifact") await workspaceDispatchPg(db, { now: clock.now() });
      else
        await enqueueJob(db, {
          queue: mode === "clarified-artifact" ? JOB_KIND.resume : JOB_KIND.start,
          payload: {
            itemId: item.id,
            ...(mode === "clarified-artifact" ? { handoff: "Capture the create VM dialog" } : {}),
          },
          now: clock.now(),
        });
      await jobs.tick();
      const current = (await getWorkItem(db, item.id))!;
      const hold = await db.run((q) =>
        q.one(
          q.orm
            .select({
              currentRunId: q.t.githubIntegrationHold.currentRunId,
              status: q.t.githubIntegrationHold.status,
            })
            .from(q.t.githubIntegrationHold),
        ),
      );
      assert.equal(current.state, "awaiting_input");
      assert.ok(current.currentRunId);
      assert.equal(hold?.currentRunId, current.currentRunId);
      assert.equal(hold?.status, "pending");
      assert.equal(launches, 0);
      observations.push({ mode, passed: true, state: current.state, probes, launches });
    } finally {
      await orchestrator.shutdown();
      await store.close();
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
