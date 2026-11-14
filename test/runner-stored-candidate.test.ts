import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getItemCandidate,
  getWorkItem,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  type Q,
} from "../src/db";
import { syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import type { GitHubClient } from "../src/github";
import { createRemoteAgentRunner, type GitHubCommits } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempStore } from "./pglite";

const GITHUB_URL = "https://github.com/acme/fixture.git";
const gitConfig = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const previousGitConfig = gitConfig.map((key) => process.env[key]);

afterAll(() => {
  gitConfig.forEach((key, index) => {
    const value = previousGitConfig[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test("with mirrors off a runner run starts from the stored candidate and never clones a mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-stored-candidate-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "README.md"), "Fixture\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture"]);
  await git(["clone", "--bare", source, origin]);
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: GITHUB_URL,
  });

  const { db, close } = await tempStore();
  const now = Date.now();
  // Keep capacity retries in the future while Git and runner setup use real time.
  const clock = new FakeClock(now);
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: workspace.id, repository: "acme/fixture", teamId: "team" }),
    ),
  );
  const runnerRow = (q: Q, id: string, values: Partial<typeof q.t.runner.$inferInsert>) =>
    q.exec(q.orm.update(q.t.runner).set(values).where(eq(q.t.runner.id, id)));
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const owner = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const pair = async (name: string) => {
    const enrollment = {
      name,
      csr: (await createRunnerKey(join(root, name))).csr,
    };
    const { runnerId } = await control.enroll({
      ...enrollment,
      token: (await control.createEnrollment(owner, enrollment)).token,
    });
    await db.run(function* (q) {
      yield* runnerRow(q, runnerId, { status: "active" });
      yield* q.exec(q.orm.insert(q.t.runnerPolicy).values({ runnerId }));
      yield* q.exec(
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "claude", ready: 1 }),
      );
    });
    return runnerId;
  };
  const runnerId = await pair("free");
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  await work.heartbeat(runnerId, 8);
  const main = await git(["-C", source, "rev-parse", "HEAD"]);
  const refCalls: string[] = [];
  writeFileSync(join(source, "feature.txt"), "runner work\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Runner work"]);
  const candidate = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["-C", source, "push", "--quiet", origin, "HEAD:refs/heads/runner-work"]);
  let pushed = false;
  const githubCommits: GitHubCommits = {
    async ref(name) {
      refCalls.push(name);
      if (name === "refs/heads/main") return main;
      return pushed && name.startsWith("refs/heads/paws/") ? candidate : null;
    },
    async commit(sha) {
      return { subject: "", parents: sha === candidate ? [main] : [] };
    },
    async contains(tip, sha) {
      return tip === sha || (tip === candidate && sha === main);
    },
  };
  const client: GitHubClient = {
    async request({ method, path }) {
      refCalls.push(`${method} ${path}`);
      return path === "/repos/acme/fixture/git/ref/heads/main"
        ? { status: 200, body: { object: { sha: main, type: "commit" } } }
        : { status: 404, body: { message: "Not Found" } };
    },
  };
  const results = createRunnerResults({ store: db, work });
  const health = createRunnerHealth({ store: db, work });
  const identifiers = ["ENG-1"];
  const placement = createRunnerPlacement({ store: db });
  const backend = createRemoteAgentRunner({
    store: db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement,
    storedCandidates: () => githubCommits,
    async fetchCandidate() {
      throw new Error("Stored candidates never import into a mirror");
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });

  const tracker = createFakeTracker(
    identifiers.map((identifier, index) => ({
      linearIssueId: `issue-${index}`,
      identifier,
      title: `Task ${identifier}`,
      description: null,
      subIssues: [],
    })),
  );
  const jobs = new JobLoop(db, clock, { concurrency: 2, pollMs: 5 });
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = attachOrchestrator({
    store: db,
    jobs,
    outbox,
    clock,
    pawsRoot: root,
    home: root,
    tracker,
    repositories: [{ owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL }],
    scheduling: async () => ({}),
    githubMirrors: false,
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      client,
      tokenProvider: { mode: "app", tokenFor: async () => "ghs_test" },
    }),
    reviewRequirements: async () => ({ ok: true, items: [] }),
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem(itemId) {
        return (options) => backend.forItem(itemId)({ ...options, networkGit: git });
      },
    },
  });

  const started = new Set<string>();
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      await work.heartbeat(runnerId, 8);
      for (const envelope of await work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        await work.acknowledge(runnerId, command.id);
        if (command.type === "login_check")
          await health.submit(runnerId, {
            ...receipt(command),
            login: { agent: command.agent, authenticated: true, method: "subscription" },
          });
        if (command.type === "probe")
          await health.submit(runnerId, {
            ...receipt(command),
            models: [{ id: "fixture-implement-model", name: "Fixture" }],
          });
        if (command.type === "run") {
          started.add(
            (await listWorkItems(db)).find((item) => item.currentRunId === command.runId)!
              .linearIdentifier,
          );
          pushed = true;
          const { token } = await work.issueGrant({
            runnerId,
            runId: command.runId,
            commandId: command.id,
            generation: command.generation,
          });
          await results.submit({
            runnerId,
            runId: command.runId,
            generation: command.generation,
            token,
            result: { ...receipt(command), candidateSha: candidate },
          });
        }
      }
      await Bun.sleep(5);
    }
  })();

  const controller = new AbortController();
  let loop: Promise<void> | undefined;
  try {
    for (const [index] of identifiers.entries()) {
      await orchestrator.onLinearEvent({
        dedupeKey: `created:${index}`,
        deliveryId: null,
        source: "webhook",
        action: "created",
        sessionId: `session-${index}`,
        issueId: `issue-${index}`,
        activityId: null,
        actorId: null,
        body: null,
        signal: null,
        updatedAtMs: Date.now(),
        payload: "{}",
      });
      const item = (await listWorkItems(db)).find((row) => row.sessionKey === `session-${index}`)!;
      await recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "app",
        appUserId: "app-user",
        sessionId: `session-${index}`,
        teamId: "team",
        observedAtMs: now,
      });
      await bindLinearSessionTask(db, `session-${index}`, item.delegationId, {
        actorId: "owner",
      });
      await db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ ownerUserId: userId })
            .where(eq(q.t.workItem.id, item.id)),
        ),
      );
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId: workspace.id,
        expectedGeneration: 0,
        tracker,
        lifecycle: createFakeLinearIssueLifecycle({
          id: `issue-${index}`,
          teamId: "team",
          assigneeId: "owner",
          delegateId: "app-user",
          stateType: "started",
          projectId: "project",
        }),
      });
    }
    await dispatch(db, { now: clock.now() });
    loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !started.has("ENG-1")) await Bun.sleep(10);
    const [item] = await listWorkItems(db);
    const detail = JSON.stringify({ state: item?.state, refCalls });
    expect([...started], detail).toEqual(["ENG-1"]);
    expect(refCalls).toContain("GET /repos/acme/fixture/git/ref/heads/main");
    const recorded = async () => (await getItemCandidate(db, item!.id))?.sha;
    while (Date.now() < deadline && (await recorded()) !== candidate) await Bun.sleep(10);
    expect(await recorded(), detail).toBe(candidate);
    const checkpoint = async () => (await getWorkItem(db, item!.id))?.checkpoint;
    while (Date.now() < deadline && (await checkpoint())?.wipCommit !== candidate)
      await Bun.sleep(10);
    expect(await checkpoint(), detail).toMatchObject({ baseSha: main, wipCommit: candidate });
    const mirror = join(root, "repos", "acme", "fixture.git");
    expect(await git(["--git-dir", mirror, "for-each-ref", "refs/paws/candidates"])).toBe("");
  } finally {
    controller.abort();
    await orchestrator.shutdown().catch(() => undefined);
    sim.stopped = true;
    await runner;
    await loop;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

function receipt(command: RunnerCommand) {
  return {
    executionId: workspaceId(),
    commandId: command.id,
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: {
      session: `session-${command.id}`,
      model: "fixture-implement-model",
      provider: "fixture",
    },
  };
}
