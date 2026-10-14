import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  bindWorkItemRepository,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  migrate,
  openDatabase,
  OutboxDispatcher,
  saveTaskMode,
} from "../../src/db";
import { FakeHostGitHubAuth, Orchestrator } from "../../src/loop";

export async function probeCurrentRunStartup(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const mode of ["code", "artifact"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { mode: 0o700 });
    const db = openDatabase(join(home, "paws.db"));
    migrate(db);
    const clock = new FakeClock(1000);
    const jobs = new JobLoop(db, clock);
    const item = insertQueuedItem(db, { id: `item-${mode}`, sessionKey: `session-${mode}` });
    saveTaskMode(db, item.id, mode, 0, mode === "artifact");
    bindWorkItemRepository(db, item.id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "/unused-fixture-repository",
    });
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
      jobs,
      clock,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: home,
      home,
      githubAuth: host,
      linearTaskModes: true,
      channel: "agent-session",
      launch: () => {
        launches++;
        throw new Error("An unavailable installation must prevent agent launch");
      },
    });
    try {
      enqueueJob(db, { queue: JOB_KIND.start, payload: { itemId: item.id }, now: clock.now() });
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
