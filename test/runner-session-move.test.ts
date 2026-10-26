import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSessions, createFakeAgentSessionObjects } from "../src/agent-sessions";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { verifyRunnerCommand, type RunnerCommand, type RunnerEvent } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

type Setup = Awaited<ReturnType<typeof setup>>;
type RunCommand = Extract<RunnerCommand, { type: "run" }>;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "paws-session-move-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const otherUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "other",
    name: "Other",
    email: "other@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-work", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "fixture-team",
  ]);
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const authority = await initializeRunnerAuthority(issuer);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
  });
  const runners: Record<"a" | "b", string> = { a: "", b: "" };
  for (const name of ["a", "b"] as const) {
    const key = await createRunnerKey(join(root, `client-${name}`));
    const pending = { name: name.toUpperCase(), csr: key.csr };
    runners[name] = (
      await control.enroll({
        ...pending,
        token: control.createEnrollment(principal, pending).token,
      })
    ).runnerId;
    db.run("UPDATE runner SET status='active' WHERE id=?", [runners[name]]);
  }
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: signing.privateKey,
    now: () => now,
  });
  const results = createRunnerResults({ db, work, now: () => now });
  const health = createRunnerHealth({ db, work, now: () => now });
  const sessions = createAgentSessions({
    db,
    work,
    objects: createFakeAgentSessionObjects(),
    key: randomBytes(32),
    now: () => now,
  });
  const source = join(root, "source");
  const run = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  run(["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "result.txt"), "base");
  run(["-C", source, "add", "."]);
  run(["-C", source, "commit", "-q", "-m", "Base"]);
  const base = run(["-C", source, "rev-parse", "HEAD"]);
  writeFileSync(join(source, "result.txt"), "candidate");
  run(["-C", source, "commit", "-q", "-am", "Candidate"]);
  const head = run(["-C", source, "rev-parse", "HEAD"]);
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    now: () => now,
    pollIntervalMs: 1,
    async fetchCandidate(candidate) {
      run(["-C", candidate.worktree, "reset", "-q", "--hard", candidate.candidateSha]);
    },
  });
  const seen = new Set<string>();
  async function next(runnerId: string) {
    for (let index = 0; index < 2000; index++) {
      for (const envelope of work.commands(runnerId)) {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now,
          allowedRepositories: ["fixture/repository"],
          claimCommand: (id) => !seen.has(id) && Boolean(seen.add(id)),
        });
        if (verified.ok) {
          work.acknowledge(runnerId, verified.command.id);
          return verified.command;
        }
      }
      await delay(1);
    }
    throw new Error("No dispatched runner command");
  }
  let sequence = 0;
  function item() {
    run(["-C", source, "reset", "-q", "--hard", base]);
    db.run(
      "UPDATE run SET status='ended' WHERE status='active' AND id IN (SELECT run_id FROM runner_work WHERE ended_at IS NOT NULL)",
    );
    const id = `item-${++sequence}`;
    const sessionKey = `session-${sequence}`;
    const record = insertQueuedItem(db, { id, now, sessionKey });
    const { run: started } = beginImplementRun(db, id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "fixture-team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, sessionKey, record.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
    bindWorkItemRepository(db, id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
    });
    return { id, runId: started.id };
  }
  /** Both runners online, restore-capable, signed in to Claude 2.1.7, owned by the delegator. */
  function reset() {
    for (const runnerId of Object.values(runners)) {
      db.run("UPDATE runner SET status='active',revoked_at=NULL,owner_user_id=? WHERE id=?", [
        userId,
        runnerId,
      ]);
      work.heartbeat(runnerId);
      db.run(
        `INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.43',?)
         ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version`,
        [runnerId, now],
      );
      db.run("DELETE FROM runner_agent_policy WHERE runner_id=?", [runnerId]);
      db.run(
        "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired) VALUES(?,'claude',1,0)",
        [runnerId],
      );
      db.run("DELETE FROM runner_agent WHERE runner_id=?", [runnerId]);
      db.run(
        "INSERT INTO runner_agent(runner_id,agent,version,status,reported_at) VALUES(?,'claude','2.1.7','current',?)",
        [runnerId, now],
      );
    }
  }
  /** A finished turn: optional runner events, then the result. */
  function finish(command: RunCommand, runnerId: string, events: RunnerEvent[] = []) {
    const grant = work.issueGrant({
      runnerId,
      runId: command.runId,
      commandId: command.id,
      generation: command.generation,
    });
    events.forEach((event, index) =>
      work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        sequence: index + 1,
        token: grant.token,
        event,
      }),
    );
    results.submit({
      runnerId,
      runId: command.runId,
      generation: command.generation,
      token: grant.token,
      result: {
        executionId: workspaceId(),
        commandId: command.id,
        role: "implementer",
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        candidateSha: head,
        sessionId: "claude-session",
        identity: { session: "claude-session", model: "model", provider: "anthropic" },
      },
    });
  }
  /** Runner A seals a snapshot of its turn through the store, as the runner uploads it. */
  async function seal(command: RunCommand) {
    const grant = work.issueGrant({
      runnerId: runners.a,
      runId: command.runId,
      commandId: command.id,
      generation: command.generation,
    });
    const access = { runnerId: runners.a, runId: command.runId, token: grant.token };
    const bundle = randomBytes(700_000);
    for (let offset = 0; offset < bundle.length; offset += 524_288) {
      const chunk = bundle.subarray(offset, offset + 524_288);
      await sessions.upload(access, {
        generation: command.generation,
        offset,
        sha256: createHash("sha256").update(chunk).digest("hex"),
        data: chunk.toString("base64"),
      });
    }
    await sessions.finish(access, {
      generation: command.generation,
      sizeBytes: bundle.length,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      agent: "claude",
      agentVersion: "2.1.7",
      sessionId: "claude-session",
      workspacePath: `/var/lib/paws-agent/work/${command.runId}`,
      commitSha: head,
      turn: command.generation,
    });
    return { bundle, generation: command.generation };
  }
  /**
   * A turn on A that seals a snapshot unless `snapshot` is false, then A goes offline and
   * `change` runs before the next turn, which `turnOnB` drives on B.
   */
  async function move(options: {
    snapshot?: boolean;
    change?: () => void;
    events?: RunnerEvent[];
    /** A stays online, so the next turn stays on it. */
    stay?: boolean;
    /** Runs while the second turn's command holds the run. */
    dispatched?: (command: RunCommand, runnerId: string) => Promise<void>;
  }) {
    reset();
    const record = item();
    const notices: string[] = [];
    const turn = () =>
      backend.forItem(record.id)({
        profile: { agent: "claude", model: "model" },
        role: "implementer",
        itemId: `display-${record.id}`,
        runId: record.runId,
        prompt: "Implement fixture",
        worktreePath: source,
        pawsRoot: root,
        networkGit: async () => "",
        onEvent(event) {
          if (event.type === "progress") notices.push(event.text);
        },
      });
    const first = turn();
    const onA = (await next(runners.a)) as RunCommand;
    const sealed = options.snapshot === false ? undefined : await seal(onA);
    finish(onA, runners.a);
    await first;
    expect(onA.restoreSession).toBeUndefined();
    notices.length = 0;
    if (!options.stay)
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 60_001, runners.a]);
    options.change?.();
    const second = turn();
    const target = options.stay ? runners.a : runners.b;
    const onB = (await next(target)) as RunCommand;
    await options.dispatched?.(onB, target);
    finish(onB, target, options.events);
    await second;
    db.run("UPDATE run SET status='ended' WHERE id=?", [record.runId]);
    return { record, onA, onB, sealed, notices };
  }
  return {
    db,
    root,
    runners,
    userId,
    otherUserId,
    head,
    sessions,
    work,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    move,
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let context: Setup;
beforeAll(async () => {
  context = await setup();
});
afterAll(() => context.cleanup());

const FALLBACK =
  "Moved this run to B because A is offline. Starting a new session from the last pushed commit: the earlier session couldn't be restored";

test("a move with an eligible snapshot sends restoreSession and posts the restored notice once", async () => {
  let read: Buffer | undefined;
  const { onB, sealed, notices } = await context.move({
    events: [{ type: "session_restore", restored: true }],
    // The new runner, holding the run's grant, reads the snapshot Paws sealed for A.
    async dispatched(command, runnerId) {
      const grant = context.work.issueGrant({
        runnerId,
        runId: command.runId,
        commandId: command.id,
        generation: command.generation,
      });
      const parts: Uint8Array[] = [];
      for await (const part of context.sessions.read(
        { runnerId, runId: command.runId, token: grant.token, generation: command.generation },
        command.restoreSession!.generation,
      ))
        parts.push(part);
      read = Buffer.concat(parts);
    },
  });
  expect(read?.equals(sealed!.bundle)).toBe(true);
  expect(onB.restoreSession).toEqual({
    generation: sealed!.generation,
    agent: "claude",
    agentVersion: "2.1.7",
    sessionId: "claude-session",
    sha256: createHash("sha256").update(sealed!.bundle).digest("hex"),
    sizeBytes: sealed!.bundle.length,
  });
  expect(onB.resumeSessionId).toBe("claude-session");
  expect(onB.repository.baseSha).toBe(context.head);
  expect(notices).toEqual([
    `Moved this run to B because A is offline. Continuing the agent's session from turn ${sealed!.generation}.\n`,
  ]);
});

test("each ineligible move falls back with its reason and no restoreSession", async () => {
  const { db, runners, otherUserId } = context;
  const cases: [string, Parameters<Setup["move"]>[0]][] = [
    ["no saved session", { snapshot: false }],
    [
      "B's runner is too old",
      {
        change: () =>
          db.run("UPDATE runner_host_status SET runner_version='0.1.42' WHERE runner_id=?", [
            runners.b,
          ]),
      },
    ],
    [
      "B is signed in to a different Claude account",
      {
        change: () =>
          db.run("UPDATE agent_session_snapshot SET owner_user_id=? WHERE status='sealed'", [
            otherUserId,
          ]),
      },
    ],
    [
      "B isn't signed in to Claude",
      {
        change: () =>
          db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id=?", [runners.b]),
      },
    ],
    [
      "B isn't signed in to Claude",
      {
        change: () =>
          db.run("UPDATE runner_agent_policy SET auth_expired=1 WHERE runner_id=?", [runners.b]),
      },
    ],
    [
      "Claude isn't installed on B",
      { change: () => db.run("DELETE FROM runner_agent WHERE runner_id=?", [runners.b]) },
    ],
  ];
  for (const [reason, options] of cases) {
    const { onB, notices } = await context.move(options);
    expect(onB.restoreSession).toBeUndefined();
    expect(onB.resumeSessionId).toBeUndefined();
    expect(notices).toEqual([`${FALLBACK} (${reason}).\n`]);
    db.run("DELETE FROM agent_session_snapshot_chunk");
    db.run("DELETE FROM agent_session_snapshot");
  }
});

test("another Claude version still restores, and a failed load names both versions", async () => {
  const { db, runners } = context;
  const { onB, notices } = await context.move({
    change: () => db.run("UPDATE runner_agent SET version='2.2.0' WHERE runner_id=?", [runners.b]),
    events: [{ type: "session_restore", restored: false, reason: "load" }],
  });
  expect(onB.restoreSession?.agentVersion).toBe("2.1.7");
  expect(notices).toEqual([
    `${FALLBACK} (the saved session didn't load: Claude 2.1.7 on A, 2.2.0 on B).\n`,
  ]);
});

test("a restore the runner could not finish falls back with the runner's reason", async () => {
  for (const [reason, text] of [
    ["integrity", "the saved session didn't match its checksum"],
    ["download", "the saved session couldn't be downloaded"],
    ["unpack", "the saved session held a file outside its session folder"],
    ["load", "the saved session didn't load"],
  ] as const) {
    const { onB, notices } = await context.move({
      events: [{ type: "session_restore", restored: false, reason }],
    });
    expect(onB.restoreSession).toBeDefined();
    expect(notices).toEqual([`${FALLBACK} (${text}).\n`]);
  }
});

test("a run that stays on its runner never sends restoreSession", async () => {
  const { onA, onB, notices } = await context.move({ stay: true });
  expect(onB.runnerId).toBe(onA.runnerId);
  expect(onA.restoreSession).toBeUndefined();
  expect(onB.restoreSession).toBeUndefined();
  expect(onB.resumeSessionId).toBe("claude-session");
  expect(notices.some((notice) => notice.startsWith("Moved this run"))).toBe(false);
});
