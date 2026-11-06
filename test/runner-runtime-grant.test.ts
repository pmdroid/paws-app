import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunnerRequestError } from "../src/runner-daemon";
import { readRunnerAnswer, runnerGitHubReadId } from "../src/runner-answers";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

const GRANT_MS = 60_000;

function git(args: string[], cwd: string) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Acme",
      GIT_AUTHOR_EMAIL: "acme@example.invalid",
      GIT_COMMITTER_NAME: "Acme",
      GIT_COMMITTER_EMAIL: "acme@example.invalid",
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

type Refusal = "expired-once" | "fenced" | null;

async function settleUntil(
  tick: () => Promise<unknown>,
  what: string,
  holds: () => boolean,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!holds()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting until ${what}`);
    await tick();
    await Bun.sleep(2);
  }
}

async function fixture(input: {
  pushMs?: number;
  chunkMs?: number;
  refuse?: Refusal;
  githubRead?: { failures: number; token: string };
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-grant-"));
  let wall = Date.now();
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main"], source);
  writeFileSync(join(source, "widget.txt"), "base\n");
  git(["add", "."], source);
  git(["commit", "-q", "-m", "base"], source);
  const baseSha = git(["rev-parse", "HEAD"], source);
  git(["clone", "-q", "--bare", source, join(root, "origin.git")], root);
  writeFileSync(join(source, "widget.txt"), "checkpoint\n");
  git(["commit", "-q", "-am", "checkpoint"], source);
  const checkpointSha = git(["rev-parse", "HEAD"], source);
  git(["bundle", "create", "-q", join(root, "checkpoint.bundle"), `${baseSha}..HEAD`], source);
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
    chmodSync(directory, directory === results.root ? 0o770 : 0o750);
  }
  const command: RunnerCommand = {
    id: "command",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    issuedAt: wall,
    expiresAt: wall + 36_000_000,
    repository: {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      baseSha,
    },
    profile: { agent: "claude", model: null },
    prompt: "Implement the assigned issue",
    ...(input.githubRead ? { githubRead: true as const } : {}),
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "acme",
    expiresAt: wall + 36_000_000,
  };
  let pending: RunnerCommand[] = [command];
  let execution = "";
  let issued = 0;
  const grants = new Map<string, number>();
  const sent: { type: string; token: string }[] = [];
  const chunks: string[] = [];
  const stopped: string[] = [];
  let refusedOnce = false;
  let readAttempts = 0;
  const expired = (token: string) => (grants.get(token) ?? 0) <= wall;
  const refuseExpired = (token: string, path: string) => {
    if (expired(token))
      throw new RunnerRequestError(
        403,
        "POST",
        path,
        1,
        "Runner work request is denied or invalid.",
      );
  };
  const runtime = await openRunnerRuntime({
    root,
    spool,
    results,
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => wall,
    monotonic: () => wall,
    onError: () => {},
    async networkGit(request) {
      if (request.operation === "clone")
        git(["clone", "-q", "--bare", join(root, "origin.git"), request.dest!], request.cwd);
      else if (request.operation === "fetch")
        git(["fetch", "-q", join(root, "origin.git"), "+refs/heads/*:refs/heads/*"], request.dest!);
      else if (request.operation === "push") {
        wall += input.pushMs ?? 0;
        git(["push", "-q", "--force", join(root, "origin.git"), request.refspec!], request.cwd);
      }
    },
    broker: {
      async start(id) {
        execution = id;
        const directory = join(results.root, id);
        mkdirSync(directory);
        chmodSync(directory, 0o750);
        writeFileSync(join(directory, "events.jsonl"), "");
        chmodSync(join(directory, "events.jsonl"), 0o640);
        return { alreadyAdmitted: false };
      },
      async stop(id) {
        stopped.push(id);
      },
      alive: () => true,
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [{ runId: "run", generation: 1, expiresAt: wall + 60_000 }], fenced: [] };
      },
      async pollCommands() {
        return { commands: pending, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => pending,
      async acknowledgeCommand(id) {
        pending = pending.filter((entry) => entry.id !== id);
      },
      async issueRunGrant() {
        const token = `grant-${++issued}`;
        grants.set(token, wall + GRANT_MS);
        return { token, expiresAt: wall + GRANT_MS };
      },
      async sendEvent(event, token) {
        if (input.refuse === "fenced")
          throw new RunnerRequestError(409, "POST", "/v1/events", 1, "Runner work is fenced.");
        if (input.refuse === "expired-once" && !refusedOnce) {
          refusedOnce = true;
          throw new RunnerRequestError(
            403,
            "POST",
            "/v1/events",
            1,
            "Runner work request is denied or invalid.",
          );
        }
        refuseExpired(token, "/v1/events");
        sent.push({ type: event.event.type, token });
        return { duplicate: false };
      },
      async answers(_runId, _generation, _after, token) {
        refuseExpired(token, "/v1/runs/run/answers");
        return { answers: [] };
      },
      async postResult() {
        return { duplicate: false };
      },
      async repositoryCredential(_runId, _generation, access, token) {
        refuseExpired(token, "/v1/runs/run/repository-credential");
        return {
          token: "acme-token",
          expiresAt: wall + 3_600_000,
          remoteUrl: command.repository.remoteUrl,
          branch: access === "write" ? "paws/acme" : null,
        };
      },
      async renewCertificate() {
        return paired;
      },
      async githubReadCredential() {
        readAttempts++;
        if (readAttempts <= (input.githubRead?.failures ?? 0))
          throw new Error("Runner control plane is unavailable");
        return { token: input.githubRead!.token, expiresAt: wall + 3_600_000 };
      },
      async uploadArtifact(_runId, _chunk, token) {
        refuseExpired(token, "/v1/runs/run/artifacts");
        chunks.push(token);
        wall += input.chunkMs ?? 0;
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
  const tick = () => runtime.tick().catch(() => {});
  await settleUntil(tick, "the execution starts", () => execution !== "");
  const directory = join(results.root, execution);
  const event = (value: object) =>
    appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify(value)}\n`);
  return {
    sent,
    chunks,
    stopped,
    grants,
    issuedCount: () => issued,
    checkpoint() {
      const bundle = join(directory, `checkpoint-${checkpointSha}.bundle`);
      copyFileSync(join(root, "checkpoint.bundle"), bundle);
      chmodSync(bundle, 0o640);
      event({ type: "checkpoint", reason: "interval", sha: checkpointSha });
    },
    artifact(chunkCount: number) {
      const id = randomUUID();
      const bytes = Buffer.alloc(524_288 * chunkCount - 7, 1);
      const file = join(directory, `artifact-${id}.bytes`);
      writeFileSync(file, bytes);
      chmodSync(file, 0o640);
      event({
        type: "artifact",
        requestId: id,
        artifact: {
          id,
          path: "out/widget.png",
          displayName: "widget.png",
          mimeType: "image/png",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          attachToIssue: false,
        },
      });
    },
    progress(text: string) {
      event({ type: "progress", text });
    },
    readAttempts: () => readAttempts,
    readToken: () => readRunnerAnswer(spool, execution, runnerGitHubReadId(1))?.answer ?? null,
    advance(ms: number) {
      wall += ms;
    },
    settleUntil: (what: string, holds: () => boolean, options?: { timeoutMs?: number }) =>
      settleUntil(tick, what, holds, options),
    async cleanup() {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const linuxOnly = test.skipIf(
  process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0,
);

linuxOnly(
  "a checkpoint whose push outlasts the run grant still sends its event with a fresh grant",
  async () => {
    const f = await fixture({ pushMs: 2 * GRANT_MS });
    try {
      f.checkpoint();
      await f.settleUntil("the checkpoint event is sent", () =>
        f.sent.some((event) => event.type === "checkpoint"),
      );
      const checkpoint = f.sent.find((event) => event.type === "checkpoint");
      expect(checkpoint).toBeDefined();
      expect(f.issuedCount()).toBeGreaterThan(1);
      expect(f.stopped).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

linuxOnly(
  "an artifact upload that outlasts the run grant renews it between chunks",
  async () => {
    const f = await fixture({ chunkMs: 40_000 });
    try {
      f.artifact(3);
      await f.settleUntil("the artifact event is sent", () =>
        f.sent.some((event) => event.type === "artifact"),
      );
      expect(f.chunks).toHaveLength(3);
      expect(new Set(f.chunks).size).toBeGreaterThan(1);
      expect(f.sent.some((event) => event.type === "artifact")).toBe(true);
      expect(f.stopped).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

linuxOnly(
  "an event refused once for its grant is retried once with a new grant",
  async () => {
    const f = await fixture({ refuse: "expired-once" });
    try {
      f.progress("Working on the acme widgets");
      await f.settleUntil("the progress event is sent", () =>
        f.sent.some((event) => event.type === "progress"),
      );
      expect(f.sent.map((event) => event.type)).toContain("progress");
      expect(f.issuedCount()).toBeGreaterThan(1);
      expect(f.stopped).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

linuxOnly(
  "a fenced run still stops without a retry",
  async () => {
    const f = await fixture({ refuse: "fenced" });
    try {
      f.progress("Working on the acme widgets");
      await f.settleUntil("the fenced run stops", () => f.stopped.length > 0);
      expect(f.sent).toEqual([]);
      expect(f.stopped.length).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);

linuxOnly(
  "a read token whose first fetches fail still reaches the turn on a later retry",
  async () => {
    const token = "ghs_ab.cd-ef~gh";
    const f = await fixture({ githubRead: { failures: 2, token } });
    try {
      expect(f.readAttempts()).toBe(1);
      expect(f.readToken()).toBeNull();
      f.advance(5_000);
      await f.settleUntil("the second attempt runs", () => f.readAttempts() === 2);
      expect(f.readToken()).toBeNull();
      f.advance(15_000);
      await f.settleUntil("the third attempt delivers the token", () => f.readToken() !== null);
      expect(JSON.parse(f.readToken()!).token).toBe(token);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
