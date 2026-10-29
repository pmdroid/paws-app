import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
import { readRunnerAnswer, runnerHandoverRequestId } from "../src/runner-answers";
import { openExecutionJournal } from "../src/runner-journal";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";
import { openRunnerRuntime, type RunnerAgents } from "../src/runner-runtime";
import type { RunnerWork } from "../src/runner-work";
import { tempDb } from "./helpers";

const linux = process.platform === "linux" && process.getuid!() !== 0 && process.getgid!() !== 0;

const GIT_ENV = (cwd: string) => ({
  PATH: "/usr/bin:/bin",
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

async function git(args: string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: GIT_ENV(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

let repository: { dir: string; baseSha: string };
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-runtime-session-template-"));
  const source = join(dir, "source");
  mkdirSync(source);
  await git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "file.txt"), "base\n");
  await git(["add", "."], source);
  await git(["commit", "-q", "-m", "base"], source);
  const baseSha = await git(["rev-parse", "HEAD"], source);
  await git(["clone", "-q", "--bare", source, join(dir, "origin.git")], dir);
  repository = { dir, baseSha };
});
afterAll(() => rmSync(repository.dir, { recursive: true, force: true }));

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture(
  options: { claudeVersion?: string; codexVersion?: string; grokVersion?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-session-"));
  const now = Date.now();
  const source = join(root, "source");
  cpSync(join(repository.dir, "source"), source, { recursive: true });
  cpSync(join(repository.dir, "origin.git"), join(root, "origin.git"), { recursive: true });
  const { baseSha } = repository;
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
  /** The session bundle the job carried to the worker, read when the worker starts. */
  let carried: Buffer | null | undefined;
  /** What Paws streams for a session read; tests set it. */
  const served: { bytes?: Buffer; header?: string; fail?: boolean } = {};
  const reads: unknown[] = [];
  const errors: string[] = [];
  const agents = {
    installed: () =>
      (
        [
          ["claude", options.claudeVersion],
          ["codex", options.codexVersion],
          ["grok", options.grokVersion],
        ] as const
      ).flatMap(([agent, version]) =>
        version === undefined ? [] : [{ agent, version, status: "current" }],
      ),
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
      sessionRetryMs: 1,
      onError: (error) => errors.push(error.message),
      async networkGit(input) {
        if (input.operation === "clone")
          await git(["clone", "-q", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
      },
      broker: {
        async start(id) {
          execution = id;
          const carriedPath = join(spool.root, id, "session.ndjson.gz");
          carried = existsSync(carriedPath) ? readFileSync(carriedPath) : null;
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
        async readSession(runId, read, _token, output, maxBytes) {
          reads.push({ runId, ...read, maxBytes });
          const bytes = served.bytes ?? Buffer.alloc(0);
          writeSync(output, bytes.subarray(0, served.fail ? bytes.length >> 1 : bytes.length));
          if (served.fail) throw new RunnerRequestError(503, "POST", "/session/read");
          return {
            sizeBytes: bytes.length,
            sha256: sha(bytes),
            sentSha256: served.header ?? sha(bytes),
          };
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
  /** What the worker leaves when a turn ends: a bundle, its description and a result. */
  function finishWorker(
    id: string,
    bundle: Buffer | null,
    run: Partial<RunnerResult> = {},
    agent: "claude" | "codex" | "grok" = "claude",
  ) {
    const directory = outputDirectory(id);
    write(directory, "events.jsonl", "");
    if (bundle) {
      write(directory, "session.ndjson.gz", bundle);
      write(
        directory,
        "session.json",
        JSON.stringify({
          agent,
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
          ...run,
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
    spool,
    pending: () => pending,
    queue(next: RunnerCommand) {
      pending = [...pending, next];
    },
    started: () => execution,
    carried: () => carried,
    served,
    reads,
    repositories: () =>
      existsSync(join(root, "repositories")) ? readdirSync(join(root, "repositories")) : [],
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

test.skipIf(!linux)("a Grok session folder seals with the runner's Grok version", async () => {
  const context = fixture({ claudeVersion: "2.1.7", grokVersion: "1.0.50" });
  const runtime = await context.open();
  try {
    await context.drive(runtime, () => context.started() !== "");
    const bundle = randomBytes(600_000);
    context.finishWorker(context.started(), bundle, {}, "grok");
    await context.drive(runtime, () => context.posted.length > 0);
    expect(context.finishes).toMatchObject([
      { generation: 3, agent: "grok", agentVersion: "1.0.50", sha256: sha(bundle) },
    ]);
    expect(context.sessions.snapshot("run", 3)).toMatchObject({
      status: "sealed",
      agent: "grok",
      agentVersion: "1.0.50",
    });
    expect((await context.read(3)).equals(bundle)).toBe(true);
  } finally {
    await runtime.stop();
    context.cleanup();
  }
});

test.skipIf(!linux)("a Codex rollout seals with the runner's Codex version", async () => {
  const context = fixture({ claudeVersion: "2.1.7", codexVersion: "2.1.1" });
  const runtime = await context.open();
  try {
    await context.drive(runtime, () => context.started() !== "");
    const bundle = randomBytes(600_000);
    context.finishWorker(context.started(), bundle, {}, "codex");
    await context.drive(runtime, () => context.posted.length > 0);
    expect(context.finishes).toMatchObject([
      { generation: 3, agent: "codex", agentVersion: "2.1.1", sha256: sha(bundle) },
    ]);
    expect(context.sessions.snapshot("run", 3)).toMatchObject({
      status: "sealed",
      agent: "codex",
      agentVersion: "2.1.1",
    });
    expect((await context.read(3)).equals(bundle)).toBe(true);
  } finally {
    await runtime.stop();
    context.cleanup();
  }
});

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
  "after a restart the runner resumes the session upload at the offset in its journal and retries an outage",
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
    // The connection drops during recovery too; the retry resumes there instead of skipping.
    context.failAt.add(1_048_576);
    const runtime = await context.open();
    try {
      expect(context.chunks.map((chunk) => chunk.offset)).toEqual([524_288, 1_048_576, 1_048_576]);
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

test.skipIf(!linux)(
  "a moved run downloads its session snapshot and hands it to the worker through the spool",
  async () => {
    const context = fixture({ claudeVersion: "2.1.7" });
    const bundle = randomBytes(700_000);
    context.served.bytes = bundle;
    context.command.generation = 3;
    context.command.resumeSessionId = "claude-session";
    context.command.restoreSession = {
      generation: 2,
      agent: "claude",
      agentVersion: "2.1.7",
      sessionId: "claude-session",
      sha256: sha(bundle),
      sizeBytes: bundle.length,
    };
    const runtime = await context.open();
    try {
      await context.drive(runtime, () => context.started() !== "");
      expect(context.reads).toEqual([
        { runId: "run", generation: 3, snapshotGeneration: 2, maxBytes: bundle.length },
      ]);
      expect(context.carried()?.equals(bundle)).toBe(true);
      // The download is removed once the job holds its copy.
      expect(context.repositories().filter((name) => name.startsWith("session-"))).toEqual([]);
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);

test.skipIf(!linux)(
  "a session download that fails or does not match the command reaches the worker as no bundle",
  async () => {
    for (const served of [
      { fail: true },
      { header: "0".repeat(64) },
      { bytes: randomBytes(1000) },
    ]) {
      const context = fixture({ claudeVersion: "2.1.7" });
      const bundle = randomBytes(700_000);
      Object.assign(context.served, { bytes: bundle }, served);
      context.command.resumeSessionId = "claude-session";
      context.command.restoreSession = {
        generation: 2,
        agent: "claude",
        agentVersion: "2.1.7",
        sessionId: "claude-session",
        sha256: sha(bundle),
        sizeBytes: bundle.length,
      };
      const runtime = await context.open();
      try {
        await context.drive(runtime, () => context.started() !== "");
        expect(context.reads).toHaveLength(1);
        expect(context.carried()).toBeNull();
        expect(context.repositories().filter((name) => name.startsWith("session-"))).toEqual([]);
      } finally {
        await runtime.stop();
        context.cleanup();
      }
    }
  },
);

test.skipIf(!linux)(
  "each handover command reaches the running worker with its deadline, and the handed-over run seals its session before the result",
  async () => {
    const context = fixture({ claudeVersion: "2.1.7" });
    const runtime = await context.open();
    try {
      await context.drive(runtime, () => context.started() !== "");
      const id = context.started();
      const request = (sequence: number) =>
        readRunnerAnswer(context.spool, id, runnerHandoverRequestId(sequence));
      expect(request(1)).toBeNull();
      // The first request timed out on the worker; Paws asks again and the worker hears it too.
      const deadlines = [Date.now() + 120_000, Date.now() + 240_000];
      for (const [index, expiresAt] of deadlines.entries()) {
        context.queue({
          id: `handover-${index + 1}`,
          type: "handover",
          runnerId: "runner",
          workspaceId: "workspace",
          runId: "run",
          generation: 3,
          issuedAt: Date.now(),
          expiresAt,
        });
        await context.drive(runtime, () => request(index + 1) !== null);
        expect(request(index + 1)?.answer).toBe(String(expiresAt));
      }
      expect(context.pending().some((command) => command.type === "handover")).toBe(false);
      // The worker stopped at a safe point; a WIP commit equal to the base publishes nothing.
      const bundle = randomBytes(600_000);
      context.finishWorker(id, bundle, { stopReason: "cancelled", handedOver: true });
      await context.drive(runtime, () => context.posted.length > 0);
      expect(context.sessions.snapshot("run", 3)).toMatchObject({
        status: "sealed",
        sessionId: "claude-session",
        commitSha: context.baseSha,
        turn: 3,
      });
      expect((await context.read(3)).equals(bundle)).toBe(true);
      expect(context.posted).toHaveLength(1);
      expect(context.posted[0]).toMatchObject({
        handedOver: true,
        cancelled: false,
        stopReason: "cancelled",
      });
      expect(context.errors).toEqual([]);
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);

test.skipIf(!linux)(
  "a handed-over run whose session cannot be published ends as a handover failure and stays here",
  async () => {
    // No current Claude on the runner: the session can't be sealed.
    const context = fixture();
    const runtime = await context.open();
    try {
      await context.drive(runtime, () => context.started() !== "");
      const id = context.started();
      context.finishWorker(id, randomBytes(600_000), { stopReason: "cancelled", handedOver: true });
      await context.drive(runtime, () => context.posted.length > 0);
      expect(context.posted[0]).toMatchObject({
        handoverFailure: "publication",
        cancelled: false,
      });
      expect(context.posted[0]).not.toHaveProperty("handedOver");
      expect(context.finishes).toEqual([]);
    } finally {
      await runtime.stop();
      context.cleanup();
    }
  },
);
