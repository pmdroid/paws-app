import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  applyWorkItemEvent,
  markRun,
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  bindOnboardingIntake,
  ensureLinearSession,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  getWorkItem,
  releaseRunCapacity,
  syncWorkspaceMember,
} from "../src/db";
import { attachOrchestrator, type GitHubBinding } from "../src/loop";
import { systemClock } from "../src/core";
import { createFakeTracker } from "../src/linear";
import { createRunnerPlacement } from "../src/runner-placement";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerResults } from "../src/runner-results";
import {
  createOnboardingExecution,
  createWorkspaceAssignments,
  type OnboardingAgents,
} from "../src/workspace";
import type { OnboardingAdmission } from "../src/db";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const repository = {
  owner: "acme",
  repo: "repo",
  remoteUrl: "https://github.com/acme/repo.git",
};
function fixture(
  options: {
    code?: boolean;
    access?: Parameters<typeof createOnboardingExecution>[0]["access"];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-execution-admission-"));
  const db = openDatabase(join(root, "state.sqlite"));
  migrate(db);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let now = Date.now();
  db.run("INSERT INTO workspace VALUES('w','org','Workspace',?)", [now]);
  for (const id of ["member", "other"]) {
    putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@example.invalid` });
    syncWorkspaceMember(db, {
      workspaceId: "w",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  const spec = {
    linearIssueId: "issue",
    identifier: "TEST-1",
    title: "Task",
    description: "Fixture",
    subIssues: [],
  };
  ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "member" });
  const installation = {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  };
  recordLinearInstallation(db, installation);
  db.run(
    "INSERT INTO workspace_assignment VALUES('session',0,'w','member','hash',?,'{}',?,'accepted')",
    [JSON.stringify({ installation, spec }), now + 600000],
  );
  const item = insertQueuedItem(db, {
    id: "item",
    now,
    sessionKey: "session",
  });
  db.run("UPDATE work_item SET linear_issue_id='issue' WHERE id=?", [item.id]);
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "member" });
  beginImplementRun(db, item.id, now);
  for (const [id, owner] of [
    ["own", "member"],
    ["extra", "member"],
    ["shared", "other"],
  ]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'w',?,?,'active',?,?)",
      [id!, owner!, id!, now, now],
    );
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,1)", [id!]);
    db.run(
      "INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES(?,?,?,'fixture',?,?,?)",
      [id!, id!, id!, now - 1, now + 3600000, now + 3600000],
    );
    for (const agent of ["claude", "codex"])
      db.run(
        "INSERT INTO runner_member_account(runner_id,user_id,agent,connected,updated_at) VALUES(?,?,?,1,?)",
        [id!, owner!, agent, now],
      );
  }
  db.run(
    "INSERT INTO member_vm(id,workspace_id,user_id,provider_name,step,state,create_outcome,runner_id,origin_session_id,origin_generation,created_at,updated_at) VALUES('vm','w','member','paws-fixture','ready','ready','created','own','session',0,?,?)",
    [now, now],
  );
  const admission: OnboardingAdmission = {
    sessionId: "session",
    generation: 0,
    workspaceId: "w",
    userId: "member",
    linearUserId: "member",
    issueId: "issue",
    issueFingerprint: JSON.stringify(spec),
    revision: 1,
    fingerprint: "admission",
    mode: options.code ? "code" : "answer",
    repositoryContext: options.code === true,
    repository: options.code ? repository : null,
    permission: options.code ? "push" : null,
    runnerId: "own",
    runnerFence: 0,
  };
  db.run("INSERT INTO onboarding_readiness VALUES('session',0,1,'fixture','admission','{}',?)", [
    now + 600000,
  ]);
  bindOnboardingIntake(db, admission, [{ id: item.id, linearIssueId: "issue" }], () => {});
  const assignments = createWorkspaceAssignments({
    db,
    origin: "https://fixture.invalid",
    clientId: "client",
    onboarding: {},
    memberships: {
      async installation() {
        return { id: "org", name: "Fixture" };
      },
      async member() {
        throw new Error("No external membership");
      },
    },
    tracker: createFakeTracker([spec]),
    lifecycle: {
      async inspect() {
        throw new Error("No dispatch");
      },
      async startCodeIssue() {
        throw new Error("No credentials");
      },
    },
    async accept() {
      return false;
    },
    async continue() {
      throw new Error("No dispatch");
    },
    now: () => now,
  });
  let healthAt = now;
  const agents: OnboardingAgents = {
    login: {
      list: (principal, runnerId) => ({
        accounts: (["claude", "codex"] as const).map((agent) => ({
          agent,
          connected:
            db
              .query<{ connected: number }, [string, string, string]>(
                "SELECT connected FROM runner_member_account WHERE runner_id=? AND user_id=? AND agent=?",
              )
              .get(runnerId, principal.userId, agent)?.connected === 1,
          updatedAt: 1,
          session: null,
        })),
      }),
      start() {
        throw new Error("No login");
      },
      async browser() {
        throw new Error("No login");
      },
    },
    health: {
      agents: () =>
        (["claude", "codex"] as const).map((agent) => ({
          agent,
          status: "signed_in",
          checkedAt: healthAt,
        })),
    },
  };
  const guard = createOnboardingExecution({
    db,
    assignments,
    agents,
    now: () => now,
    ...(options.access ? { access: options.access } : {}),
  });
  let boundary = 0;
  let mutate: (() => void) | undefined;
  let atBoundary = 0;
  const issue = {
    id: "issue",
    teamId: "team",
    assigneeId: "other",
    delegateId: "app",
    stateType: "started",
    projectId: "project",
  };
  const afterRead = () => {
    boundary++;
    if (boundary === atBoundary) mutate?.();
  };
  const placement = createRunnerPlacement({
    db,
    onboarding: guard,
    now: () => now,
    lifecycle: {
      async inspect() {
        afterRead();
        return issue;
      },
      async startCodeIssue() {
        throw new Error("No credentials");
      },
    },
    tracker: {
      async listProjectMembers() {
        afterRead();
        return ["member", "other"];
      },
    },
  });
  const request = (role: "implementer" | "reviewer" = "implementer") => ({
    itemId: item.id,
    profile: { agent: "codex" as const, model: "model" },
    role,
    purpose: "work" as const,
  });
  return {
    root,
    db,
    item,
    admission,
    guard,
    assignments,
    agents,
    placement,
    request,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    stale() {
      healthAt = now - 600000;
    },
    race(n: number, action: () => void) {
      atBoundary = n;
      mutate = action;
    },
    flip(name: string) {
      if (name === "vm") db.run("UPDATE member_vm SET runner_id='extra'");
      if (name === "stop") db.run("UPDATE linear_session SET stopped_at=?", [now]);
      if (name === "generation") db.run("UPDATE linear_session SET generation=generation+1");
      if (name === "member")
        db.run("UPDATE workspace_member SET role='observer' WHERE user_id='member'");
      if (name === "health") healthAt = now - 600000;
    },
  };
}

test("execution capture preserves unbound paths and pins exact VM member and fence", () => {
  const f = fixture();
  expect(f.guard.capture("unbound")).toBeNull();
  expect(createOnboardingExecution({ db: f.db }).capture.bind(null, f.item.id)).toThrow();
  expect(() => f.guard.capture(f.item.id, { runnerId: "shared" })).toThrow();
  expect(() => f.guard.capture(f.item.id, { memberId: "other" })).toThrow();
  expect(() => f.guard.capture(f.item.id, { workspaceId: "elsewhere" })).toThrow();
  const captured = f.guard.capture(f.item.id)!;
  f.db.run("UPDATE runner SET fence=1 WHERE id='own'");
  expect(() => captured.assertCurrent()).toThrow();
});
for (const role of ["implementer", "reviewer"] as const) {
  test(`both personal agents gate ${role} placement`, async () => {
    const f = fixture();
    expect(await f.placement.candidates(f.request(role))).toEqual([
      { id: "own", workspaceId: "w", memberId: "member" },
    ]);
    f.db.run(
      "UPDATE runner_member_account SET connected=0 WHERE runner_id='own' AND agent='claude'",
    );
    await expect(f.placement.candidates(f.request(role))).rejects.toThrow();
    f.db.run(
      "UPDATE runner_member_account SET connected=1 WHERE runner_id='own' AND agent='claude'",
    );
    f.stale();
    await expect(f.placement.candidates(f.request(role))).rejects.toThrow();
  });
}
for (const boundary of [1, 2, 3])
  for (const change of ["vm", "stop", "generation", "member", "health"]) {
    test(`${change} during placement await ${boundary} refuses admission`, async () => {
      const f = fixture();
      f.race(boundary, () => f.flip(change));
      await expect(f.placement.candidates(f.request())).rejects.toThrow();
      expect(f.db.query("SELECT count(*) AS count FROM runner_execution_usage").get()).toEqual({
        count: 0,
      });
    });
  }
for (const change of ["vm", "stop", "generation", "member", "health"]) {
  test(`${change} before started refuses assignment usage`, async () => {
    const f = fixture();
    await f.placement.candidates(f.request());
    f.flip(change);
    expect(() =>
      f.placement.started({
        ...f.request(),
        runnerId: "own",
        commandId: "command",
        startedAt: f.now(),
      }),
    ).toThrow();
    expect(f.db.query("SELECT count(*) AS count FROM runner_execution_usage").get()).toEqual({
      count: 0,
    });
  });
}

for (const prepareOnly of [true, false])
  for (const change of ["vm", "stop", "generation", "member", "health"]) {
    test(`backend ${prepareOnly ? "probe" : "assignment"} denies ${change} after selection`, async () => {
      const f = fixture();
      const work = createRunnerWork({
        db: f.db,
        keyId: "fixture",
        privateKey: generateKeyPairSync("ed25519").privateKey,
        now: f.now,
      });
      let reached = false;
      const backend = createRemoteAgentRunner({
        db: f.db,
        work,
        health: createRunnerHealth({ db: f.db, work, now: f.now }),
        results: createRunnerResults({ db: f.db, work, now: f.now }),
        now: f.now,
        onboarding: f.guard,
        transcripts: {
          async download() {
            throw new Error("No transcript");
          },
        },
        async fetchCandidate() {
          throw new Error("No credential");
        },
        placement: {
          ...f.placement,
          async candidates(input) {
            const rows = await f.placement.candidates(input);
            reached = true;
            f.flip(change);
            return rows;
          },
        },
      });
      await expect(
        backend.forItem(f.item.id)({
          profile: { agent: "codex" as const, model: "model" },
          role: "implementer",
          itemId: f.item.id,
          runId: "display",
          prompt: "Fixture",
          worktreePath: f.root,
          pawsRoot: f.root,
          prepareOnly,
          readOnly: true,
        }),
      ).rejects.toThrow();
      expect(reached).toBe(true);
      expect(f.db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual({
        count: 0,
      });
      expect(f.db.query("SELECT count(*) AS count FROM runner_work").get()).toEqual({ count: 0 });
    });
  }

for (const boundary of ["scope", "preparation", "assignment"] as const)
  for (const change of ["vm", "stop", "generation", "member", "health"]) {
    test(`backend rechecks ${change} at ${boundary} side-effect fence`, async () => {
      const f = fixture();
      const work = createRunnerWork({
        db: f.db,
        keyId: "fixture",
        privateKey: generateKeyPairSync("ed25519").privateKey,
        now: f.now,
      });
      let reached = false;
      let selections = 0;
      const mutate = () => {
        reached = true;
        f.flip(change);
      };
      const backend = createRemoteAgentRunner({
        db: f.db,
        onboarding: f.guard,
        now: f.now,
        work: {
          ...work,
          scopeTask(...args) {
            const scope = work.scopeTask(...args);
            if (boundary === "scope") mutate();
            return scope;
          },
        },
        health: createRunnerHealth({ db: f.db, work, now: f.now }),
        results: createRunnerResults({ db: f.db, work, now: f.now }),
        transcripts: {
          async download() {
            throw new Error("No transcript");
          },
        },
        async fetchCandidate() {
          throw new Error("No credential");
        },
        placement: {
          ...f.placement,
          async candidates(input) {
            const candidates = await f.placement.candidates(input);
            selections++;
            if (boundary === "assignment" && selections === 2) mutate();
            return candidates;
          },
        },
      });
      await expect(
        backend.forItem(f.item.id)({
          profile: { agent: "codex", model: "model" },
          role: "implementer",
          itemId: f.item.id,
          runId: "display",
          prompt: "Fixture",
          worktreePath: f.root,
          pawsRoot: f.root,
          prepareOnly: boundary === "scope",
          readOnly: true,
          async prepareInputFiles() {
            if (boundary === "preparation") mutate();
            return { prompt: "Fixture", inputFiles: [] };
          },
        }),
      ).rejects.toThrow();
      expect(reached).toBe(true);
      expect(f.db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual({
        count: 0,
      });
      expect(f.db.query("SELECT count(*) AS count FROM runner_work").get()).toEqual({ count: 0 });
    });
  }

test("bound backend refuses its unguarded SQL fallback", async () => {
  const f = fixture();
  const work = createRunnerWork({
    db: f.db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: f.now,
  });
  const backend = createRemoteAgentRunner({
    db: f.db,
    onboarding: f.guard,
    work,
    transcripts: {
      async download() {
        throw new Error("No transcript");
      },
    },
    health: createRunnerHealth({ db: f.db, work }),
    results: createRunnerResults({ db: f.db, work }),
    async fetchCandidate() {
      throw new Error("No credentials");
    },
  });
  await expect(
    backend.forItem(f.item.id)({
      profile: { agent: "codex", model: null },
      role: "implementer",
      itemId: f.item.id,
      runId: "display",
      prompt: "Fixture",
      worktreePath: f.root,
      pawsRoot: f.root,
      prepareOnly: true,
    }),
  ).rejects.toThrow("guarded placement");
  expect(f.db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual({ count: 0 });
});

test("bound admission refuses missing guard dependencies, expiry and ownership cutover", async () => {
  const f = fixture();
  const placement = createRunnerPlacement({
    db: f.db,
    lifecycle: {
      async inspect() {
        throw new Error("must refuse before await");
      },
      async startCodeIssue() {
        throw new Error("No dispatch");
      },
    },
    tracker: {},
  });
  await expect(placement.candidates(f.request())).rejects.toThrow("unavailable");
  const captured = f.guard.capture(f.item.id)!;
  f.advance(600000);
  expect(() => captured.assertCurrent()).toThrow();
  f.advance(-600000);
  f.db.run("UPDATE runner SET owner_user_id='other' WHERE id='own'");
  expect(() => f.guard.capture(f.item.id)).toThrow();
});

for (const prepareOnly of [true, false])
  for (const change of ["vm", "stop", "generation", "member", "health"]) {
    test(`transaction rolls back ${prepareOnly ? "probe" : "assignment"} when ${change} changes at enqueue`, async () => {
      const f = fixture();
      const work = createRunnerWork({
        db: f.db,
        keyId: "fixture",
        privateKey: generateKeyPairSync("ed25519").privateKey,
        now: f.now,
      });
      let reached = false;
      const backend = createRemoteAgentRunner({
        db: f.db,
        onboarding: f.guard,
        now: f.now,
        placement: f.placement,
        work: {
          ...work,
          enqueue(command) {
            const result = work.enqueue(command);
            reached = true;
            f.flip(change);
            return result;
          },
          assign(command) {
            const result = work.assign(command);
            reached = true;
            f.flip(change);
            return result;
          },
        },
        health: createRunnerHealth({ db: f.db, work }),
        results: createRunnerResults({ db: f.db, work }),
        transcripts: {
          async download() {
            throw new Error("No transcript");
          },
        },
        async fetchCandidate() {
          throw new Error("No credentials");
        },
      });
      await expect(
        backend.forItem(f.item.id)({
          profile: { agent: "codex", model: "model" },
          role: "implementer",
          itemId: f.item.id,
          runId: "display",
          prompt: "Fixture",
          worktreePath: f.root,
          pawsRoot: f.root,
          prepareOnly,
          readOnly: true,
        }),
      ).rejects.toThrow();
      expect(reached).toBe(true);
      expect(f.db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual({
        count: 0,
      });
      expect(f.db.query("SELECT count(*) AS count FROM runner_work").get()).toEqual({ count: 0 });
    });
  }

test("ended current run invalidates capture and started admission without usage", async () => {
  const f = fixture();
  const captured = f.guard.capture(f.item.id)!;
  await f.placement.candidates(f.request());
  const runId = getWorkItem(f.db, f.item.id)!.currentRunId!;
  releaseRunCapacity(f.db, runId, f.now());
  expect(getWorkItem(f.db, f.item.id)!.currentRunId).toBe(runId);
  expect(() => f.guard.capture(f.item.id)).toThrow();
  expect(() => captured.assertCurrent()).toThrow();
  expect(() =>
    f.placement.started({
      ...f.request(),
      runnerId: "own",
      commandId: "ended-command",
      startedAt: f.now(),
    }),
  ).toThrow();
  expect(f.db.query("SELECT count(*) AS count FROM runner_execution_usage").get()).toEqual({
    count: 0,
  });
});

test("ending current run before prepare-only transaction cannot enqueue its probe", async () => {
  const f = fixture();
  const work = createRunnerWork({
    db: f.db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: f.now,
  });
  let ended = false;
  let scopes = 0;
  const backend = createRemoteAgentRunner({
    db: f.db,
    onboarding: f.guard,
    now: f.now,
    placement: f.placement,
    work: {
      ...work,
      scopeTask(...args) {
        const scope = work.scopeTask(...args);
        if (++scopes === 2) {
          releaseRunCapacity(f.db, getWorkItem(f.db, f.item.id)!.currentRunId!, f.now());
          ended = true;
        }
        return scope;
      },
    },
    health: createRunnerHealth({ db: f.db, work, now: f.now }),
    results: createRunnerResults({ db: f.db, work, now: f.now }),
    transcripts: {
      async download() {
        throw new Error("No transcript");
      },
    },
    async fetchCandidate() {
      throw new Error("No credentials");
    },
  });
  await expect(
    backend.forItem(f.item.id)({
      profile: { agent: "codex", model: "model" },
      role: "implementer",
      itemId: f.item.id,
      runId: "display",
      prompt: "Fixture",
      worktreePath: f.root,
      pawsRoot: f.root,
      prepareOnly: true,
      readOnly: true,
    }),
  ).rejects.toThrow();
  expect(ended).toBe(true);
  expect(f.db.query("SELECT count(*) AS count FROM runner_command").get()).toEqual({ count: 0 });
  expect(f.db.query("SELECT count(*) AS count FROM runner_execution_usage").get()).toEqual({
    count: 0,
  });
});

test("current run ownership and live status are part of execution authority", () => {
  const f = fixture();
  const runId = getWorkItem(f.db, f.item.id)!.currentRunId!;
  const captured = f.guard.capture(f.item.id)!;
  f.db.run("UPDATE run SET status='provisioning' WHERE id=?", [runId]);
  expect(() => captured.assertCurrent()).toThrow();
  expect(f.guard.capture(f.item.id)).not.toBeNull();
  const other = insertQueuedItem(f.db, { id: "foreign-item", now: f.now() });
  f.db.run("UPDATE run SET item_id=? WHERE id=?", [other.id, runId]);
  expect(() => f.guard.capture(f.item.id)).toThrow();
});

function memberAccess(states: ("ready" | "denied" | "missing_link" | "unavailable")[]) {
  const checks: string[] = [];
  return {
    checks,
    access: {
      async check(itemId: string) {
        checks.push(itemId);
        return {
          state: states[Math.min(checks.length, states.length) - 1]!,
          reason: "permission" as const,
          account: { id: 1, login: "member" },
          repository: "acme/repo",
          permission: "push" as const,
        };
      },
    },
  };
}
const signal = () => new AbortController().signal;

test("unbound repository credentials keep their path without member checks", async () => {
  const member = memberAccess(["denied"]);
  const f = fixture({ code: true, access: member.access });
  expect(
    await f.guard.authorizeRepository("unbound", repository, "write", signal(), async () => "app"),
  ).toBe("app");
  expect(
    await createOnboardingExecution({ db: f.db }).authorizeRepository(
      "unbound",
      repository,
      "read",
      signal(),
      async () => "app",
    ),
  ).toBe("app");
  expect(member.checks).toEqual([]);
});

test("bound repository credentials need fresh member access before and after the mint", async () => {
  const member = memberAccess(["ready", "ready"]);
  const f = fixture({ code: true, access: member.access });
  let mints = 0;
  expect(
    await f.guard.authorizeRepository(f.item.id, repository, "write", signal(), async () => {
      mints++;
      expect(member.checks).toEqual([f.item.id]);
      return "app";
    }),
  ).toBe("app");
  expect(mints).toBe(1);
  expect(member.checks).toEqual([f.item.id, f.item.id]);
});

for (const state of ["denied", "missing_link", "unavailable"] as const)
  test(`bound repository credentials refuse ${state} member access without minting`, async () => {
    const member = memberAccess([state]);
    const f = fixture({ code: true, access: member.access });
    let mints = 0;
    await expect(
      f.guard.authorizeRepository(f.item.id, repository, "read", signal(), async () => {
        mints++;
        return "app";
      }),
    ).rejects.toThrow("Member GitHub repository access is not ready.");
    expect(mints).toBe(0);
  });

test("bound repository credentials are discarded when member access changes during the mint", async () => {
  const member = memberAccess(["ready", "denied"]);
  const f = fixture({ code: true, access: member.access });
  await expect(
    f.guard.authorizeRepository(f.item.id, repository, "write", signal(), async () => "app"),
  ).rejects.toThrow("Member GitHub repository access is not ready.");
  expect(member.checks).toHaveLength(2);
});

test("bound repository credentials refuse authority changes during the mint", async () => {
  const member = memberAccess(["ready", "ready"]);
  const f = fixture({ code: true, access: member.access });
  await expect(
    f.guard.authorizeRepository(f.item.id, repository, "write", signal(), async () => {
      f.flip("vm");
      return "app";
    }),
  ).rejects.toThrow();
  expect(member.checks).toHaveLength(1);
});

test("bound repository credentials refuse other repositories, missing access and repository-free modes", async () => {
  const member = memberAccess(["ready"]);
  const mint = async () => {
    throw new Error("minted");
  };
  const f = fixture({ code: true, access: member.access });
  await expect(
    f.guard.authorizeRepository(
      f.item.id,
      { ...repository, repo: "other" },
      "read",
      signal(),
      mint,
    ),
  ).rejects.toThrow("Onboarding repository authority changed.");
  await expect(
    createOnboardingExecution({
      db: f.db,
      assignments: f.assignments,
      agents: f.agents,
      now: f.now,
    }).authorizeRepository(f.item.id, repository, "read", signal(), mint),
  ).rejects.toThrow("Member repository access is unavailable.");
  await expect(
    createOnboardingExecution({ db: f.db }).authorizeRepository(
      f.item.id,
      repository,
      "read",
      signal(),
      mint,
    ),
  ).rejects.toThrow("Onboarding execution context changed.");
  const answer = fixture({ access: member.access });
  await expect(
    answer.guard.authorizeRepository(answer.item.id, repository, "read", signal(), mint),
  ).rejects.toThrow("Onboarding repository authority changed.");
  expect(member.checks).toEqual([]);
});

test("readonly production startup owns a run before selecting its repository", async () => {
  const f = fixture({
    code: true,
    access: memberAccess(["ready", "ready"]).access,
  });
  const binding = { ...f.admission, mode: "answer", permission: "read" };
  f.db.run("UPDATE onboarding_item_binding SET snapshot=?", [JSON.stringify(binding)]);
  f.db.run("UPDATE work_item_task SET mode='answer' WHERE item_id=?", [f.item.id]);
  f.db.run("UPDATE work_item SET state='running',current_run_id=NULL WHERE id=?", [f.item.id]);
  let mints = 0;
  const runtime = attachOrchestrator({
    db: f.db,
    jobs: new JobLoop(f.db, systemClock),
    outbox: new OutboxDispatcher(f.db, systemClock),
    pawsRoot: f.root,
    linearTaskModes: true,
    repositoryAccess: (repo, ownedSignal, access, item) =>
      f.guard.authorizeRepository(item!.id, repo, access!, ownedSignal, async () => {
        mints++;
        return true;
      }),
  });
  const entry = runtime as unknown as {
    executeQueued(payload: unknown): Promise<void>;
    runResponse(item: unknown): Promise<void>;
  };
  let responses = 0;
  entry.runResponse = async () => {
    responses++;
    expect(getWorkItem(f.db, f.item.id)!.currentRunId).not.toBeNull();
  };
  try {
    await entry.executeQueued({ itemId: f.item.id });
    expect(mints).toBe(1);
    expect(responses).toBe(1);
  } finally {
    await runtime.shutdown();
  }
});

for (const change of [
  "none",
  "stop",
  "generation",
  "member",
  "run",
  "operation",
  "during_mint",
] as const)
  test(`ended-run publication is guarded by its owned operation: ${change}`, async () => {
    const f = fixture({
      code: true,
      access: memberAccess(["ready", "ready"]).access,
    });
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    markRun(f.db, getWorkItem(f.db, f.item.id)!.currentRunId!, "ended", f.now());
    expect(() => f.guard.capture(f.item.id)).toThrow();
    let current = true;
    const operation = {
      signal: new AbortController().signal,
      assertCurrent() {
        if (!current) throw new Error("Operation changed");
      },
    };
    let mints = 0;
    const task = f.guard.authorizePublicationRepository(
      f.item.id,
      repository,
      "write",
      new AbortController().signal,
      async () => {
        mints++;
        if (change === "during_mint") f.flip("stop");
        return "credential";
      },
      {
        ...operation,
        assertCurrent() {
          operation.assertCurrent();
          if (change === "stop" || change === "generation" || change === "member") f.flip(change);
          if (change === "run")
            f.db.run("UPDATE work_item SET current_run_id=NULL WHERE id=?", [f.item.id]);
          if (change === "operation") {
            current = false;
            operation.assertCurrent();
          }
        },
      },
    );
    if (change === "none") {
      expect(await task).toBe("credential");
      expect(mints).toBe(1);
    } else {
      await expect(task).rejects.toThrow();
      expect(mints).toBe(change === "during_mint" ? 1 : 0);
    }
  });

test("publication transport receives current owned operation and fences supersession", async () => {
  const f = fixture({ code: true, access: memberAccess(["ready", "ready"]).access });
  applyWorkItemEvent(f.db, f.item.id, "turn_ended");
  applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
  markRun(f.db, getWorkItem(f.db, f.item.id)!.currentRunId!, "ended", f.now());
  let mints = 0;
  const runtime = attachOrchestrator({
    db: f.db,
    jobs: new JobLoop(f.db, systemClock),
    outbox: new OutboxDispatcher(f.db, systemClock),
    pawsRoot: f.root,
    githubForRepository: (_repository, item, operation) => ({
      appId: "fixture",
      installationId: "fixture",
      privateKeyPem: "fixture",
      client: {
        request: async () => {
          throw new Error("No external API");
        },
      },
      tokenProvider: {
        mode: "app",
        tokenFor: () =>
          f.guard.authorizePublicationRepository(
            item!.id,
            repository,
            "write",
            signal(),
            async () => {
              mints++;
              return "credential";
            },
            operation!,
          ),
      },
    }),
  });
  const entry = runtime as unknown as {
    runOwnedJob(payload: unknown, operation: () => Promise<void>): Promise<void>;
    githubForRepository(repo: typeof repository, item: { id: string }): GitHubBinding;
  };
  try {
    await entry.runOwnedJob({ itemId: f.item.id }, async () => {
      const token = entry.githubForRepository(repository, f.item).tokenProvider!;
      expect(await token.tokenFor("merge")).toBe("credential");
      f.db.run("UPDATE work_item SET version=version+1 WHERE id=?", [f.item.id]);
      await expect(token.tokenFor("merge")).rejects.toThrow();
      expect(mints).toBe(1);
    });
  } finally {
    await runtime.shutdown();
  }
});

for (const states of [["denied"], ["ready", "denied"]] as const)
  test(`publication checks member access on both sides of mint: ${states.join("-")}`, async () => {
    const member = memberAccess([...states]);
    const f = fixture({ code: true, access: member.access });
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    markRun(f.db, getWorkItem(f.db, f.item.id)!.currentRunId!, "ended", f.now());
    let mints = 0;
    await expect(
      f.guard.authorizePublicationRepository(
        f.item.id,
        repository,
        "write",
        signal(),
        async () => {
          mints++;
          return "credential";
        },
        { signal: signal(), assertCurrent() {} },
      ),
    ).rejects.toThrow();
    expect(mints).toBe(states.length - 1);
    expect(() => f.guard.capture(f.item.id)).toThrow();
  });

for (const change of [
  "none",
  "version",
  "run",
  "session",
  "stop",
  "lease",
  "operation",
  "post_version",
] as const)
  test(`owned accepted reverify advances publication authority without accepting external ${change}`, async () => {
    const f = fixture({ code: true, access: memberAccess(["ready"]).access });
    applyWorkItemEvent(f.db, f.item.id, "turn_ended");
    applyWorkItemEvent(f.db, f.item.id, "closeout_accepted");
    markRun(f.db, getWorkItem(f.db, f.item.id)!.currentRunId!, "ended", f.now());
    const lease = new AbortController();
    let mints = 0;
    const runtime = attachOrchestrator({
      db: f.db,
      jobs: new JobLoop(f.db, systemClock),
      outbox: new OutboxDispatcher(f.db, systemClock),
      pawsRoot: f.root,
      remoteExecution: { agentForItem: () => undefined } as unknown as NonNullable<
        Parameters<typeof attachOrchestrator>[0]["remoteExecution"]
      >,
      githubForRepository: (_repo, item, operation) => ({
        appId: "fixture",
        installationId: "fixture",
        privateKeyPem: "fixture",
        client: {
          request: async () => {
            throw new Error("No API");
          },
        },
        tokenProvider: {
          mode: "app",
          tokenFor: () =>
            f.guard.authorizePublicationRepository(
              item!.id,
              repository,
              "write",
              signal(),
              async () => {
                mints++;
                return "credential";
              },
              operation!,
            ),
        },
      }),
    });
    const entry = runtime as unknown as {
      runOwnedJob(payload: unknown, task: () => Promise<void>): Promise<void>;
      runLeasedJob(
        payload: unknown,
        context: { signal: AbortSignal; isCurrent(): boolean },
        task: () => Promise<void>,
      ): Promise<void>;
      githubForRepository(repo: typeof repository, item: { id: string }): GitHubBinding;
      runVerification(
        item: NonNullable<ReturnType<typeof getWorkItem>>,
        worktree: string,
        base: string,
        head: string,
        candidate: typeof identity,
      ): Promise<{ decision: string }>;
      verifyCandidate(): Promise<{ decision: string; summary: string }>;
      saveCandidate(runId: string, candidate: typeof identity): void;
      live: Map<string, unknown>;
    };
    const identity = { agent: "codex", model: "model", session: "fixture" };
    entry.saveCandidate(getWorkItem(f.db, f.item.id)!.currentRunId!, identity);
    entry.verifyCandidate = async () => {
      if (change === "version")
        f.db.run("UPDATE work_item SET version=version+1 WHERE id=?", [f.item.id]);
      if (change === "run")
        f.db.run("UPDATE work_item SET current_run_id=NULL WHERE id=?", [f.item.id]);
      if (change === "session") f.flip("generation");
      if (change === "stop") f.flip("stop");
      if (change === "lease") lease.abort(new Error("Lease revoked"));
      if (change === "operation") entry.live.delete(`operation:${f.item.id}`);
      return { decision: "accepted", summary: "fixture" };
    };
    let tested = false;
    const task = entry.runLeasedJob(
      { itemId: f.item.id },
      { signal: lease.signal, isCurrent: () => !lease.signal.aborted },
      () =>
        entry.runOwnedJob({ itemId: f.item.id }, async () => {
          const before = getWorkItem(f.db, f.item.id)!;
          const token = entry.githubForRepository(repository, before).tokenProvider!;
          expect(await token.tokenFor("push")).toBe("credential");
          if (change === "none" || change === "post_version") {
            expect(
              (await entry.runVerification(before, f.root, "base", "head", identity)).decision,
            ).toBe("accepted");
            const after = getWorkItem(f.db, f.item.id)!;
            expect(after.version).toBe(before.version + 2);
            expect(after.currentRunId).not.toBe(before.currentRunId);
            expect(after.state).toBe("merge_queue");
            expect(() => f.guard.capture(f.item.id)).toThrow();
            if (change === "post_version")
              f.db.run("UPDATE work_item SET version=version+1 WHERE id=?", [f.item.id]);
            if (change === "none") {
              expect(await token.tokenFor("merge")).toBe("credential");
              expect(
                (await entry.runVerification(before, f.root, "base2", "head2", identity)).decision,
              ).toBe("accepted");
              expect(await token.tokenFor("merge")).toBe("credential");
            } else await expect(token.tokenFor("merge")).rejects.toThrow();
          } else {
            await expect(
              entry.runVerification(before, f.root, "base", "head", identity),
            ).rejects.toThrow();
            await expect(token.tokenFor("merge")).rejects.toThrow();
          }
          expect(mints).toBe(change === "none" ? 3 : 1);
          tested = true;
        }),
    );
    try {
      if (change === "lease") await expect(task).rejects.toThrow("Lease revoked");
      else await task;
      expect(tested).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
