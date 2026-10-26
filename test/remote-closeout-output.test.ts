import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";
import { loggedSessionCloseout, writeSessionCloseout, readSessionCloseout } from "../src/closeout";
import { RunnerResultSchema } from "../src/runner-protocol";
import {
  appendCloseoutOutput,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  insertQueuedItem,
  beginImplementRun,
  markRun,
  applyWorkItemEvent,
  saveCheckpoint,
  migrate,
  openDatabase,
  upsertCloseoutStep,
} from "../src/db";
import { createLiveStatusProvider } from "../src/web/src/live/provider";

test("remote session output survives result transport, persistence and the live status API", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-remote-output-"));
  const db = openDatabase(":memory:");
  try {
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Test"],
      ["config", "user.email", "test@example.invalid"],
    ])
      expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      join(root, ".agents/closeout.yaml"),
      `specVersion: "0.1"\nitems:\n  - id: output\n    kind: command\n    gate: beforePR\n    exec: ${JSON.stringify([process.execPath, "-e", 'console.log("actual remote stdout"); console.error("actual remote stderr"); await Bun.sleep(40); process.exit(1)'])}\n    timeoutSeconds: 30\n`,
    );
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "candidate"], { cwd: root }).status).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();
    expect(
      spawnSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: root }).status,
    ).toBe(0);
    writeFileSync(join(root, "changed.txt"), "changed");
    const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
    await session.run("output");
    const transported = RunnerResultSchema.parse(
      JSON.parse(
        JSON.stringify({
          executionId: "01J00000000000000000000001",
          commandId: "command",
          role: "implementer",
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
          candidateSha: head,
          closeoutReport: await session.report(),
        }),
      ),
    );
    const path = join(root, "session.json");
    writeSessionCloseout(path, head, transported.closeoutReport);
    const saved = readSessionCloseout(path)!;
    migrate(db);
    insertQueuedItem(db, { id: "item", title: "Remote output", now: 1 });
    const started = beginImplementRun(db, "item", 1, {
      phase: "verifying",
      baseSha: head,
      wipCommit: head,
    });
    markRun(db, started.run.id, "ended", 2);
    applyWorkItemEvent(db, "item", "turn_ended");
    saveCheckpoint(db, "item", { phase: "verifying", baseSha: head, wipCommit: head });
    const identity = {
      taskId: "item",
      base: head,
      head,
      policyDigest: "sha256:" + "a".repeat(64),
      policyPath: ".agents/closeout.yaml",
    };
    ensureCloseoutProgress(db, "item", identity, 10, true);
    const parsed = JSON.parse(saved.report);
    const command = parsed.required[0].result;
    upsertCloseoutStep(
      db,
      "item",
      identity,
      {
        id: "output",
        kind: "command",
        state: "running",
        command: command.argv.join(" "),
        detail: null,
        attempt: 1,
        timeoutSeconds: 30,
        startedAt: 10,
        finishedAt: null,
        exitCode: null,
        timedOut: false,
        timeoutReason: null,
        truncated: false,
        logPath: "output.log",
        evidencePath: null,
        findings: null,
        ordinal: 0,
      },
      10,
    );
    const result = loggedSessionCloseout(saved.report, {
      itemId: "output",
      cwd: root,
      argv: command.argv,
      expectedHead: head,
      timeoutSeconds: 30,
      artifactPath: "output.log",
      logFile: join(root, "output.log"),
      onOutput: (stream, text, truncated) =>
        appendCloseoutOutput(db, "item", identity, "output", stream, text, truncated, 20),
    });
    upsertCloseoutStep(
      db,
      "item",
      identity,
      {
        id: "output",
        kind: "command",
        state: "failed",
        command: command.argv.join(" "),
        detail: null,
        attempt: 1,
        timeoutSeconds: 30,
        startedAt: 10,
        finishedAt: 10 + result.durationMs,
        exitCode: result.exitCode,
        timedOut: false,
        timeoutReason: null,
        truncated: result.truncated,
        logPath: "output.log",
        evidencePath: null,
        findings: null,
        ordinal: 0,
      },
      30,
    );
    finishCloseoutProgress(db, "item", identity, "rejected", 40);
    const provider = createLiveStatusProvider(db);
    const verdict = provider.snapshot().verdicts[0]!;
    const check = verdict.checks[0]!;
    // `/api/status` carries no check output; the issue page loads it per check.
    expect(check.stdout).toBeUndefined();
    const log = provider.checkLog({
      itemId: verdict.itemId,
      attempt: 1,
      checkId: check.id,
      run: null,
    })!;
    expect(log.stdout).toContain("actual remote stdout");
    expect(log.stderr).toContain("actual remote stderr");
    expect(check.elapsedMs).toBeGreaterThanOrEqual(40);
    expect(check.exitCode).toBe(1);
    expect(saved.head).toBe(head);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
