import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunnerRequestError, type RunnerEventDelivery } from "../src/runner-daemon";
import { readRunnerJob } from "../src/runner-execution";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerArtifact, RunnerCommand, RunnerResult } from "../src/runner-protocol";

async function deliverRejected(rejection: RunnerRequestError) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-artifact-drop-"));
  const now = Date.now();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  for (const directory of [spool.root, results.root]) {
    mkdirSync(directory);
    chmodSync(directory, 0o750);
  }
  const artifact = (path: string): RunnerArtifact => ({
    id: randomUUID(),
    path,
    displayName: path.slice(path.lastIndexOf("/") + 1),
    mimeType: "image/png",
    sizeBytes: path.length,
    sha256: createHash("sha256").update(path).digest("hex"),
    attachToIssue: false,
  });
  const kept = artifact("screens/kept.png");
  const extra = artifact("screens/extra.png");
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  let pending: RunnerCommand[] = [
    {
      id: "command-run",
      type: "task",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      sessionId: "session",
      sessionGeneration: 1,
      taskModeGeneration: 1,
      purpose: "artifact",
      issuedAt: now,
      expiresAt: now + 600_000,
      profile: { agent: "claude", model: null },
      prompt: "signed prompt",
    },
  ];
  const uploads: string[] = [];
  const events: RunnerEventDelivery[] = [];
  const posted: RunnerResult[] = [];
  const errors: string[] = [];
  const runtime = await openRunnerRuntime({
    root,
    spool,
    results,
    repositoryRoot: join(root, "repositories"),
    home: root,
    onError: (error) => errors.push(error.message),
    broker: {
      async start(id) {
        const command = readRunnerJob(spool, id).command;
        const directory = join(results.root, id);
        mkdirSync(directory);
        chmodSync(directory, 0o750);
        const files: [string, string][] = [
          [
            "events.jsonl",
            [kept, extra]
              .map((value) =>
                JSON.stringify({ type: "artifact", requestId: value.id, artifact: value }),
              )
              .join("\n") + "\n",
          ],
          [`artifact-${kept.id}.bytes`, kept.path],
          [`artifact-${extra.id}.bytes`, extra.path],
          [
            "result.json",
            JSON.stringify({
              executionId: id,
              commandId: command.id,
              run: {
                role: "implementer",
                stopReason: "end_turn",
                timedOut: false,
                cancelled: false,
                authRequired: false,
                agentExited: true,
              },
            }),
          ],
        ];
        for (const [name, body] of files) {
          writeFileSync(join(directory, name), body);
          chmodSync(join(directory, name), 0o640);
        }
        return { alreadyAdmitted: false };
      },
      async stop() {},
      alive: () => true,
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
      },
      async pollCommands() {
        return { commands: pending, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => pending,
      async acknowledgeCommand(id) {
        pending = pending.filter((command) => command.id !== id);
      },
      async issueRunGrant() {
        return { token: "token", expiresAt: now + 60_000 };
      },
      async sendEvent(delivery) {
        events.push(delivery);
        return { duplicate: false };
      },
      async answers() {
        return { answers: [] };
      },
      async postResult(_runId, _generation, result) {
        posted.push(result);
        return { duplicate: false };
      },
      async repositoryCredential() {
        throw new Error("Repository-free task");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact(_runId, chunk) {
        uploads.push(chunk.artifact.path);
        if (chunk.artifact.id === extra.id) throw rejection;
        return { ok: true };
      },
      async uploadTranscript(_runId, chunk) {
        return { offset: chunk.offset, duplicate: false };
      },
      async finishTranscript() {
        return { uri: "transcript" };
      },
    },
  });
  try {
    const deadline = Date.now() + 5_000;
    while (posted.length === 0 && Date.now() < deadline) {
      await runtime.tick();
      await Bun.sleep(1);
    }
    return { kept, extra, uploads, events, posted, errors };
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "an artifact Paws refuses as over the limit is dropped and the run still finishes",
  async () => {
    const reason = "Paws keeps at most 20 artifacts per run";
    const outcome = await deliverRejected(
      new RunnerRequestError(422, "POST", "/v1/runs/run/artifacts", 3, reason),
    );
    expect(outcome.uploads).toEqual(["screens/kept.png", "screens/extra.png"]);
    const artifacts = outcome.events.map((delivery) => delivery.event);
    expect(artifacts).toEqual([
      { type: "artifact", artifact: outcome.kept },
      { type: "artifact", artifact: outcome.extra, dropped: reason },
    ]);
    expect(outcome.errors).toEqual([]);
    expect(outcome.posted).toHaveLength(1);
    expect(outcome.posted[0]!.errorMessage).toBeUndefined();
    expect(outcome.posted[0]!.stopReason).toBe("end_turn");
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "an artifact upload denied for its grant still stops the run",
  async () => {
    const outcome = await deliverRejected(
      new RunnerRequestError(403, "POST", "/v1/runs/run/artifacts", 3, "denied"),
    );
    expect(outcome.events.map((delivery) => delivery.event)).toEqual([
      { type: "artifact", artifact: outcome.kept },
    ]);
    expect(outcome.errors.join("\n")).toContain("HTTP 403");
    expect(outcome.posted).toHaveLength(1);
    expect(outcome.posted[0]!.stopReason).toBe("error");
    expect(outcome.posted[0]!.errorMessage).toContain("HTTP 403");
  },
);
