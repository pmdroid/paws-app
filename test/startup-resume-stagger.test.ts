import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { FakeClock, JOB_KIND, systemClock, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
} from "../src/db";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  parseAgentEvent,
} from "../src/linear";
import { LinearTaskAccess, attachOrchestrator } from "../src/loop";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const ISSUES = ["one", "two", "three", "four"];
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

test("a restart with four recovering tasks resumes them one at a time, oldest first", async () => {
  const layout = await repoLayout();
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker(
    ISSUES.map((id, index) => ({
      linearIssueId: id,
      identifier: `ENG-${index + 1}`,
      title: `Write ${id}.txt`,
      description: null,
      subIssues: [],
    })),
  );
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: ISSUES.map((id) => ({
      ...scope,
      sessionId: `ses_${id}`,
      issueId: id,
      teamId: "team",
    })),
    teams: ["team"],
  });
  const ownership = (id: string) => ({
    id,
    teamId: "team",
    assigneeId: "pascal",
    delegateId: null,
    stateType: "unstarted" as const,
  });
  const lifecycle = createFakeLinearIssueLifecycle(ownership(ISSUES[0]!));
  for (const id of ISSUES.slice(1)) lifecycle.issues.set(id, ownership(id));
  const implementations: string[] = [];
  const attach = (clock: Clock) => {
    const jobs = new JobLoop(db, clock, { concurrency: 4 });
    let orchestrator: ReturnType<typeof attachOrchestrator>;
    const gate = new LinearTaskAccess(db, {
      access: access.adapter,
      lifecycle,
      oauthClientId: scope.oauthClientId,
      appUserId: scope.appUserId,
      stopSession: () => {},
      interruptSession: (sessionId) => orchestrator.interruptLinearSession(sessionId),
    });
    orchestrator = attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox: new OutboxDispatcher(db, systemClock),
      tracker,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      linearTaskModes: true,
      linearAccess: gate,
      scheduling: () => ({}),
      launch(input) {
        if (input.purpose === "implement") implementations.push(input.itemId);
        const steps: FakeScript["steps"] =
          input.purpose === "classify"
            ? [
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: '{"mode":"code"}' },
                  },
                },
                { type: "end" },
              ]
            : [{ type: "hang" }];
        const script = path.join(
          layout.root,
          `stagger-${implementations.length}-${Math.random()}.json`,
        );
        writeFileSync(script, JSON.stringify({ model: "test-claude-model", steps }));
        return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
      },
    });
    return { jobs, gate, orchestrator };
  };

  const first = attach(systemClock);
  const firstStop = new AbortController();
  const firstLoop = first.jobs.run(firstStop.signal);
  let second: ReturnType<typeof attach> | undefined;
  const secondStop = new AbortController();
  let secondLoop: Promise<void> | undefined;
  try {
    for (const [index, id] of ISSUES.entries()) {
      const event = parseAgentEvent(
        JSON.stringify({
          type: "AgentSessionEvent",
          action: "created",
          ...scope,
          agentSession: {
            id: `ses_${id}`,
            creatorId: "pascal",
            issue: { id, team: { id: "team" } },
          },
        }),
        `delivery:${id}`,
        Date.now() + index,
      )!;
      expect(await first.gate.accept(event)).toBe(true);
      await first.orchestrator.onLinearEvent(event);
      await Bun.sleep(5);
    }
    await until(
      () => implementations.length === 4,
      () => detail(db),
    );
    firstStop.abort();
    await first.orchestrator.shutdown().catch(() => undefined);
    await firstLoop;
    prepareShutdown(db);
    expect(
      listWorkItems(db).map((item) => item.state),
      detail(db),
    ).toEqual(ISSUES.map(() => "recovering"));

    implementations.length = 0;
    const reads: string[] = [];
    let inFlight = 0;
    const inspect = lifecycle.inspect;
    lifecycle.inspect = async (id, options) => {
      inFlight += 1;
      reads.push(`start:${id}`);
      try {
        await Bun.sleep(10);
        return await inspect(id, options);
      } finally {
        inFlight -= 1;
        reads.push(`end:${id}`);
      }
    };
    const clock = new FakeClock(Date.now());
    recoverOnStartup(db, clock.now());
    second = attach(clock);
    secondLoop = second.jobs.run(secondStop.signal, () => Bun.sleep(5));
    const claimed = () =>
      listJobs(db).filter((job) => job.queue === JOB_KIND.resume && job.status !== "pending")
        .length;
    await until(
      () => {
        if (implementations.length === 4) return true;
        if (inFlight === 0 && implementations.length >= claimed()) clock.advance(1_000);
        return false;
      },
      () => detail(db),
    );

    expect(reads).toEqual(ISSUES.flatMap((id) => [`start:${id}`, `end:${id}`]));
    expect(
      listWorkItems(db).map((item) => getWorkItem(db, item.id)?.state),
      detail(db),
    ).toEqual(ISSUES.map(() => "running"));
  } finally {
    firstStop.abort();
    secondStop.abort();
    await second?.orchestrator.shutdown().catch(() => undefined);
    await secondLoop?.catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 90_000);

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(describe());
    await Bun.sleep(10);
  }
}

function detail(db: ReturnType<typeof openDatabase>): string {
  return JSON.stringify({
    items: listWorkItems(db).map((item) => `${item.linearIdentifier}:${item.state}`),
    jobs: listJobs(db).map(
      (job) => `${job.queue}:${job.status}:${job.runAt}:${job.lastError ?? ""}`,
    ),
  });
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-stagger-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  for (const [key, value] of [
    ["user.email", "paws-test@example.com"],
    ["user.name", "Paws Test"],
    ["commit.gpgsign", "false"],
  ])
    await exec("git", ["-C", seed, "config", key!, value!]);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}
