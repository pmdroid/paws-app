import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AcpEvent } from "../src/acp";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  saveCheckpoint,
  sqliteDb,
} from "../src/db";
import { isTransient } from "../src/core";
import {
  createRemoteAgentRunner,
  ensureStartOnRemote,
  RemoteStartUnverified,
} from "../src/runner-backend";
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
const BRANCH = "paws/item";
const REF = "refs/paws/candidates/item";

test("a head that is already on GitHub starts as before, with no push", async () => {
  const result = await startScenario({ local: [], push: "works" });
  expect(result.pushes, result.detail).toBe(0);
  expect(result.baseSha, result.detail).toBe(result.prHead);
  expect(result.prompt, result.detail).toBe("Write output");
  expect(result.thoughts, result.detail).toEqual([]);
});

test("a head missing on GitHub is pushed before the run when the push works", async () => {
  const result = await startScenario({ local: ["Lost one"], push: "works" });
  expect(result.pushes, result.detail).toBe(1);
  expect(result.baseSha, result.detail).toBe(result.localHead);
  expect(result.remoteBranch, result.detail).toBe(result.localHead);
  expect(result.prompt, result.detail).toBe("Write output");
  expect(result.thoughts, result.detail).toEqual([]);
});

test("a head whose push keeps failing starts from the PR branch head and names the lost commits", async () => {
  const result = await startScenario({ local: ["Lost one", "Lost two"], push: "fails" });
  expect(result.pushes, result.detail).toBe(2);
  expect(result.baseSha, result.detail).toBe(result.prHead);
  expect(result.remoteBranch, result.detail).toBe(result.prHead);
  expect(result.prompt, result.detail).toBe(
    `Your commits after ${result.prHead.slice(0, 8)} didn't reach GitHub: Lost two; Lost one. Redo them.\n\nWrite output`,
  );
  expect(result.thoughts, result.detail).toHaveLength(1);
  expect(result.thoughts[0], result.detail).toContain(result.localHead.slice(0, 8));
  // The item keeps going: its checkpoint now names the commit GitHub holds.
  expect(result.state, result.detail).not.toBe("cancelled");
  expect(result.wipCommit, result.detail).toBe(result.prHead);
  // The dispatched command carried the handoff, so the checkpoint no longer holds it.
  expect(result.pendingAfter, result.detail).toBeUndefined();
});

test("an item branch never pushed to a repository whose default branch is master is still pushed", async () => {
  const result = await startScenario({
    local: ["Lost one"],
    push: "works",
    defaultBranch: "master",
    prBranch: false,
  });
  expect(result.pushes, result.detail).toBe(1);
  expect(result.baseSha, result.detail).toBe(result.localHead);
  expect(result.remoteBranch, result.detail).toBe(result.localHead);
});

test("without a PR branch a failed push falls back to the base on the default branch", async () => {
  const result = await startScenario({
    local: ["Lost one"],
    push: "fails",
    defaultBranch: "master",
    prBranch: false,
  });
  expect(result.baseSha, result.detail).toBe(result.base);
  expect(result.prompt, result.detail).toStartWith(
    `Your commits after ${result.base.slice(0, 8)} didn't reach GitHub: Lost one; On the PR branch. Redo them.`,
  );
});

test("a start Paws cannot establish on GitHub dispatches nothing and retries later", async () => {
  const result = await startScenario({ local: ["Lost one"], push: "fails", fetch: "fails" });
  expect(result.error, result.detail).toBeInstanceOf(RemoteStartUnverified);
  expect(isTransient(result.error), result.detail).toBe(true);
  expect(result.pushes, result.detail).toBe(2);
  expect(result.baseSha, result.detail).toBeUndefined();
  expect(result.head, result.detail).toBe(result.localHead);
});

test("a fallback whose dispatch fails still hands the lost commits to the next attempt", async () => {
  const result = await startScenario({
    local: ["Lost one", "Lost two"],
    push: "fails",
    failFirstDispatch: true,
  });
  const note = `Your commits after ${result.prHead.slice(0, 8)} didn't reach GitHub: Lost two; Lost one. Redo them.`;
  // The first attempt saved the handoff before it failed; the retry finds HEAD already on GitHub.
  expect(result.pendingBetween, result.detail).toBe(note);
  expect(result.error, result.detail).toBeUndefined();
  expect(result.baseSha, result.detail).toBe(result.prHead);
  expect(result.prompt, result.detail).toBe(`${note}\n\nWrite output`);
  expect(result.pendingAfter, result.detail).toBeUndefined();
  expect(result.thoughts, result.detail).toHaveLength(1);
});

test("a fallback saved before a stop is repeated once, with its handoff and no second thought", async () => {
  const result = await startScenario({
    local: ["Lost one", "Lost two"],
    push: "fails",
    stoppedBeforeReset: true,
  });
  const note = `Your commits after ${result.prHead.slice(0, 8)} didn't reach GitHub: Lost two; Lost one. Redo them.`;
  expect(result.baseSha, result.detail).toBe(result.prHead);
  expect(result.prompt, result.detail).toBe(`${note}\n\nWrite output`);
  expect(result.thoughts, result.detail).toEqual([]);
  expect(result.pendingAfter, result.detail).toBeUndefined();
});

test("the fallback and its handoff are saved before the candidate ref moves", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-start-order-"));
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
  const git = async (args: string[]) => {
    const child = Bun.spawn(["/usr/bin/git", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out.trim();
  };
  const origin = join(root, "origin.git");
  const worktree = join(root, "worktree");
  try {
    await git(["init", "--bare", "-b", "main", origin]);
    await git(["init", "-b", "main", worktree]);
    writeFileSync(join(worktree, "a.txt"), "a\n");
    await git(["-C", worktree, "add", "."]);
    await git(["-C", worktree, "commit", "-m", "Base"]);
    await git(["-C", worktree, "push", origin, "HEAD:refs/heads/main"]);
    const base = await git(["-C", worktree, "rev-parse", "HEAD"]);
    writeFileSync(join(worktree, "b.txt"), "b\n");
    await git(["-C", worktree, "add", "."]);
    await git(["-C", worktree, "commit", "-m", "Lost one"]);
    const head = await git(["-C", worktree, "rev-parse", "HEAD"]);
    const mirror = join(worktree, ".git");
    await git(["--git-dir", mirror, "update-ref", REF, head]);
    const saved: unknown[] = [];
    const pending = ensureStartOnRemote({
      mirror,
      ref: REF,
      branch: BRANCH,
      remoteUrl: GITHUB_URL,
      async networkGit(args) {
        if (args.includes("push")) throw new Error("remote: Permission denied (403)");
        return git(args.map((arg) => (arg === GITHUB_URL ? origin : arg)));
      },
      baseSha: base,
      persistFallback(fallback) {
        saved.push(fallback);
        // Paws stops here, after the save and before the reset.
        throw new Error("Paws stopped");
      },
      signal: new AbortController().signal,
    });
    await expect(pending).rejects.toThrow("Paws stopped");
    expect(saved).toEqual([{ head, start: base, lost: ["Lost one"] }]);
    expect(await git(["--git-dir", mirror, "rev-parse", REF])).toBe(head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const pushError of [
  "fatal: The requested URL returned error: 502",
  "fatal: connection reset by peer",
  "TimeoutError: request timed out",
  "GitHub token refresh failed",
  "fatal: The requested URL returned error: 401",
  "remote: secondary rate limit (403)",
])
  test(`a transient push error preserves local work: ${pushError}`, async () => {
    const result = await startScenario({ local: ["Lost one"], push: "fails", pushError });
    expect(result.error, result.detail).toBeInstanceOf(RemoteStartUnverified);
    expect(result.head).toBe(result.localHead);
    expect(result.wipCommit).toBe(result.localHead);
    expect(result.baseSha).toBeUndefined();
    expect(result.thoughts).toEqual([]);
    expect(result.pendingAfter).toBeUndefined();
  });

test("fallback reports only commits absent from all fetched GitHub tips", async () => {
  const result = await startScenario({
    local: ["Lost one"],
    push: "fails",
    mergeMain: true,
    pushError: "! [rejected] head -> paws/item (non-fast-forward)",
  });
  expect(result.baseSha, result.detail).toBe(result.prHead);
  expect(result.prompt).toContain("Lost one");
  expect(result.prompt).not.toContain("Already on GitHub");
  expect(result.pushes).toBe(1);
});

test("fallback preserves a candidate ref that moved during the push", async () => {
  const result = await startScenario({ local: ["Lost one"], push: "fails", moveDuringPush: true });
  expect(result.error, result.detail).toBeInstanceOf(RemoteStartUnverified);
  expect(result.baseSha).toBeUndefined();
  expect(result.head).not.toBe(result.prHead);
  expect(result.head).not.toBe(result.localHead);
  expect(result.pendingAfter).toBeUndefined();
});

test("fallback replaces an unpublished intermediate WIP checkpoint", async () => {
  const result = await startScenario({
    local: ["Lost one", "Lost two"],
    push: "fails",
    earlierWip: true,
  });
  expect(result.wipCommit, result.detail).toBe(result.prHead);
});

test("a cancelled assignment keeps the handoff for the next command", async () => {
  const result = await startScenario({ local: ["Lost one"], push: "fails", cancelFirstRun: true });
  expect(result.error, result.detail).toBeUndefined();
  expect(result.pendingBetween).toContain("Lost one");
  expect(result.pendingAtAssignment).toBe(result.pendingBetween);
  expect(result.prompt).toContain(result.pendingBetween!);
  expect(result.pendingAfter).toBeUndefined();
  expect(result.thoughts).toHaveLength(1);
});

test("a hidden-ref checkpoint goes to a current runner to restore, leaving the PR branch alone", async () => {
  const result = await startScenario({
    local: [],
    push: "fails",
    hiddenCheckpoint: { runnerVersion: "0.1.67" },
  });
  expect(result.error, result.detail).toBeUndefined();
  expect(result.restoreCheckpoint).toEqual({ sha: result.hiddenWip!, branch: "paws/item" });
  expect(result.baseSha).toBe(result.prHead);
  expect(result.head).toBe(result.prHead);
  expect(result.remoteBranch).toBe(result.prHead);
  expect(result.pushes).toBe(0);
});

test("a checkpoint rebased onto an earlier main restores against that main after main moved", async () => {
  const result = await startScenario({
    local: [],
    push: "fails",
    hiddenCheckpoint: { runnerVersion: "0.1.67", rebasedOnEarlierMain: true },
  });
  expect(result.error, result.detail).toBeUndefined();
  expect(result.restoreCheckpoint).toEqual({ sha: result.hiddenWip!, branch: "paws/item" });
  expect(result.mainSha).toBe(result.earlierMain!);
  expect(result.mainSha).not.toBe(result.movedMain!);
  expect(result.baseSha).toBe(result.prHead);
  expect(result.remoteBranch).toBe(result.prHead);
  expect(result.pushes).toBe(0);
});

test("a checkpoint on neither the PR branch nor main starts from the branch head instead of failing", async () => {
  const result = await startScenario({
    local: [],
    push: "fails",
    hiddenCheckpoint: { runnerVersion: "0.1.67", offBranch: true },
  });
  expect(result.error, result.detail).toBeUndefined();
  expect(result.offersRestore, result.detail).toBe(false);
  expect(result.baseSha).toBe(result.prHead);
  expect(result.remoteBranch).toBe(result.prHead);
  expect(result.pushes).toBe(0);
  expect(result.thoughts).toEqual([
    `The saved work at ${result.hiddenWip!.slice(0, 8)} is on neither paws/item at ${result.prHead.slice(0, 8)} nor main, so this run continues from ${result.prHead.slice(0, 8)} and the agent redoes the rest.\n`,
  ]);
});

test("a runner older than the hidden checkpoint release gets a run command without restoreCheckpoint", async () => {
  const result = await startScenario({ local: [], push: "works", runnerVersion: "0.1.66" });
  expect(result.error, result.detail).toBeUndefined();
  expect(result.offersRestore).toBe(false);
  expect(result.baseSha).toBe(result.prHead);
});

test("a hidden checkpoint lookup that fails retries instead of starting without the saved work", async () => {
  const result = await startScenario({
    local: [],
    push: "works",
    hiddenCheckpoint: { runnerVersion: "0.1.67", lookup: "fails" },
  });
  expect((result.error as Error | undefined)?.name, result.detail).toBe("CheckpointLookupFailed");
  expect(isTransient(result.error)).toBe(true);
  expect(result.baseSha).toBeUndefined();
  expect(result.head).toBe(result.prHead);
  expect(result.pushes).toBe(0);
});

test("a runner too old to restore a hidden-ref checkpoint is refused before Paws checks it out", async () => {
  const result = await startScenario({
    local: [],
    push: "works",
    hiddenCheckpoint: { runnerVersion: "0.1.66" },
  });
  expect(String(result.error)).toContain("fixture: excluded after failed attempt");
  expect(result.baseSha).toBeUndefined();
  expect(result.head).toBe(result.prHead);
  expect(result.remoteBranch).toBe(result.prHead);
  expect(result.pushes).toBe(0);
});

async function startScenario(input: {
  local: string[];
  push: "works" | "fails";
  pushError?: string;
  mergeMain?: true;
  moveDuringPush?: true;
  earlierWip?: true;
  cancelFirstRun?: true;
  fetch?: "fails";
  defaultBranch?: string;
  prBranch?: false;
  /** The first attempt fails after the fallback, before any runner gets the command. */
  failFirstDispatch?: true;
  /** Paws saved the fallback and stopped before it moved the candidate ref. */
  stoppedBeforeReset?: true;
  hiddenCheckpoint?: {
    runnerVersion: string;
    rebasedOnEarlierMain?: true;
    lookup?: "fails";
    offBranch?: true;
  };
  runnerVersion?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-start-commit-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  // The item's commits are made in a scratch checkout; Paws holds them in the bare mirror only.
  const worktree = join(root, "worktree");
  const mirror = join(root, "repos", "acme", "fixture.git");
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
  async function commit(directory: string, message: string) {
    writeFileSync(join(directory, `${message.replaceAll(" ", "-")}.txt`), `${message}\n`);
    await git(["-C", directory, "add", "."]);
    await git(["-C", directory, "commit", "-m", message]);
  }
  await git(["init", "-b", input.defaultBranch ?? "main", source]);
  await commit(source, "Fixture");
  await git(["clone", "--bare", source, origin]);
  const base = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["clone", origin, worktree]);
  await git(["-C", worktree, "checkout", "-b", BRANCH]);
  await commit(worktree, "On the PR branch");
  if (input.prBranch !== false)
    await git(["-C", worktree, "push", origin, `HEAD:refs/heads/${BRANCH}`]);
  const prHead = await git(["-C", worktree, "rev-parse", "HEAD"]);
  // Commits Paws fetched from the runner whose push to GitHub was refused.
  for (const message of input.local) await commit(worktree, message);
  const earlierWip = await git(["-C", worktree, "rev-parse", "HEAD~1"]);
  if (input.mergeMain) {
    await commit(source, "Already on GitHub");
    await git(["-C", source, "push", origin, "HEAD:refs/heads/main"]);
    await git(["-C", worktree, "fetch", origin, "main"]);
    await git(["-C", worktree, "merge", "--no-edit", "FETCH_HEAD"]);
  }
  const localHead = await git(["-C", worktree, "rev-parse", "HEAD"]);
  await git(["clone", "--bare", origin, mirror]);
  const adopt = () => git(["--git-dir", mirror, "fetch", worktree, `+HEAD:${REF}`]);
  await adopt();
  let hiddenWip: string | undefined;
  let earlierMain: string | undefined;
  let movedMain: string | undefined;
  if (input.hiddenCheckpoint) {
    const other = join(root, "other");
    await git(["clone", origin, other]);
    if (input.hiddenCheckpoint.rebasedOnEarlierMain) {
      await git(["-C", other, "checkout", "--detach", base]);
      await commit(other, "Earlier main");
      earlierMain = await git(["-C", other, "rev-parse", "HEAD"]);
      await git(["-C", other, "push", origin, "HEAD:refs/heads/main"]);
      await commit(other, "Rebased branch work");
    } else if (input.hiddenCheckpoint.offBranch) {
      await git(["-C", other, "checkout", "--orphan", "rewritten"]);
      await commit(other, "Branch work before the rebase");
    } else await git(["-C", other, "checkout", "--detach", prHead]);
    await commit(other, "Save work in progress so far");
    hiddenWip = await git(["-C", other, "rev-parse", "HEAD"]);
    await git(["-C", other, "push", origin, `HEAD:refs/paws/checkpoints/${BRANCH}`]);
    if (earlierMain) {
      await git(["-C", other, "checkout", "--detach", earlierMain]);
      await commit(other, "Moved main");
      movedMain = await git(["-C", other, "rev-parse", "HEAD"]);
      await git(["-C", other, "push", origin, "HEAD:refs/heads/main"]);
      await git(["--git-dir", mirror, "fetch", origin, "+refs/heads/main:refs/heads/main"]);
      await git(["--git-dir", mirror, "update-ref", "refs/paws/upstream-main", movedMain]);
    }
  }

  // GitHub, served from the bare repository; a refused push fails like the 403s did.
  let pushes = 0;
  const networkGit = async (args: string[]) => {
    if (
      input.hiddenCheckpoint?.lookup === "fails" &&
      args.some((arg) => arg.includes("refs/paws/checkpoints/"))
    )
      throw new Error("fatal: unable to access GitHub: The requested URL returned error: 502");
    if (input.fetch === "fails" && args.includes("fetch"))
      throw new Error("fatal: unable to access GitHub: The requested URL returned error: 502");
    if (args.includes("push")) {
      pushes++;
      if (pushes === 1 && input.moveDuringPush) {
        await commit(worktree, "Concurrent commit");
        await adopt();
      }
      if (input.push === "fails")
        throw new Error(input.pushError ?? "remote: Permission denied (403)");
    }
    return git(args.map((arg) => (arg === GITHUB_URL ? origin : arg)));
  };

  const db = migratedDatabase(join(root, "paws.db"));
  const now = Date.now();
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
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
  const enrollment = { name: "fixture", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: (
      await control.createEnrollment(
        { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now, teamIds: [] },
        enrollment,
      )
    ).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  if (input.hiddenCheckpoint || input.runnerVersion)
    db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
      runnerId,
      input.hiddenCheckpoint?.runnerVersion ?? input.runnerVersion!,
      now,
    ]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session", branchName: BRANCH });
  const { run } = beginImplementRun(db, item.id, now);
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, { owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
  // Paws recorded the last fetched commit as the item's head.
  saveCheckpoint(db, item.id, {
    phase: "running",
    baseSha: base,
    wipCommit:
      hiddenWip ?? (input.stoppedBeforeReset ? prHead : input.earlierWip ? earlierWip : localHead),
    ...(hiddenWip && earlierMain ? { checkpointMain: { sha: hiddenWip, main: earlierMain } } : {}),
    ...(input.stoppedBeforeReset
      ? {
          lostCommits: `Your commits after ${prHead.slice(0, 8)} didn't reach GitHub: ${[...input.local].reverse().join("; ")}. Redo them.`,
        }
      : {}),
  });
  mkdirSync(join(root, "runs"), { recursive: true });

  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ store: sqliteDb(db) }),
    async fetchCandidate(candidate) {
      await git([
        "--git-dir",
        candidate.mirror,
        "update-ref",
        candidate.ref,
        candidate.candidateSha,
      ]);
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });

  let assigned: Extract<RunnerCommand, { type: "run" }> | undefined;
  let pendingAtAssignment: string | undefined;
  let executions = 0;
  const sim = { stopped: false };
  const runner = (async () => {
    while (!sim.stopped) {
      await work.heartbeat(runnerId);
      for (const envelope of await work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (command.type !== "run" || assigned) continue;
        assigned = command;
        pendingAtAssignment = getWorkItem(db, item.id)?.checkpoint?.lostCommits;
        executions++;
        const cancelled = input.cancelFirstRun === true && executions === 1;
        await work.acknowledge(runnerId, command.id);
        const grant = await work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        });
        await results.submit({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: grant.token,
          result: {
            executionId: workspaceId(),
            commandId: command.id,
            role: "implementer",
            stopReason: cancelled ? "cancelled" : "end_turn",
            timedOut: false,
            cancelled,
            authRequired: false,
            agentExited: true,
            // The runner starts from the assigned commit and finishes there.
            ...(cancelled ? {} : { candidateSha: command.repository.baseSha }),
            identity: { session: `session-${command.id}`, model: "fixture", provider: "fixture" },
          },
        });
      }
      await Bun.sleep(5);
    }
  })();

  const thoughts: string[] = [];
  let error: unknown;
  let retried = false;
  let pendingBetween: string | undefined;
  try {
    for (
      let attempt = 0;
      attempt < (input.failFirstDispatch || input.cancelFirstRun ? 2 : 1);
      attempt++
    ) {
      if (attempt) {
        pendingBetween = getWorkItem(db, item.id)?.checkpoint?.lostCommits;
        assigned = undefined;
      }
      error = undefined;
      await backend
        .forItem(item.id)({
          ...(input.failFirstDispatch && !retried
            ? {
                async prepareInputFiles() {
                  retried = true;
                  throw new Error("Paws stopped before dispatch");
                },
              }
            : {}),
          role: "implementer",
          itemId: item.id,
          runId: run.id,
          prompt: "Write output",
          worktreePath: join(root, "workspace"),
          pawsRoot: root,
          profile: { agent: "claude", model: null },
          networkGit,
          signal: new AbortController().signal,
          onEvent(event: AcpEvent) {
            if (
              event.type === "progress" &&
              (event.text.includes("GitHub") || event.text.includes("saved work"))
            )
              thoughts.push(event.text);
          },
        })
        .catch((caught: unknown) => {
          error = caught;
        });
    }
    const stored = getWorkItem(db, item.id);
    return {
      error,
      base,
      head: await git(["--git-dir", mirror, "rev-parse", REF]),
      prHead,
      localHead,
      pushes,
      thoughts,
      baseSha: assigned?.repository.baseSha,
      restoreCheckpoint: assigned?.restoreCheckpoint,
      offersRestore: assigned ? "restoreCheckpoint" in assigned : undefined,
      mainSha: assigned?.repository.mainSha,
      hiddenWip,
      earlierMain,
      movedMain,
      prompt: assigned?.prompt,
      remoteBranch: await git(["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`]).catch(
        () => undefined,
      ),
      state: stored?.state,
      wipCommit: stored?.checkpoint?.wipCommit,
      pendingBetween,
      pendingAtAssignment,
      pendingAfter: stored?.checkpoint?.lostCommits,
      detail: JSON.stringify({
        prHead,
        localHead,
        pushes,
        thoughts,
        assigned,
        error: String(error),
      }),
    };
  } finally {
    sim.stopped = true;
    await runner;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
