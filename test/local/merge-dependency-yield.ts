import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeRunnerOrchestration } from "./runner-orchestration";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  enqueueJob,
  getWorkItem,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";

export async function probeMergeDependencyYield(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  await probeRunnerOrchestration(root, observe, true);
  for (const guard of [undefined, () => false]) {
    const label = guard ? "rejected" : "missing";
    const directory = join(root, label);
    mkdirSync(directory, { recursive: true });
    const db = openDatabase(join(directory, "paws.sqlite"));
    migrate(db);
    const clock = new FakeClock(1000);
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('item','epic','issue','WS-2','Guarded','merge_queue','paws/ws-2',0,1000,'session')",
    );
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", "epic");
    const jobs = new JobLoop(db, clock);
    let gitHubCalls = 0;
    const orchestrator = new Orchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: directory,
      canAdvanceItem: guard,
      repository: { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" },
      github: {
        appId: "",
        installationId: "",
        privateKeyPem: "",
        client: {
          async request() {
            gitHubCalls += 1;
            throw new Error("Workspace publication must be held");
          },
        },
      },
    });
    try {
      enqueueJob(db, { queue: JOB_KIND.merge, payload: { itemId: "item" }, now: clock.now() });
      await jobs.tick();
      const successor = db.query("SELECT queue,status FROM job WHERE status='pending'").get();
      observe(
        `workspace publication fails closed with a ${label} canonical dependency guard`,
        getWorkItem(db, "item")?.state === "merge_queue" && gitHubCalls === 0 && successor !== null,
        { state: getWorkItem(db, "item")?.state, gitHubCalls, successor },
      );
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable proof directory");
  const observations: unknown[] = [];
  await probeMergeDependencyYield(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    assert(passed, name);
  });
  console.log(JSON.stringify({ root, observations: observations.length }));
}
