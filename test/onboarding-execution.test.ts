import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
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
function fixture() {
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
  db.run("INSERT INTO onboarding_vm VALUES('session',0,'own',0,?)", [now]);
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
    mode: "answer",
    repositoryContext: false,
    repository: null,
    permission: null,
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
  const guard = createOnboardingExecution({ db, assignments, agents, now: () => now });
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
      if (name === "vm") db.run("UPDATE onboarding_vm SET runner_id='extra'");
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
