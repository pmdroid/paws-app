import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { PawsShutdown } from "../src/core";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  resumeUsagePauseNow,
} from "../src/db";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const GITHUB_URL = "https://github.com/acme/fixture.git";
const LIMIT = "You've hit your session limit. Retry-After: 120";
const gitConfig = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const previousGitConfig = gitConfig.map((key) => process.env[key]);

afterAll(() => {
  gitConfig.forEach((key, index) => {
    const value = previousGitConfig[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test("an uninterrupted usage-limit result with a candidate pauses until a resume", async () => {
  const result = await usageLimitScenario(false);
  expect(result.paused, result.detail).toEqual({ resetsAt: result.limitedAt + 120_000 });
  expect(result.limitedReceipt, result.detail).toMatchObject({ outcome: "quota_exhausted" });
  expect(result.cancelAcknowledged, result.detail).toBe(true);
  expect(result.finished, result.detail).toMatchObject({ stopReason: "end_turn" });
  expect(result.head, result.detail).toBe(result.candidateSha);
}, 60_000);

test("a restart between the usage receipt commit and candidate processing still pauses until a resume", async () => {
  const result = await usageLimitScenario(true);
  expect(result.shutdown, result.detail).toBeInstanceOf(PawsShutdown);
  expect(result.detachedCancels, result.detail).toBe(0);
  // The resumed backend enters the same pause, with the reset recorded before the restart.
  expect(result.paused, result.detail).toEqual({ resetsAt: result.limitedAt + 120_000 });
  expect(result.cancelAcknowledged, result.detail).toBe(true);
  expect(result.finished, result.detail).toMatchObject({ stopReason: "end_turn" });
  expect(result.head, result.detail).toBe(result.candidateSha);
  // The replay repeats the decision without counting the execution or its quota again.
  expect(result.limitedReceipt, result.detail).toEqual(result.receiptBeforeRestart);
  expect(result.policyAtPause, result.detail).toEqual(result.policyBeforeRestart);
  expect(result.receipts, result.detail).toBe(2);
}, 60_000);

async function usageLimitScenario(restart: boolean) {
  const root = mkdtempSync(join(tmpdir(), "paws-usage-restart-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const worktree = join(root, "worktree");
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
  writeFileSync(join(source, "result.txt"), "candidate\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Candidate"]);
  const candidateSha = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["-C", source, "push", origin, "HEAD:refs/heads/candidate"]);
  await git(["clone", origin, worktree]);
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: GITHUB_URL,
  });

  const path = join(root, "paws.db");
  let db: Database = migratedDatabase(path);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [workspace.id, "acme/fixture", "team"]);
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const pairing = await control.beginPairing({
    name: "fixture",
    csr: (await createRunnerKey(join(root, "client"))).csr,
  });
  const { runnerId } = await control.approvePairing(
    { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
    pairing.code,
  );
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, { owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
  mkdirSync(join(root, "runs"), { recursive: true });

  const keys = generateKeyPairSync("ed25519");
  const shutdown = new AbortController();
  let limitedAt = 0;
  let limitedCommand = "";
  function open() {
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
    const results = createRunnerResults({ db, work });
    const health = createRunnerHealth({ db, work });
    const placement = createRunnerPlacement({ db });
    const backend = createRemoteAgentRunner({
      db,
      work,
      results,
      health,
      pollIntervalMs: 5,
      placement: {
        ...placement,
        finished(input) {
          const disposition = placement.finished(input);
          if (input.commandId === limitedCommand && !limitedAt) {
            limitedAt = input.finishedAt;
            // Paws stops right after the usage receipt commits.
            if (restart) shutdown.abort(new PawsShutdown());
          }
          return disposition;
        },
      },
      async fetchCandidate(candidate) {
        candidate.signal.throwIfAborted();
        await git(["-C", candidate.worktree, "fetch", origin, candidate.candidateSha]);
        await git(["-C", candidate.worktree, "reset", "--hard", candidate.candidateSha]);
      },
      async checkpointBot() {
        return { appId: "1", login: "paws[bot]", id: 1 };
      },
    });
    return { work, results, backend };
  }
  let services = open();

  const receipt = (commandId: string) =>
    db.query("SELECT * FROM runner_execution_usage WHERE command_id=?").get(commandId) as Record<
      string,
      unknown
    > | null;
  const policy = () =>
    db
      .query("SELECT * FROM runner_agent_policy WHERE runner_id=? AND agent='claude'")
      .get(runnerId) as Record<string, unknown> | null;
  const sim = {
    stopped: false,
    paused: false,
    pause: null as { resetsAt: number } | null,
    policyAtPause: null as Record<string, unknown> | null,
  };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      if (!sim.paused) {
        const { work, results } = services;
        work.heartbeat(runnerId);
        const pause = db
          .query<{ runId: string; resetsAt: number }, []>(
            "SELECT run_id AS runId,resets_at AS resetsAt FROM usage_pause",
          )
          .get();
        if (pause && !sim.pause) {
          sim.pause = { resetsAt: pause.resetsAt };
          sim.policyAtPause = policy();
          resumeUsagePauseNow(db, pause.runId, Date.now());
        }
        for (const envelope of work.commands(runnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          work.acknowledge(runnerId, command.id);
          if (command.type !== "run") continue;
          const limited = !limitedCommand;
          if (limited) limitedCommand = command.id;
          const grant = work.issueGrant({
            runnerId,
            runId: command.runId,
            commandId: command.id,
            generation: command.generation,
          });
          results.submit({
            runnerId,
            runId: command.runId,
            generation: command.generation,
            token: grant.token,
            result: {
              executionId: workspaceId(),
              commandId: command.id,
              role: "implementer",
              stopReason: limited ? "error" : "end_turn",
              timedOut: false,
              cancelled: false,
              authRequired: false,
              agentExited: true,
              candidateSha,
              identity: { session: `session-${command.id}`, model: "fixture", provider: "fixture" },
              ...(limited ? { errorMessage: LIMIT } : {}),
            },
          });
        }
      }
      await Bun.sleep(5);
    }
  })();

  const options = (signal: AbortSignal) => ({
    role: "implementer" as const,
    itemId: item.id,
    runId: run.id,
    prompt: "Write output",
    worktreePath: worktree,
    pawsRoot: root,
    profile: { agent: "claude" as const, model: null },
    networkGit: git,
    signal,
  });
  let shutdownError: unknown;
  let receiptBeforeRestart: Record<string, unknown> | null = null;
  let policyBeforeRestart: Record<string, unknown> | null = null;
  let detachedCancels: number | null = null;
  try {
    let finished;
    if (restart) {
      shutdownError = await services.backend
        .forItem(item.id)(options(shutdown.signal))
        .then(
          () => null,
          (error: unknown) => error,
        );
      sim.paused = true;
      receiptBeforeRestart = receipt(limitedCommand);
      policyBeforeRestart = policy();
      detachedCancels = db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM runner_command WHERE kind='cancel'",
        )
        .get()!.count;
      db.close();
      db = openDatabase(path);
      services = open();
      sim.paused = false;
    }
    finished = await services.backend.forItem(item.id)(options(new AbortController().signal));
    const cancel = db
      .query<{ acknowledged: number | null }, [string]>(
        "SELECT acknowledged_at AS acknowledged FROM runner_command WHERE kind='cancel' AND generation=(SELECT generation FROM runner_command WHERE id=?)",
      )
      .get(limitedCommand);
    return {
      candidateSha,
      limitedAt,
      shutdown: shutdownError,
      detachedCancels,
      receiptBeforeRestart,
      policyBeforeRestart,
      limitedReceipt: receipt(limitedCommand),
      policyAtPause: sim.policyAtPause,
      receipts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_execution_usage")
        .get()!.count,
      paused: sim.pause,
      cancelAcknowledged: cancel?.acknowledged !== null && cancel?.acknowledged !== undefined,
      finished,
      head: await git(["-C", worktree, "rev-parse", "HEAD"]),
      detail: JSON.stringify({
        receipts: db
          .query("SELECT command_id,outcome,ended_at,resets_at FROM runner_execution_usage")
          .all(),
        commands: db.query("SELECT kind,generation,acknowledged_at FROM runner_command").all(),
        shutdown: String(shutdownError),
      }),
    };
  } finally {
    sim.stopped = true;
    await runner;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
