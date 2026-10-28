import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AcpEvent } from "../src/acp";
import { PawsShutdown } from "../src/core";
import {
  beginImplementRun,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  openDatabase,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  saveTaskMode,
} from "../src/db";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import { RUNNER_LEASE_GRACE_MS, type RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const ANSWER = "Before the restart. After the restart.";
const TRANSCRIPT = Buffer.from(
  `${JSON.stringify({
    event: {
      type: "session_update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ANSWER } },
    },
  })}\n`,
);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-response-restart-"));
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
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
  saveTaskMode(db, item.id, "answer");
  const worktree = join(root, "task");
  mkdirSync(worktree);

  const keys = generateKeyPairSync("ed25519");
  let downloads = 0;
  function open() {
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
    const results = createRunnerResults({ db, work });
    const backend = createRemoteAgentRunner({
      db,
      work,
      results,
      health: createRunnerHealth({ db, work }),
      placement: createRunnerPlacement({ db }),
      pollIntervalMs: 5,
      async fetchCandidate() {
        throw new Error("A response task has no candidate");
      },
      transcripts: {
        async download() {
          downloads++;
          return TRANSCRIPT;
        },
      },
    });
    return { work, results, backend };
  }
  let services = open();

  // The runner keeps heartbeating and acknowledging while Paws restarts.
  const tasks: Extract<RunnerCommand, { type: "task" }>[] = [];
  const sim = { stopped: false, paused: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      if (!sim.paused) {
        const { work } = services;
        work.heartbeat(runnerId);
        for (const envelope of work.commands(runnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          work.acknowledge(runnerId, command.id);
          if (command.type === "task") tasks.push(command);
        }
      }
      await Bun.sleep(5);
    }
  })();

  const events: AcpEvent[] = [];
  const options = (signal: AbortSignal) => ({
    role: "implementer" as const,
    itemId: item.id,
    runId: run.id,
    prompt: "Answer the question",
    worktreePath: worktree,
    pawsRoot: root,
    profile: { agent: "claude" as const, model: null },
    readOnly: true,
    checkpoint: false as const,
    signal,
    onEvent(event: AcpEvent) {
      events.push(event);
    },
  });
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 2_000 && !ready(); i++) await Bun.sleep(5);
    if (!ready()) throw new Error("Timed out");
  };
  const commandCount = (kind?: string) =>
    db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM runner_command WHERE ?1='' OR kind=?1",
      )
      .get(kind ?? "")!.count;
  const consumed = () =>
    db
      .query<{ sequence: number }, [string]>(
        "SELECT consumed_sequence AS sequence FROM runner_work WHERE run_id=?",
      )
      .get(run.id)?.sequence ?? 0;

  return {
    runnerId,
    item,
    run,
    tasks,
    sim,
    events,
    options,
    until,
    commandCount,
    consumed,
    downloads: () => downloads,
    get db() {
      return db;
    },
    get services() {
      return services;
    },
    say(command: Extract<RunnerCommand, { type: "task" }>, sequence: number, text: string) {
      services.work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: services.work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        }).token,
        sequence,
        event: {
          type: "activity",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    },
    finish(command: Extract<RunnerCommand, { type: "task" }>) {
      return services.results.submit({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: services.work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        }).token,
        result: {
          executionId: workspaceId(),
          commandId: command.id,
          role: "implementer",
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
          identity: { session: `session-${command.id}`, model: "fixture", provider: "fixture" },
        },
      });
    },
    restart() {
      sim.paused = true;
      db.close();
      db = openDatabase(path);
      services = open();
      sim.paused = false;
    },
    async close() {
      sim.stopped = true;
      await runner;
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const messages = (events: AcpEvent[]) =>
  events.flatMap((event) => (event.type === "progress" && event.messageChunk ? [event.text] : []));

test("an answer task mid-turn keeps running through a Paws restart and finishes once", async () => {
  const f = await fixture();
  try {
    const shutdown = new AbortController();
    const first = f.services.backend
      .forItem(f.item.id)(f.options(shutdown.signal))
      .then(
        () => null,
        (error: unknown) => error,
      );
    await f.until(() => f.tasks.length === 1);
    const command = f.tasks[0]!;
    f.say(command, 1, "Before the restart.");
    await f.until(() => f.consumed() === 1);
    shutdown.abort(new PawsShutdown());
    expect(await first).not.toBeNull();
    expect(f.commandCount("cancel")).toBe(0);

    prepareShutdown(f.db);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    expect(getRun(f.db, f.run.id)?.status).toBe("active");
    f.restart();
    expect(recoverOnStartup(f.db)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    expect(
      listJobs(f.db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toHaveLength(1);

    const commands = f.commandCount();
    f.events.length = 0;
    const resumed = f.services.backend.forItem(f.item.id)(f.options(new AbortController().signal));
    f.say(command, 2, "After the restart.");
    expect(f.finish(command)).toEqual({ duplicate: false });
    const result = await resumed;

    expect(result).toMatchObject({ stopReason: "end_turn", agentExited: true });
    // The resume read on from the consumed event, on the same command.
    expect(f.tasks).toHaveLength(1);
    expect(f.commandCount()).toBe(commands);
    expect(messages(f.events)).toEqual(["After the restart."]);
    const answers = f.events.filter(
      (event) =>
        event.type === "session_update" &&
        event.update.sessionUpdate === "agent_message_chunk" &&
        event.update.content.type === "text" &&
        event.update.content.text === ANSWER,
    );
    expect(answers).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "prompt_complete")).toHaveLength(1);
    expect(f.downloads()).toBe(1);
    expect(
      f.db
        .query<{ endedAt: number | null }, [string]>(
          "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=?",
        )
        .get(f.run.id)?.endedAt,
    ).not.toBeNull();
    expect(f.db.query("SELECT 1 FROM runner_result WHERE run_id=?").all(f.run.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("an answer task whose runner lease ran past its grace resumes from the start", async () => {
  const f = await fixture();
  try {
    const shutdown = new AbortController();
    const first = f.services.backend
      .forItem(f.item.id)(f.options(shutdown.signal))
      .then(
        () => null,
        (error: unknown) => error,
      );
    await f.until(() => f.tasks.length === 1);
    shutdown.abort(new PawsShutdown());
    expect(await first).not.toBeNull();
    expect(f.commandCount("cancel")).toBe(0);

    const later = Date.now() + 60_001 + RUNNER_LEASE_GRACE_MS;
    prepareShutdown(f.db, later);
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("recovering");
    f.restart();
    expect(recoverOnStartup(f.db, later)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ recoveryAttempts: 1 });
  } finally {
    await f.close();
  }
}, 60_000);
