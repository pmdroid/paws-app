import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunnerRequestError } from "../src/runner-daemon";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";

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

async function fixture(
  rejection: string | null,
  handover?: { expiresIn: number },
  faults: { postFailures?: number; sealRefused?: boolean; sealUnavailable?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-push-"));
  const now = Date.now();
  let clock = 0;
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "file.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const baseSha = git(["rev-parse", "HEAD"], source);
  git(["clone", "-q", "--bare", source, join(root, "origin.git")], root);
  writeFileSync(join(source, "file.txt"), "candidate\n");
  git(["commit", "-q", "-am", "candidate"], source);
  const candidateSha = git(["rev-parse", "HEAD"], source);
  git(["bundle", "create", "-q", join(root, "candidate.bundle"), `${baseSha}..HEAD`], source);
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
  const command: RunnerCommand = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
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
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  let pending: RunnerCommand[] = [command];
  let execution = "";
  const posted: RunnerResult[] = [];
  const pushes: number[] = [];
  const resumes: string[] = [];
  const seals: { handedOver?: true; sizeBytes: number; sha256: string }[] = [];
  const uploads: { offset: number; size: number }[] = [];
  // Paws refuses only handover seals, as it does after the handover deadline.
  let refuseHandovers = faults.sealRefused ?? false;
  // Paws cannot be reached for handover seals, so the runner cannot tell if one landed.
  let sealUnavailable = faults.sealUnavailable ?? false;
  // A worker's event journal: the agent's ACP events next to its progress, as a real run writes.
  const events = handover
    ? [
        {
          type: "acp",
          event: {
            type: "session_update",
            sessionId: "session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Half done." },
            },
          },
        },
        { type: "progress", text: "Handing over" },
        { type: "acp", event: { type: "cancelled", reason: "cancel" } },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join("")
    : "";
  let postFailures = faults.postFailures ?? 0;
  // A worker that wrote a handover result has exited; a resumed worker runs again.
  let alive = !handover;
  const open = () =>
    openRunnerRuntime({
      root,
      spool,
      results,
      repositoryRoot: join(root, "repositories"),
      home: root,
      now: () => now,
      monotonic: () => clock,
      onError: () => {},
      async networkGit(input) {
        if (input.operation === "clone")
          git(["clone", "-q", "--bare", join(root, "origin.git"), input.dest!], input.cwd);
        else if (input.operation === "push") {
          pushes.push(clock);
          if (rejection !== null) throw new Error(rejection);
        }
      },
      broker: {
        async start(id) {
          execution = id;
          const directory = join(results.root, id);
          mkdirSync(directory);
          chmodSync(directory, 0o750);
          writeFileSync(join(directory, "events.jsonl"), events);
          chmodSync(join(directory, "events.jsonl"), 0o640);
          return { alreadyAdmitted: false };
        },
        async stop() {},
        alive: () => alive,
        async resume(id) {
          resumes.push(id);
          alive = true;
        },
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
          if (postFailures-- > 0) throw new RunnerRequestError(503);
          posted.push(result);
          return { duplicate: false };
        },
        async repositoryCredential(_runId, _generation, access) {
          return {
            token: "fixture-token",
            expiresAt: now + 3_600_000,
            remoteUrl: command.repository.remoteUrl,
            branch: access === "write" ? "paws/fixture" : null,
          };
        },
        async renewCertificate() {
          return paired;
        },
        async uploadArtifact() {
          return { ok: true };
        },
        async uploadTranscript(_runId, chunk) {
          uploads.push({ offset: chunk.offset, size: Buffer.from(chunk.data, "base64").length });
          return { offset: chunk.offset, duplicate: false };
        },
        async finishTranscript(_runId, finish) {
          if (finish.handedOver && sealUnavailable) throw new RunnerRequestError(503);
          if (finish.handedOver && refuseHandovers) throw new RunnerRequestError(409);
          seals.push({
            ...(finish.handedOver ? { handedOver: finish.handedOver } : {}),
            sizeBytes: finish.sizeBytes,
            sha256: finish.sha256,
          });
          return { uri: "transcript" };
        },
      },
    });
  let runtime = await open();
  const tick = () => runtime.tick().catch(() => {});
  const started = () => execution !== "";
  for (let index = 0; index < 400 && !started(); index++) {
    await tick();
    await Bun.sleep(1);
  }
  const directory = join(results.root, execution);
  copyFileSync(join(root, "candidate.bundle"), join(directory, "candidate.bundle"));
  chmodSync(join(directory, "candidate.bundle"), 0o640);
  const resultName = handover ? "handover.json" : "result.json";
  writeFileSync(
    join(directory, resultName),
    JSON.stringify({
      executionId: execution,
      commandId: command.id,
      run: {
        role: "implementer",
        stopReason: handover ? "cancelled" : "end_turn",
        timedOut: false,
        cancelled: Boolean(handover),
        ...(handover ? { handedOver: true } : {}),
        authRequired: false,
        agentExited: true,
      },
      candidateSha,
      ...(handover ? { handoverExpiresAt: now + handover.expiresIn } : {}),
    }),
  );
  chmodSync(join(directory, resultName), 0o640);
  return {
    posted,
    pushes,
    resumes,
    seals,
    events,
    uploads,
    /** Stops the runtime and opens a new one on the same journal, with Paws reachable again. */
    async restart(options: { refuseHandovers?: boolean } = {}) {
      await runtime.stop();
      postFailures = 0;
      refuseHandovers = options.refuseHandovers ?? false;
      sealUnavailable = false;
      runtime = await open();
    },
    async run(minutes: number) {
      for (let step = 0; step <= minutes * 2; step++) {
        for (let index = 0; index < 5; index++) {
          await tick();
          await Bun.sleep(1);
        }
        clock += 30_000;
      }
    },
    async cleanup() {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a candidate push GitHub keeps failing stops after six tries over about 15 minutes with the error and branch",
  async () => {
    const f = await fixture(
      "fatal: unable to access 'https://github.com/fixture/repository.git/': The requested URL returned error: 502",
    );
    try {
      await f.run(20);
      expect(f.pushes).toEqual([0, 0, 60_000, 180_000, 420_000, 900_000]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.stopReason).toBe("error");
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: expect.stringContaining("The requested URL returned error: 502"),
      });
      expect(f.posted[0]!.errorMessage).toContain("paws/fixture");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a candidate push GitHub rejects for permission stops on the first try",
  async () => {
    const f = await fixture(
      "remote: Permission to fixture/repository.git denied to paws-test[bot].\nfatal: unable to access 'https://github.com/fixture/repository.git/': The requested URL returned error: 403",
    );
    try {
      await f.run(2);
      expect(f.pushes).toEqual([0]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]!.pushFailure).toEqual({
        branch: "paws/fixture",
        error: expect.stringContaining("Permission to fixture/repository.git denied"),
      });
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

const linuxUser =
  process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0;

test.skipIf(linuxUser)(
  "a handed-over WIP commit published before its deadline ends the run with a handedOver result",
  async () => {
    const f = await fixture(null, { expiresIn: 60_000 });
    try {
      await f.run(1);
      expect(f.pushes).toEqual([0]);
      expect(f.resumes).toEqual([]);
      expect(f.seals.map((seal) => seal.handedOver)).toEqual([true]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]).toMatchObject({ handedOver: true, cancelled: true });
      expect(f.posted[0]!.candidateSha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a handover too late to publish is not published and its worker continues the session",
  async () => {
    const f = await fixture(null, { expiresIn: 5_000 });
    try {
      await f.run(1);
      expect(f.pushes).toEqual([]);
      expect(f.posted).toEqual([]);
      expect(f.resumes).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a handover whose push fails is not retried and its worker continues the session",
  async () => {
    const f = await fixture(
      "fatal: unable to access 'https://github.com/fixture/repository.git/': The requested URL returned error: 502",
      { expiresIn: 60_000 },
    );
    try {
      await f.run(2);
      expect(f.pushes).toEqual([0]);
      expect(f.posted).toEqual([]);
      expect(f.resumes).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a handover whose result post fails after the seal only posts again and never restarts the worker",
  async () => {
    const f = await fixture(null, { expiresIn: 60_000 }, { postFailures: 2 });
    try {
      await f.run(3);
      expect(f.pushes).toEqual([0]);
      expect(f.seals.map((seal) => seal.handedOver)).toEqual([true]);
      expect(f.resumes).toEqual([]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]).toMatchObject({ handedOver: true });
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a handover whose seal Paws refuses is not posted and its worker continues the session",
  async () => {
    const f = await fixture(null, { expiresIn: 60_000 }, { sealRefused: true });
    try {
      await f.run(1);
      expect(f.pushes).toEqual([0]);
      expect(f.posted).toEqual([]);
      expect(f.resumes).toHaveLength(1);
      // The partial transcript rode with the refused seal, so no partial chunk was stored and
      // the continued session can still append to its transcript.
      expect(f.uploads).toEqual([]);
      expect(f.seals).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a runner that restarts before Paws accepts the handover seal keeps the WIP commit on the failed run",
  async () => {
    const f = await fixture(null, { expiresIn: 60_000 }, { sealUnavailable: true });
    try {
      await f.run(1);
      expect(f.posted).toEqual([]);
      await f.restart({ refuseHandovers: true });
      await f.run(1);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]).toMatchObject({ stopReason: "error", cancelled: false });
      expect(f.posted[0]!.handedOver).toBeUndefined();
      expect(f.posted[0]!.candidateSha).toMatch(/^[a-f0-9]{40}$/);
      expect(f.posted[0]!.errorMessage).toContain("restarted before the handover finished");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

test.skipIf(linuxUser)(
  "a runner that restarts after the handover seal finishes the handover instead of failing the run",
  async () => {
    const f = await fixture(null, { expiresIn: 60_000 }, { postFailures: 1_000 });
    try {
      await f.run(1);
      expect(f.seals.map((seal) => seal.handedOver)).toEqual([true]);
      expect(f.posted).toEqual([]);
      await f.restart();
      await f.run(1);
      expect(f.resumes).toEqual([]);
      expect(f.pushes).toEqual([0]);
      // The repeated seal covers exactly the transcript the first seal covered.
      const transcript = {
        handedOver: true as const,
        sizeBytes: Buffer.byteLength(f.events),
        sha256: createHash("sha256").update(f.events).digest("hex"),
      };
      expect(f.events.length).toBeGreaterThan(0);
      expect(f.seals).toEqual([transcript, transcript]);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]).toMatchObject({ handedOver: true, cancelled: true });
      expect(f.posted[0]!.candidateSha).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
