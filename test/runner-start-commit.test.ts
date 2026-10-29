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

test("the fallback and its handoff are saved before the worktree moves", async () => {
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
    const saved: unknown[] = [];
    const pending = ensureStartOnRemote({
      worktree,
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
    expect(await git(["-C", worktree, "rev-parse", "HEAD"])).toBe(head);
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

for (const mutation of ["dirtyDuringPush", "moveDuringPush"] as const)
  test(`fallback preserves a concurrent worktree change: ${mutation}`, async () => {
    const result = await startScenario({ local: ["Lost one"], push: "fails", [mutation]: true });
    expect(result.error, result.detail).toBeInstanceOf(RemoteStartUnverified);
    expect(result.baseSha).toBeUndefined();
    if (mutation === "dirtyDuringPush") {
      expect(result.head).toBe(result.localHead);
      expect(result.fileAfter).toBe("Uncommitted work");
    } else expect(result.head).not.toBe(result.prHead);
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

async function startScenario(input: {
  local: string[];
  push: "works" | "fails";
  pushError?: string;
  mergeMain?: true;
  dirtyDuringPush?: true;
  moveDuringPush?: true;
  earlierWip?: true;
  cancelFirstRun?: true;
  fetch?: "fails";
  defaultBranch?: string;
  prBranch?: false;
  /** The first attempt fails after the fallback, before any runner gets the command. */
  failFirstDispatch?: true;
  /** Paws saved the fallback and stopped before it reset the worktree. */
  stoppedBeforeReset?: true;
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-start-commit-"));
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

  // GitHub, served from the bare repository; a refused push fails like the 403s did.
  let pushes = 0;
  const networkGit = async (args: string[]) => {
    if (input.fetch === "fails" && args.includes("fetch"))
      throw new Error("fatal: unable to access GitHub: The requested URL returned error: 502");
    if (args.includes("push")) {
      pushes++;
      if (pushes === 1 && input.dirtyDuringPush)
        writeFileSync(join(worktree, "Lost-one.txt"), "Uncommitted work");
      if (pushes === 1 && input.moveDuringPush) await commit(worktree, "Concurrent commit");
      if (input.push === "fails")
        throw new Error(input.pushError ?? "remote: Permission denied (403)");
    }
    return git(args.map((arg) => (arg === GITHUB_URL ? origin : arg)));
  };

  const db = migratedDatabase(join(root, "paws.db"));
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
  const enrollment = { name: "fixture", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: control.createEnrollment(
      { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now, teamIds: [] },
      enrollment,
    ).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session", branchName: BRANCH });
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
  // Paws recorded the last fetched commit as the item's head.
  saveCheckpoint(db, item.id, {
    phase: "running",
    baseSha: base,
    wipCommit: input.stoppedBeforeReset ? prHead : input.earlierWip ? earlierWip : localHead,
    ...(input.stoppedBeforeReset
      ? {
          lostCommits: `Your commits after ${prHead.slice(0, 8)} didn't reach GitHub: ${[...input.local].reverse().join("; ")}. Redo them.`,
        }
      : {}),
  });
  mkdirSync(join(root, "runs"), { recursive: true });

  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ db }),
    async fetchCandidate(candidate) {
      await git(["-C", candidate.worktree, "reset", "--hard", candidate.candidateSha]);
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
      work.heartbeat(runnerId);
      for (const envelope of work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (command.type !== "run" || assigned) continue;
        assigned = command;
        pendingAtAssignment = getWorkItem(db, item.id)?.checkpoint?.lostCommits;
        executions++;
        const cancelled = input.cancelFirstRun === true && executions === 1;
        work.acknowledge(runnerId, command.id);
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
          worktreePath: worktree,
          pawsRoot: root,
          profile: { agent: "claude", model: null },
          networkGit,
          signal: new AbortController().signal,
          onEvent(event: AcpEvent) {
            if (event.type === "progress" && event.text.includes("GitHub"))
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
      head: await git(["-C", worktree, "rev-parse", "HEAD"]),
      prHead,
      localHead,
      pushes,
      thoughts,
      baseSha: assigned?.repository.baseSha,
      prompt: assigned?.prompt,
      remoteBranch: await git(["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`]).catch(
        () => undefined,
      ),
      state: stored?.state,
      wipCommit: stored?.checkpoint?.wipCommit,
      pendingBetween,
      pendingAtAssignment,
      fileAfter: await Bun.file(join(worktree, "Lost-one.txt"))
        .text()
        .catch(() => undefined),
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
