import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, runAgent, validateCandidateAttribution } from "../../src/acp";
import { commitPolicyMessage, policyCoauthors, policyPullRequestCredit } from "../../src/core";
import {
  beginGitHubAttribution,
  beginImplementRun,
  bindLinearSessionTask,
  consumeGitHubAttribution,
  getItemRunCommitPolicy,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  revokeGitHubAttribution,
  saveGitHubAttribution,
  saveRunCommitPolicy,
  syncWorkspaceMember,
} from "../../src/db";
import { createLinearAttributionReads, createLinearClient } from "../../src/linear";
import { FakeHostGitHubAuth, GitHubAuthQuestions } from "../../src/loop";
import { signRunnerCommand, verifyRunnerCommand } from "../../src/runner-protocol";
import { createCommitPolicyForItem, issueWorkspaceSession } from "../../src/workspace";

export async function probeStandaloneAttribution(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations: string[] = [];
  const now = Date.now();
  const dbPath = join(root, "paws.db");
  const db = openDatabase(dbPath);
  migrate(db);
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',?)", [now]);
  putWorkspaceUser(db, {
    id: "steerer",
    linearUserId: "steerer",
    name: "Task Steerer",
    email: "steerer@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "workspace",
    userId: "steerer",
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const session = issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "steerer",
    now,
  });
  const binding = {
    workspaceId: "workspace",
    userId: "steerer",
    sessionHash: session.session.tokenHash,
  };
  const consent = () => {
    const stateHash = randomUUID();
    beginGitHubAttribution(db, binding, { stateHash, browserHash: stateHash, now });
    const revision = consumeGitHubAttribution(db, binding, {
      stateHash,
      browserHash: stateHash,
      now,
    });
    saveGitHubAttribution(
      db,
      binding,
      {
        id: 8,
        login: "steerer",
        name: "Task Steerer",
        email: "8+steerer@users.noreply.github.com",
      },
      revision,
      now,
    );
  };
  const item = insertQueuedItem(db, { id: "item", sessionKey: "session", now });
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "steerer" });
  const { run } = beginImplementRun(db, item.id, now);
  let project: { id: string; lead: null } | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { variables: { id: string } };
      assert.equal(body.variables.id, item.linearIssueId);
      return Response.json({
        data: {
          viewer: { app: true, organization: { id: "org" } },
          issue: { id: item.linearIssueId, team: { id: "team" }, project },
        },
      });
    },
  });
  const tracker = createLinearAttributionReads(
    createLinearClient({
      auth: {
        ensureFresh: async () => "synthetic",
        forceRefresh: async () => "synthetic",
        hasToken: () => true,
      },
      fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}`, init),
    }),
  );
  const memberships: string[] = [];
  const policyForItem = createCommitPolicyForItem({
    db,
    bot: { appId: "99", id: 88, login: "paws-test[bot]" },
    clientId: "client",
    tracker,
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => {
        memberships.push(userId);
        return {
          organizationId,
          userId,
          active: true,
          guest: false,
          admin: false,
          teamIds: ["team"],
        };
      },
    },
  });
  let legacyConsentHold = true;
  const auth = new GitHubAuthQuestions(
    db,
    Object.assign(new FakeHostGitHubAuth(), {
      integration: {
        check: async () => true,
        identity: () => "workspace-repository",
        administrators: () => [],
        recoveryUrl: "https://paws.example/status/#/settings/account",
        attributionReady: async (current: typeof item) => {
          if (legacyConsentHold) return false;
          await policyForItem(current);
          return true;
        },
      },
    }),
    () => now,
  );
  try {
    const policy = await policyForItem(getWorkItem(db, item.id)!);
    assert.equal(policy.projectLead, null);
    assert.deepEqual(memberships, ["steerer"]);
    assert.equal(policyCoauthors(policy).length, 0);
    assert.equal(
      await auth.ensure(getWorkItem(db, item.id)!, "initial", new AbortController().signal),
      false,
    );
    assert.equal(getWorkItem(db, item.id)!.state, "awaiting_input");
    legacyConsentHold = false;
    await auth.recover();
    await auth.recover();
    assert.equal(getWorkItem(db, item.id)!.state, "running");
    assert.equal(listJobs(db).filter((job) => job.queue === "run.resume").length, 1);
    observations.push(
      "legacy consent hold resumes once through the production App gate without personal GitHub consent",
    );
    project = { id: "project", lead: null };
    assert.equal((await policyForItem(getWorkItem(db, item.id)!)).projectLead, null);
    project = null;
    consent();
    assert.equal(policyCoauthors(await policyForItem(getWorkItem(db, item.id)!)).length, 1);
    revokeGitHubAttribution(db, binding, now);
    assert.equal(
      await auth.ensure(getWorkItem(db, item.id)!, "initial", new AbortController().signal),
      true,
    );
    await auth.recover();
    assert.equal(getWorkItem(db, item.id)!.state, "running");
    assert.equal(listJobs(db).filter((job) => job.queue === "run.resume").length, 1);
    observations.push(
      "project leads are optional and revoking personal credit does not create an authorization hold",
    );
    saveRunCommitPolicy(db, run.id, policy);
    const reopened = openDatabase(dbPath);
    try {
      assert.deepEqual(getItemRunCommitPolicy(reopened, item.id), policy);
    } finally {
      reopened.close();
    }
    const keys = generateKeyPairSync("ed25519");
    const envelope = signRunnerCommand({
      keyId: "proof",
      privateKey: keys.privateKey,
      command: {
        id: "command",
        runnerId: "runner",
        workspaceId: "workspace",
        memberId: "steerer",
        issuedAt: now,
        expiresAt: now + 60_000,
        type: "run",
        runId: run.id,
        itemId: item.id,
        generation: 1,
        repository: {
          owner: "fixture",
          repo: "repository",
          remoteUrl: "https://github.com/fixture/repository.git",
          baseSha: "a".repeat(40),
        },
        profile: { agent: "claude", model: null },
        prompt: "Implement",
        commitPolicy: policy,
      },
    });
    const verified = verifyRunnerCommand(envelope, {
      runnerId: "runner",
      workspaceId: "workspace",
      now: now + 1,
      trustedKeys: new Map([["proof", keys.publicKey]]),
      allowedRepositories: ["fixture/repository"],
      claimCommand: () => true,
    });
    assert(verified.ok);
    observations.push(
      "standalone attribution persists across SQLite reopen and passes signed runner command validation",
    );
    const home = join(root, "home"),
      tree = join(root, "tree");
    mkdirSync(home);
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Original Human",
      GIT_AUTHOR_EMAIL: "human@example.invalid",
      GIT_COMMITTER_NAME: "Original Human",
      GIT_COMMITTER_EMAIL: "human@example.invalid",
    };
    await git(["init", "-b", "main", tree], { env });
    writeFileSync(join(tree, "base"), "ancestor");
    await git(["-C", tree, "add", "."], { env });
    await git(["-C", tree, "commit", "-m", "base"], { env });
    const base = (await git(["-C", tree, "rev-parse", "HEAD"], { env })).trim();
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_write", path: "change", content: "standalone change" },
          { type: "terminal", command: "git", args: ["add", "."] },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-m", commitPolicyMessage("standalone work", policy)],
          },
          { type: "end" },
        ],
      }),
    );
    const result = await runAgent({
      role: "implementer",
      profile: { agent: "claude", model: "fixture-model" },
      itemId: item.id,
      runId: run.id,
      worktreePath: tree,
      pawsRoot: join(root, "paws"),
      home,
      env,
      command: process.execPath,
      args: [
        resolve(import.meta.dir, "../../src/acp/testing/fake-agent.ts"),
        join(root, "acp-trace.json"),
        script,
      ],
      prompt: "Implement standalone issue",
      commitPolicy: policy,
    });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.errorMessage, undefined);
    const head = (await git(["-C", tree, "rev-parse", "HEAD"], { env })).trim();
    await validateCandidateAttribution(tree, base, head, policy, env);
    const message = await git(["-C", tree, "show", "-s", "--format=%B", head], { env });
    assert.equal(message.match(/Co-authored-by:/g)?.length ?? 0, 0);
    assert.equal(policyPullRequestCredit(policy), "");
    observations.push(
      "actual ACP commit validates App bot attribution without unconsented human commit or PR credit",
    );
    writeFileSync(
      join(root, "observations.json"),
      JSON.stringify({ observations, passed: observations.length }, null, 2) + "\n",
    );
    return observations;
  } finally {
    auth.close();
    await server.stop(true);
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  assert(root, "Supply a fresh evidence directory");
  console.log(JSON.stringify(await probeStandaloneAttribution(root)));
}
