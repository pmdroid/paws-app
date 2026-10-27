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
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const GITHUB_URL = "https://github.com/acme/fixture.git";

test("a resumed run whose branch tip on GitHub is ahead of its checkpoint starts from the tip", async () => {
  const result = await scenario({ branch: "ahead" });
  expect(result.assignedBase).toBe(result.tip);
  expect(result.checkpoint?.wipCommit).toBe(result.tip);
  expect(result.notices).toEqual([]);
}, 60_000);

test("a branch tip that does not descend from the checkpoint is noted and the run starts from the checkpoint", async () => {
  const result = await scenario({ branch: "diverged" });
  expect(result.assignedBase).toBe(result.checkpointSha);
  expect(result.checkpoint?.wipCommit).toBe(result.checkpointSha);
  expect(result.notices).toEqual([
    expect.stringContaining(
      `is at ${result.tip.slice(0, 7)}, which does not descend from the checkpoint ${result.checkpointSha.slice(0, 7)}`,
    ),
  ]);
}, 60_000);

test("a first run with no branch on GitHub starts from its checkpoint without a notice", async () => {
  const result = await scenario({});
  expect(result.assignedBase).toBe(result.checkpointSha);
  expect(result.notices).toEqual([]);
}, 60_000);

test("a candidate that conflicts with its branch on GitHub goes to a conflict round without a question", async () => {
  const result = await scenario({ branch: "ahead", conflict: true, conflictRound: true });
  expect(result.asked).toEqual([]);
  expect(result.finished.candidateConflict).toEqual({
    branch: result.branchName,
    error: "commit abc1234 conflicts",
  });
}, 60_000);

test("a second conflict in a row asks the team instead", async () => {
  const result = await scenario({ branch: "ahead", conflict: true, conflictRound: false });
  expect(result.asked).toEqual([expect.stringContaining("Paws could not push the candidate")]);
  expect(result.finished.candidateConflict).toBeUndefined();
}, 60_000);

async function scenario(input: {
  branch?: "ahead" | "diverged";
  conflict?: boolean;
  conflictRound?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-branch-tip-"));
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
    const child = Bun.spawn(
      ["/usr/bin/git", ...args.map((arg) => (arg === GITHUB_URL ? origin : arg))],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out.trim();
  }
  async function commit(file: string) {
    writeFileSync(join(source, file), `${file}\n`);
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "commit", "-m", file]);
    return git(["-C", source, "rev-parse", "HEAD"]);
  }
  await git(["init", "-b", "main", source]);
  const base = await commit("README.md");
  await git(["clone", "--bare", source, origin]);

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
      { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
      enrollment,
    ).token,
  });
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
  const branchName = getWorkItem(db, item.id)!.branchName;

  // The checkpoint an earlier turn left in Paws' worktree.
  const checkpointSha = await commit("checkpoint.txt");
  await git(["-C", source, "push", origin, `HEAD:refs/heads/checkpoint`]);
  await git(["clone", origin, worktree]);
  await git(["-C", worktree, "reset", "--hard", checkpointSha]);
  saveCheckpoint(db, item.id, { phase: "running", baseSha: base, wipCommit: checkpointSha });
  // A later turn's head that reached GitHub before the run restarted.
  if (input.branch === "diverged") await git(["-C", source, "reset", "--hard", base]);
  const tip = input.branch ? await commit("earlier-turn.txt") : checkpointSha;
  if (input.branch) await git(["-C", source, "push", origin, `HEAD:refs/heads/${branchName}`]);
  if (input.branch === "diverged") await git(["-C", source, "reset", "--hard", checkpointSha]);
  const candidateSha = await commit("candidate.txt");
  await git(["-C", source, "push", origin, "HEAD:refs/heads/candidate"]);

  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
  const results = createRunnerResults({ db, work });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health: createRunnerHealth({ db, work }),
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ db }),
    async fetchCandidate(candidate) {
      await git(["-C", candidate.worktree, "fetch", origin, candidate.candidateSha]);
      await git(["-C", candidate.worktree, "reset", "--hard", candidate.candidateSha]);
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });

  let assignedBase: string | undefined;
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      work.heartbeat(runnerId);
      for (const envelope of work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        work.acknowledge(runnerId, command.id);
        if (command.type !== "run") continue;
        assignedBase = command.repository.baseSha;
        const grant = work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        });
        const result: RunnerResult = input.conflict
          ? {
              executionId: workspaceId(),
              commandId: command.id,
              role: "implementer",
              stopReason: "error",
              timedOut: false,
              cancelled: false,
              authRequired: false,
              agentExited: true,
              errorMessage: "The runner stopped this run.",
              pushFailure: {
                branch: branchName,
                error: "commit abc1234 conflicts",
                conflict: true,
              },
            }
          : {
              executionId: workspaceId(),
              commandId: command.id,
              role: "implementer",
              stopReason: "end_turn",
              timedOut: false,
              cancelled: false,
              authRequired: false,
              agentExited: true,
              candidateSha,
              identity: { session: `session-${command.id}`, model: "fixture", provider: "fixture" },
            };
        results.submit({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: grant.token,
          result,
        });
      }
      await Bun.sleep(5);
    }
  })();

  const notices: string[] = [];
  const asked: string[] = [];
  try {
    const finished = await backend.forItem(item.id)({
      role: "implementer",
      itemId: item.id,
      runId: run.id,
      prompt: "Write output",
      worktreePath: worktree,
      pawsRoot: root,
      profile: { agent: "claude", model: null },
      networkGit: git,
      signal: new AbortController().signal,
      onEvent(event: AcpEvent) {
        if (event.type === "progress" && event.text.includes("on GitHub")) notices.push(event.text);
      },
      askTeam: {
        async ask(request) {
          asked.push(request.question);
          return { answer: "ok" };
        },
      },
      ...(input.conflictRound !== undefined ? { conflictRound: () => input.conflictRound! } : {}),
    });
    return {
      finished,
      assignedBase,
      tip,
      checkpointSha,
      branchName,
      notices,
      asked,
      checkpoint: getWorkItem(db, item.id)?.checkpoint,
    };
  } finally {
    sim.stopped = true;
    await runner;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
