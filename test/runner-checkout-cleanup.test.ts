import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createRunnerWorkCleaner } from "../src/runner-execution";
import { WORK_ROOT_CLEANUP_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { openRunnerRuntime } from "../src/runner-runtime";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";

const CURRENT = WORK_ROOT_CLEANUP_RUNNER_VERSION.join(".");

async function tornDownRun(state: string, runnerVersion = CURRENT) {
  const root = mkdtempSync(join(tmpdir(), "paws-checkout-cleanup-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  const now = Date.now();
  try {
    migrate(db);
    const userId = putWorkspaceUser(db, {
      id: "me",
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = consumeWorkspaceBootstrap(db, {
      id: "ws",
      organizationId: "org",
      name: "Test",
      userId,
      tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
      now,
    });
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box',?,?,'box','active',?,?)",
      [workspace.id, userId, now, now],
    );
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
    const command: Extract<RunnerCommand, { type: "run" }> = {
      id: "work-1",
      type: "run",
      runnerId: "box",
      workspaceId: workspace.id,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 600_000,
      repository,
      profile: { agent: "claude", model: null },
      prompt: "Implement the issue",
    };
    const keys = generateKeyPairSync("ed25519");
    const work = createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    });
    await work.assign(command);
    await work.acknowledge("box", command.id);
    db.run("UPDATE work_item SET state=? WHERE id=?", [state, item.id]);
    const reply = await work.heartbeat(
      "box",
      1,
      { runnerVersion },
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [{ runId: run.id, generation: 1, commandId: command.id }],
    );
    const workRoot = join(root, "work");
    const checkout = join(workRoot, run.id);
    mkdirSync(checkout, { recursive: true });
    await createRunnerWorkCleaner({ workRoot, holds: () => new Set() }).released(
      reply.finishedRuns ?? [],
    );
    return { reply, kept: existsSync(checkout) };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("after a confirmed teardown", () => {
  for (const state of ["merged", "cancelled", "failed", "completed"])
    test(`a ${state} item's checkout is deleted`, async () => {
      const { kept } = await tornDownRun(state);
      expect(kept).toBe(false);
    });

  for (const state of ["awaiting_input", "merge_queue", "paused"])
    test(`a checkout whose item is ${state} can still resume and is kept`, async () => {
      const { reply, kept } = await tornDownRun(state);
      expect(reply.finishedRuns).toBeUndefined();
      expect(kept).toBe(true);
    });

  test("an older runner is not sent a field its strict reply schema refuses", async () => {
    const { reply } = await tornDownRun("merged", "0.1.74");
    expect(reply).not.toHaveProperty("finishedRuns");
  });
});

test("the runtime passes the runs Paws names on a heartbeat to its cleaner", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-checkout-cleanup-runtime-"));
  const named: (readonly string[])[] = [];
  const runtime = await openRunnerRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    broker: {
      start: async () => ({ alreadyAdmitted: false }),
      stop: async () => {},
    },
    onFinishedRuns: (runIds) => named.push(runIds),
    daemon: {
      status: () => ({
        phase: "paired" as const,
        runnerId: "runner",
        workspaceId: "workspace",
        fingerprint: "fixture",
        expiresAt: Date.now() + 3_600_000,
      }),
      heartbeat: async () => ({ leases: [], fenced: [], finishedRuns: ["run-over"] }),
      pollCommands: async () => ({ commands: [], rejected: [], deniedRepositories: [] }),
      pendingCommands: () => [],
      acknowledgeCommand: async () => {},
      issueRunGrant: async () => ({ token: "", expiresAt: 0 }),
      sendEvent: async () => ({ duplicate: false }),
      answers: async () => ({ answers: [] }),
      postResult: async () => ({ duplicate: false }),
      repositoryCredential: async () => {
        throw new Error("Unexpected repository access");
      },
      renewCertificate: async () => {
        throw new Error("Unexpected renewal");
      },
      uploadTranscript: async () => {
        throw new Error("Unexpected transcript");
      },
      finishTranscript: async () => {
        throw new Error("Unexpected transcript");
      },
      uploadArtifact: async () => ({ ok: true }),
    },
  });
  try {
    await runtime.tick();
    expect(named[0]).toEqual(["run-over"]);
    expect(runtime.holds()).toEqual([]);
  } finally {
    await runtime.stop();
    await Bun.sleep(0);
    rmSync(root, { recursive: true, force: true });
  }
});
