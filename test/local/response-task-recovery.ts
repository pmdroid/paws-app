import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  beginImplementRun,
  getRun,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listArtifacts,
  listJobs,
  listOutbox,
  markArtifact,
  migrate,
  openDatabase,
  OutboxDispatcher,
  prepareShutdown,
  recoverOnStartup,
  saveArtifact,
  saveConversation,
  saveTaskMode,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { Orchestrator } from "../../src/loop";

export async function probeResponseTaskRecovery(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const mode of ["answer", "artifact"] as const) {
    const home = join(root, mode);
    mkdirSync(home, { mode: 0o700 });
    const path = join(home, "paws.db");
    let db = openDatabase(path);
    migrate(db);
    const clock = new FakeClock(1000);
    const item = insertQueuedItem(db, { id: `item-${mode}`, sessionKey: `session-${mode}` });
    const { run } = beginImplementRun(db, item.id, clock.now());
    saveTaskMode(db, item.id, mode);
    saveConversation(
      db,
      item.id,
      JSON.stringify([{ kind: "request", body: "The user answered: use the Create VM page." }]),
      null,
    );
    if (mode === "artifact") {
      saveArtifact(
        db,
        {
          id: "published-screenshot",
          itemId: item.id,
          runId: run.id,
          path: "screenshot.png",
          displayName: "Create VM",
          mimeType: "image/png",
          sizeBytes: 3,
          sha256: "a".repeat(64),
          state: "pending",
          assetUrl: null,
        },
        clock.now(),
      );
      markArtifact(db, "published-screenshot", "https://files.example.test/screenshot.png");
    }
    prepareShutdown(db, clock.now());
    assert.equal(getWorkItem(db, item.id)?.checkpoint, null);
    db.close();
    db = openDatabase(path);
    const jobs = new JobLoop(db, clock);
    const tracePath = join(home, "agent-trace.json");
    const script = join(home, "agent-script.json");
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Completed the requested Create VM response." },
            },
          },
          { type: "end" },
        ],
      }),
    );
    let launches = 0;
    const orchestrator = new Orchestrator({
      db,
      jobs,
      clock,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: home,
      home,
      tracker: createFakeTracker(),
      linearTaskModes: true,
      channel: "agent-session",
      launch: () => {
        launches++;
        return {
          command: process.execPath,
          args: [
            resolve(import.meta.dir, "../../src/acp/testing/fake-agent.ts"),
            tracePath,
            script,
          ],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
        };
      },
    });
    try {
      assert.deepEqual(recoverOnStartup(db, clock.now()), [
        { type: "resume", freshSession: true, checkpoint: null },
      ]);
      assert.equal(getWorkItem(db, item.id)?.recoveryAttempts, 1);
      assert.equal(getRun(db, run.id)?.status, "active");
      assert.equal(
        listJobs(db).filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
          .length,
        1,
      );
      await jobs.tick();
      assert.equal(getWorkItem(db, item.id)?.state, "completed");
      assert.equal(getWorkItem(db, item.id)?.checkpoint, null);
      assert.equal(launches, 1);
      const trace = JSON.parse(readFileSync(tracePath, "utf8"));
      assert.match(JSON.stringify(trace.prompts), /The user answered: use the Create VM page/);
      const responses = listOutbox(db)
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === "response");
      assert.equal(responses.length, 1);
      assert.match(String(responses[0]!.body), /Completed the requested Create VM response/);
      if (mode === "artifact") {
        assert.equal(listArtifacts(db, item.id).length, 1);
        assert.equal(listArtifacts(db, item.id)[0]?.state, "uploaded");
        assert.match(String(responses[0]!.body), /https:\/\/files.example.test\/screenshot.png/);
      }
      assert.deepEqual(recoverOnStartup(db, clock.now()), []);
      observations.push({
        mode,
        passed: true,
        launches,
        state: "completed",
        gitCheckpoint: null,
        priorAnswerPreserved: true,
        publishedArtifacts: listArtifacts(db, item.id).length,
      });
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  }
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  return observations;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Pass a disposable evidence directory");
  console.log(JSON.stringify(await probeResponseTaskRecovery(root)));
}
