import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentSessionRefusedError,
  createAgentSessions,
  createFakeAgentSessionObjects,
  type AgentSessionChunk,
  type AgentSessionFinish,
} from "../src/agent-sessions";
import { RunnerRequestError } from "../src/runner-daemon";
import { openExecutionJournal } from "../src/runner-journal";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";
import { openRunnerRuntime, type RunnerAgents } from "../src/runner-runtime";
import type { RunnerWork } from "../src/runner-work";
import { tempDb } from "./helpers";

const linux = process.platform === "linux" && process.getuid!() !== 0 && process.getgid!() !== 0;

function git(args: string[], cwd: string) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(options: { claudeVersion?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-session-"));
  const now = Date.now();
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "file.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const baseSha = git(["rev-parse", "HEAD"], source);
  git(["clone", "-q", "--bare", source, join(root, "origin.git")], root);
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
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 3,
    issuedAt: now,
    expiresAt: now + 3_600_000,
    repository: {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement the assigned issue",
  };
  // The store from the snapshot-store issue, with its fake object storage and a stub grant.
  const db = tempDb();
  db.run("PRAGMA foreign_keys=OFF");
  const objects = createFakeAgentSessionObjects();
  const work = {
    authorize: () => ({ command }),
    identity: () => ({ userId: "owner" }),
  } as unknown as RunnerWork;
  const sessions = createAgentSessions({ db, work, objects, key: randomBytes(32) });
  const access = { runnerId: "runner", runId: "run", token: "token" };
  const chunks: AgentSessionChunk[] = [];
  const finishes: AgentSessionFinish[] = [];
  const failAt = new Set<number>();
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const posted: RunnerResult[] = [];
  let pending: RunnerCommand[] = [command];
  let execution = "";
  const errors: string[] = [];
  const agents = {
    installed: () =>
      options.claudeVersion === undefined
        ? []
        : [{ agent: "claude", version: options.claudeVersion, status: "current" }],
    apply() {},
  } as unknown as RunnerAgents;
  function open() {
    return openRunnerRuntime({
      root,
      spool,
      results,
      repositoryRoot: join(root, "repositories"),
      home: root,
      agents,
      onError: (error) => errors.push(error.message),
      async networkGit(input) {
        if (input.operation === "clone")
          git(["clone", "-q", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
      },
      broker: {
        async start(id) {
          execution = id;
          outputDirectory(id);
          return { alreadyAdmitted: false };
        },
        async stop() {},
        alive: () => true,
      },
      daemon: {
        status: () => paired,
        async heartbeat() {
          return {
            leases: [{ runId: "run", generation: 3, expiresAt: now + 60_000 }],
            fenced: [],
          };
        },
        async pollCommands() {
          return { commands: pending, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => pending,
        async acknowledgeCommand(id) {
          pending = pending.filter((entry) => entry.id !== id);
        },
        async issueRunGrant() {
          return { token: "token", expiresAt: now + 3_600_000 };
        },
        async sendEvent() {
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
          return {
            token: "fixture-token",
            expiresAt: now + 3_600_000,
            remoteUrl: command.repository.remoteUrl,
            branch: null,
          };
        },
        async renewCertificate() {
          return paired;
        },
        async uploadArtifact() {
          return { ok: true };
        },
        async uploadTranscript(_runId, chunk) {
          return { offset: chunk.offset, duplicate: false };
        },
        async finishTranscript() {
          return { uri: "transcript" };
        },
        async uploadSession(runId, chunk, token) {
          chunks.push(chunk);
          if (failAt.delete(chunk.offset)) throw new RunnerRequestError(503, "POST", "/session");
          return http(() => sessions.upload({ ...access, runId, token }, chunk));
        },
        async finishSession(runId, finish, token) {
          finishes.push(finish);
          return http(() => sessions.finish({ ...access, runId, token }, finish));
        },
      },
    });
  }
  /** A refusal reaches the runner as HTTP 403, like the session routes answer it. */
  async function http<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AgentSessionRefusedError)
        throw new RunnerRequestError(403, "POST", "/session");
      throw error;
    }
  }
  function outputDirectory(id: string) {
    const directory = join(results.root, id);
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o750);
    return directory;
  }
  function write(directory: string, name: string, body: string | Buffer) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), 0o640);
  }
  /** What the worker leaves when a Claude turn ends: a bundle, its description and a result. */
  function finishWorker(id: string, bundle: Buffer | null) {
    const directory = outputDirectory(id);
    write(directory, "events.jsonl", "");
    if (bundle) {
      write(directory, "session.ndjson.gz", bundle);
      write(
        directory,
        "session.json",
        JSON.stringify({
          agent: "claude",
          sessionId: "claude-session",
          workspacePath: "/var/lib/paws-agent/work/run",
          commitSha: baseSha,
          turn: 3,
          sizeBytes: bundle.length,
          sha256: sha(bundle),
        }),
      );
    }
    write(
      directory,
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
          sessionId: "claude-session",
        },
      }),
    );
  }
  async function drive(runtime: Awaited<ReturnType<typeof open>>, done: () => boolean) {
    for (let index = 0; index < 2000 && !done(); index++) {
      await runtime.tick().catch(() => {});
      await Bun.sleep(1);
    }
  }
  return {
    root,
    baseSha,
    command,
    sessions,
    chunks,
    finishes,
    failAt,
    posted,
    errors,
    open,
    finishWorker,
    drive,
    started: () => execution,
    async read(generation: number) {
      const parts: Uint8Array[] = [];
      for await (const part of sessions.read({ ...access, generation }, generation))
        parts.push(part);
      return Buffer.concat(parts);
    },
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!linux)(
  "the session uploads in 512 KiB chunks and seals with the version, session, commit and turn before the result",
  async () => {
    const context = fixture({ claudeVersion: "2.1.7" });
    const runtime = await context.open();
    try {
      await context.drive(runtime, () => context.started() !== "");
      const bundle = randomBytes(1_200_000);
      // The connection drops on the second chunk; the next tick resumes there, not at zero.
      context.failAt.add(524_288);
      context.finishWorker(context.started(), bundle);
      await context.drive(runtime, () => context.posted.length > 0);
      expect(context.chunks.map((chunk) => chunk.offset)).toEqual([0, 524_288, 524_288, 1_048_576]);
      expect(context.chunks.map((chunk) => chunk.generation)).toEqual([3, 3, 3, 3]);
      expect(context.finishes).toEqual([
        {
          generation: 3,
          sizeBytes: bundle.length,
          sha256: sha(bundle),
          agent: "claude",
          agentVersion: "2.1.7",
          sessionId: "claude-session",
          workspacePath: "/var/lib/paws-agent/work/run",
          commitSha: context.baseSha,
          turn: 3,
        },
      ]);
      expect(context.sessions.snapshot("run", 3)).toMatchObject({
        status: "sealed",
        agentVersion: "2.1.7",
        sessionId: "claude-session",
        commitSha: context.baseSha,
        turn: 3,
        ownerUserId: "owner",
      });
      expect((await context.read(3)).equals(bundle)).toBe(true);
      expect(context.posted).toHaveLength(1);
      expect(context.posted[0]!.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);

test.skipIf(!linux)(
  "after a restart the runner resumes the session upload at the offset in its journal",
  async () => {
    const context = fixture({ claudeVersion: "2.1.7" });
    const bundle = randomBytes(1_200_000);
    // The earlier process uploaded the first chunk, recorded it, and stopped.
    const journal = openExecutionJournal(context.root);
    const id = journal.admit(context.command, Date.now())!.id;
    journal.phase(id, "running");
    await context.sessions.upload(
      { runnerId: "runner", runId: "run", token: "token" },
      {
        generation: 3,
        offset: 0,
        sha256: sha(bundle.subarray(0, 524_288)),
        data: bundle.subarray(0, 524_288).toString("base64"),
      },
    );
    journal.sessionUploaded(id, 0, 524_288);
    journal.close();
    context.finishWorker(id, bundle);
    const runtime = await context.open();
    try {
      expect(context.chunks.map((chunk) => chunk.offset)).toEqual([524_288, 1_048_576]);
      expect(context.finishes).toHaveLength(1);
      expect((await context.read(3)).equals(bundle)).toBe(true);
      expect(context.posted).toHaveLength(1);
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);

test.skipIf(!linux)("a session snapshot that fails never holds back the result", async () => {
  // No installed Claude version to record, so the snapshot is skipped.
  const context = fixture();
  const runtime = await context.open();
  try {
    await context.drive(runtime, () => context.started() !== "");
    context.finishWorker(context.started(), randomBytes(1000));
    await context.drive(runtime, () => context.posted.length > 0);
    expect(context.chunks).toEqual([]);
    expect(context.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
    expect(context.errors.some((message) => message.includes("skipped the agent session"))).toBe(
      true,
    );
  } finally {
    await runtime.stop();
    context.cleanup();
  }
});

test.skipIf(!linux)("Paws refusing a chunk skips the snapshot and the run continues", async () => {
  const context = fixture({ claudeVersion: "2.1.7" });
  const runtime = await context.open();
  try {
    await context.drive(runtime, () => context.started() !== "");
    const bundle = randomBytes(1000);
    context.finishWorker(context.started(), bundle);
    // Another bundle already began uploading for this generation, so Paws refuses this one.
    await context.sessions.upload(
      { runnerId: "runner", runId: "run", token: "token" },
      { generation: 3, offset: 0, sha256: sha(Buffer.from("x")), data: "eA==" },
    );
    await context.drive(runtime, () => context.posted.length > 0);
    expect(context.chunks).toHaveLength(1);
    expect(context.finishes).toEqual([]);
    expect(context.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
  } finally {
    await runtime.stop();
    context.cleanup();
  }
});

test.skipIf(!linux)(
  "a run without a session bundle posts its result without uploading",
  async () => {
    const context = fixture({ claudeVersion: "2.1.7" });
    const runtime = await context.open();
    try {
      await context.drive(runtime, () => context.started() !== "");
      context.finishWorker(context.started(), null);
      await context.drive(runtime, () => context.posted.length > 0);
      expect(context.chunks).toEqual([]);
      expect(context.posted).toHaveLength(1);
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);
