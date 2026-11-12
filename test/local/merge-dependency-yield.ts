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
  listJobs,
  recordLinearInstallation,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { createAdmission } from "../../src/scheduler";
import { seed } from "../dialects";
import { tempStore } from "../pglite";

export async function probeMergeDependencyYield(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  await probeRunnerOrchestration(root, observe, true);
  for (const guard of [undefined, () => false]) {
    const label = guard ? "rejected" : "missing";
    const directory = join(root, label);
    mkdirSync(directory, { recursive: true });
    const { db, close } = await tempStore();
    const clock = new FakeClock(1000);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workspace).values({
          id: "workspace",
          linearOrganizationId: "org",
          name: "Workspace",
          createdAt: 1000,
        }),
      (q) =>
        q.orm.insert(q.t.workItem).values({
          id: "item",
          delegationId: "epic",
          linearIssueId: "issue",
          linearIdentifier: "WS-2",
          title: "Guarded",
          state: "merge_queue",
          branchName: "paws/ws-2",
          position: 0,
          createdAt: 1000,
          sessionKey: "session",
        }),
    );
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", "epic");
    const jobs = new JobLoop(db, clock);
    let gitHubCalls = 0;
    const orchestrator = new Orchestrator({
      store: db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      clock,
      pawsRoot: directory,
      ...(guard ? { admission: createAdmission({ db: db, authority: guard }) } : {}),
      repositories: [
        { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" },
      ],
      githubForRepository: () => ({
        appId: "",
        installationId: "",
        privateKeyPem: "",
        client: {
          async request() {
            gitHubCalls += 1;
            throw new Error("Workspace publication must be held");
          },
        },
      }),
    });
    try {
      await enqueueJob(db, {
        queue: JOB_KIND.merge,
        payload: { itemId: "item" },
        now: clock.now(),
      });
      await jobs.tick();
      const successor =
        (await listJobs(db))
          .filter((job) => job.status === "pending")
          .map(({ queue, status }) => ({ queue, status }))[0] ?? null;
      observe(
        `workspace publication fails closed with a ${label} canonical dependency guard`,
        (await getWorkItem(db, "item"))?.state === "merge_queue" &&
          gitHubCalls === 0 &&
          successor !== null,
        { state: (await getWorkItem(db, "item"))?.state, gitHubCalls, successor },
      );
    } finally {
      await orchestrator.shutdown();
      await close();
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
