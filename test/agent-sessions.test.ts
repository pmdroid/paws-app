import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { S3Client } from "bun";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  AGENT_SESSION_CHUNK_BYTES,
  AGENT_SESSION_KEY_FILE,
  createAgentSessions,
  createAgentSessionsHttp,
  createFakeAgentSessionObjects,
  createLocalAgentSessionObjects,
  createS3AgentSessionObjects,
  loadAgentSessionKey,
  withLocalAgentSessionFallback,
  type AgentSessionFinish,
  type AgentSessionObjects,
} from "../src/agent-sessions";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerWork, RunnerWorkFencedError, type RunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempDb, tempHome } from "./helpers";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

async function fixture(root: string) {
  const db = tempDb();
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "session-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "session-org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect() {},
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  async function enroll(name: string) {
    const client = await createRunnerKey(join(root, name));
    const pending = { name, csr: client.csr };
    const { runnerId } = await control.enroll({
      ...pending,
      token: control.createEnrollment(principal, pending).token,
    });
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
    return runnerId;
  }
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  function startRun(name: string) {
    const item = insertQueuedItem(db, { id: `${name}-item`, now, sessionKey: `${name}-session` });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "session-org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: `${name}-session`,
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, `${name}-session`, item.delegationId, { actorId: "owner" });
    bindWorkItemRepository(db, item.id, repository);
    return { itemId: item.id, runId: run.id };
  }
  function assign(
    run: { itemId: string; runId: string },
    runnerId: string,
    generation: number,
    type: "run" | "review" = "run",
  ) {
    const at = Date.now();
    const base = {
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: at,
      expiresAt: at + 300_000,
      runId: run.runId,
      itemId: run.itemId,
      generation,
      repository,
      profile: { agent: "claude" as const, model: "scripted" },
    };
    const command: RunnerCommand =
      type === "run"
        ? { ...base, type: "run", prompt: "Produce the fixture." }
        : { ...base, type: "review", prompt: "Review the fixture." };
    work.assign(command);
    const token = work.issueGrant({
      runnerId,
      runId: run.runId,
      commandId: command.id,
      generation,
    }).token;
    return { runnerId, runId: run.runId, token };
  }
  return { db, work, userId, workspaceId: workspace.id, enroll, startRun, assign };
}

function chunk(generation: number, offset: number, bytes: Uint8Array) {
  return { generation, offset, sha256: sha(bytes), data: Buffer.from(bytes).toString("base64") };
}

function finishFor(generation: number, bytes: Uint8Array): AgentSessionFinish {
  return {
    generation,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
    agent: "claude",
    agentVersion: "0.88.0",
    sessionId: "6f1c2a8e-session",
    workspacePath: "/var/lib/paws-agent/work/run",
    commitSha: "b".repeat(40),
    turn: 7,
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const part of chunks) parts.push(part);
  return Buffer.concat(parts);
}

const MARKER = Buffer.from("PLAINTEXT_SESSION_MARKER_5c1e");
const full = Buffer.concat([MARKER, randomBytes(AGENT_SESSION_CHUNK_BYTES - MARKER.length)]);
const tail = Buffer.concat([MARKER, Buffer.from("tail of the session")]);
const snapshot = Buffer.concat([full, full, tail]);

describe("agent session snapshots", () => {
  let root: string;
  let f: Awaited<ReturnType<typeof fixture>>;
  let objects: ReturnType<typeof createFakeAgentSessionObjects>;
  let work: RunnerWork;
  let key: Buffer;
  let db: Database;
  beforeEach(async () => {
    root = tempHome();
    f = await fixture(root);
    ({ work, db } = f);
    objects = createFakeAgentSessionObjects();
    key = randomBytes(32);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function sealed() {
    const runnerA = await f.enroll("a");
    const run = f.startRun("first");
    const access = f.assign(run, runnerA, 1);
    const sessions = createAgentSessions({ db, work, objects, key });
    await sessions.upload(access, chunk(1, 0, full));
    await sessions.upload(access, chunk(1, AGENT_SESSION_CHUNK_BYTES, full));
    await sessions.upload(access, chunk(1, 2 * AGENT_SESSION_CHUNK_BYTES, tail));
    await sessions.finish(access, finishFor(1, snapshot));
    return { sessions, access, run, runnerA };
  }

  test("uploads in order, retries idempotently, refuses gaps, bad hashes and sealed appends", async () => {
    const runnerA = await f.enroll("a");
    const run = f.startRun("first");
    const access = f.assign(run, runnerA, 1);
    const sessions = createAgentSessions({ db, work, objects, key });

    expect(await sessions.upload(access, chunk(1, 0, full))).toEqual({
      offset: AGENT_SESSION_CHUNK_BYTES,
      duplicate: false,
    });
    expect(await sessions.upload(access, chunk(1, 0, full))).toEqual({
      offset: AGENT_SESSION_CHUNK_BYTES,
      duplicate: true,
    });
    // A retry that changes the bytes at an accepted offset is refused.
    await expect(sessions.upload(access, chunk(1, 0, tail))).rejects.toThrow();
    // Out of order: offset 2 before offset 1.
    await expect(
      sessions.upload(access, chunk(1, 2 * AGENT_SESSION_CHUNK_BYTES, tail)),
    ).rejects.toThrow();
    // Unaligned offset.
    await expect(sessions.upload(access, chunk(1, 1, tail))).rejects.toThrow();
    // A sha256 that does not match the data.
    await expect(
      sessions.upload(access, {
        ...chunk(1, AGENT_SESSION_CHUNK_BYTES, full),
        sha256: sha(tail),
      }),
    ).rejects.toThrow();
    await sessions.upload(access, chunk(1, AGENT_SESSION_CHUNK_BYTES, full));
    await sessions.upload(access, chunk(1, 2 * AGENT_SESSION_CHUNK_BYTES, tail));
    // A short chunk ends the snapshot: nothing may follow it.
    await expect(
      sessions.upload(access, chunk(1, 3 * AGENT_SESSION_CHUNK_BYTES, tail)),
    ).rejects.toThrow();

    // A finish whose whole-snapshot hash or size does not match is refused and leaves it open.
    await expect(
      sessions.finish(access, { ...finishFor(1, snapshot), sha256: sha(tail) }),
    ).rejects.toThrow();
    await expect(
      sessions.finish(access, { ...finishFor(1, snapshot), sizeBytes: snapshot.length - 1 }),
    ).rejects.toThrow();
    expect(sessions.snapshot(run.runId, 1)?.status).toBe("uploading");

    const receipt = await sessions.finish(access, finishFor(1, snapshot));
    expect(receipt).toEqual({ generation: 1, sizeBytes: snapshot.length, sha256: sha(snapshot) });
    expect(await sessions.finish(access, finishFor(1, snapshot))).toEqual(receipt);
    await expect(sessions.finish(access, { ...finishFor(1, snapshot), turn: 8 })).rejects.toThrow();
    await expect(
      sessions.upload(access, chunk(1, 3 * AGENT_SESSION_CHUNK_BYTES, tail)),
    ).rejects.toThrow();

    const row = sessions.snapshot(run.runId, 1)!;
    expect(row).toMatchObject({
      itemId: run.itemId,
      runnerId: runnerA,
      ownerUserId: f.userId,
      agent: "claude",
      agentVersion: "0.88.0",
      sessionId: "6f1c2a8e-session",
      workspacePath: "/var/lib/paws-agent/work/run",
      commitSha: "b".repeat(40),
      turn: 7,
      sizeBytes: snapshot.length,
      sealedSize: snapshot.length,
      sha256: sha(snapshot),
      status: "sealed",
    });
    expect(row.sealedAt).not.toBeNull();
    expect(await collect(sessions.read({ ...access, generation: 1 }, 1))).toEqual(snapshot);
  });

  test("refuses a snapshot over the size cap", async () => {
    const runnerA = await f.enroll("a");
    const access = f.assign(f.startRun("first"), runnerA, 1);
    const sessions = createAgentSessions({
      db,
      work,
      objects,
      key,
      maxBytes: AGENT_SESSION_CHUNK_BYTES,
    });
    await sessions.upload(access, chunk(1, 0, full));
    await expect(
      sessions.upload(access, chunk(1, AGENT_SESSION_CHUNK_BYTES, tail)),
    ).rejects.toThrow();
    await expect(
      sessions.finish(access, finishFor(1, Buffer.concat([full, tail]))),
    ).rejects.toThrow();
    expect(objects.writes).toHaveLength(1);
  });

  test("stores only ciphertext bound to the run, generation and offset", async () => {
    const { sessions, access, run } = await sealed();
    const stored = [...objects.objects.values()];
    expect(stored).toHaveLength(3);
    for (const bytes of stored) {
      expect(Buffer.from(bytes).includes(MARKER)).toBe(false);
      expect(Buffer.from(bytes).equals(full)).toBe(false);
    }
    const keys = [...objects.objects.keys()];
    const offset0 = keys.find((name) => name.endsWith(`/1/0-${sha(full)}`))!;
    const offset1 = keys.find((name) =>
      name.endsWith(`/1/${AGENT_SESSION_CHUNK_BYTES}-${sha(full)}`),
    )!;
    expect(offset0.startsWith(`paws/agent-sessions/${f.workspaceId}/${run.runId}/1/`)).toBe(true);
    const reader = { ...access, generation: 1 };

    // Offsets 0 and 1 hold the same plaintext; only the offset in the additional data differs.
    const original0 = objects.objects.get(offset0)!;
    const original1 = objects.objects.get(offset1)!;
    objects.objects.set(offset0, original1);
    objects.objects.set(offset1, original0);
    await expect(collect(sessions.read(reader, 1))).rejects.toThrow(
      "Agent session storage is unavailable",
    );
    objects.objects.set(offset0, original0);
    objects.objects.set(offset1, original1);

    // Another key cannot decrypt the chunks.
    const otherKey = createAgentSessions({ db, work, objects, key: randomBytes(32) });
    await expect(collect(otherKey.read(reader, 1))).rejects.toThrow();

    // The same plaintext at the same offset in another run's snapshot does not decrypt here.
    const runnerB = await f.enroll("b");
    const second = f.startRun("second");
    const secondAccess = f.assign(second, runnerB, 1);
    await sessions.upload(secondAccess, chunk(1, 0, full));
    const secondKey = `paws/agent-sessions/${f.workspaceId}/${second.runId}/1/0-${sha(full)}`;
    objects.objects.set(offset0, objects.objects.get(secondKey)!);
    await expect(collect(sessions.read(reader, 1))).rejects.toThrow(
      "Agent session storage is unavailable",
    );
    objects.objects.set(offset0, original0);
    expect(await collect(sessions.read(reader, 1))).toEqual(snapshot);
  });

  test("refuses a stale grant, another run's grant and non-run commands", async () => {
    const { sessions, access, run } = await sealed();
    const runnerB = await f.enroll("b");
    const second = f.startRun("second");
    const secondAccess = f.assign(second, runnerB, 1);
    const fresh = work.issueGrant({
      runnerId: access.runnerId,
      runId: run.runId,
      commandId: db
        .query<{ id: string }, [string]>("SELECT command_id AS id FROM runner_work WHERE run_id=?")
        .get(run.runId)!.id,
      generation: 1,
    }).token;
    // The earlier grant was replaced, so it is stale.
    expect(() => sessions.read({ ...access, generation: 1 }, 1)).toThrow();
    expect(await collect(sessions.read({ ...access, token: fresh, generation: 1 }, 1))).toEqual(
      snapshot,
    );
    // Run two's grant cannot read or write run one.
    expect(() => sessions.read({ ...secondAccess, runId: run.runId, generation: 1 }, 1)).toThrow();
    await expect(
      sessions.upload({ ...secondAccess, runId: run.runId }, chunk(1, 0, full)),
    ).rejects.toThrow();
    await expect(
      sessions.upload({ ...access, token: fresh, runnerId: runnerB }, chunk(1, 0, full)),
    ).rejects.toThrow();

    const third = f.startRun("third");
    const runnerC = await f.enroll("c");
    const review = f.assign(third, runnerC, 1, "review");
    await expect(sessions.upload(review, chunk(1, 0, full))).rejects.toThrow(
      "Agent session request is refused",
    );
  });

  test("the run's new runner reads after the grant moves, and the old runner cannot", async () => {
    const { sessions, access, run } = await sealed();
    work.finish(run.runId, 1);
    const runnerC = await f.enroll("c");
    const moved = f.assign(run, runnerC, 2);
    expect(await collect(sessions.read({ ...moved, generation: 2 }, 1))).toEqual(snapshot);
    expect(() => sessions.read({ ...access, generation: 1 }, 1)).toThrow(RunnerWorkFencedError);
    expect(() => sessions.read({ ...access, generation: 2 }, 1)).toThrow();
    expect(() => sessions.read({ ...access, token: moved.token, generation: 2 }, 1)).toThrow();
    // A snapshot from a later generation, or one never sealed, is not readable.
    expect(() => sessions.read({ ...moved, generation: 2 }, 2)).toThrow();
    expect(() => sessions.read({ ...moved, generation: 2 }, 3)).toThrow();

    // A runner owned by another member never reads the owner's session.
    db.run("UPDATE agent_session_snapshot SET owner_user_id=? WHERE run_id=?", [
      putWorkspaceUser(db, {
        id: workspaceId(),
        linearUserId: "other",
        name: "Other",
        email: "other@example.invalid",
      }),
      run.runId,
    ]);
    expect(() => sessions.read({ ...moved, generation: 2 }, 1)).toThrow(
      "Agent session request is refused",
    );
  });

  test("a read stops when the grant moves mid-stream", async () => {
    const { sessions, access, run } = await sealed();
    const chunks = sessions.read({ ...access, generation: 1 }, 1);
    expect((await chunks.next()).value).toEqual(full);
    work.finish(run.runId, 1);
    await expect(chunks.next()).rejects.toThrow(RunnerWorkFencedError);
  });

  test("HTTP routes map fences to 409, storage to 503 and everything else to 403", async () => {
    const runnerA = await f.enroll("a");
    const run = f.startRun("first");
    const access = f.assign(run, runnerA, 1);
    let failRead = false;
    const faulty: AgentSessionObjects = {
      write: (name, bytes) => objects.write(name, bytes),
      read: (name) => (failRead ? Promise.reject(new Error("outage")) : objects.read(name)),
    };
    const http = createAgentSessionsHttp(createAgentSessions({ db, work, objects: faulty, key }));
    const post = (path: string, body: unknown, token = access.token, runnerId = runnerA) =>
      http(
        new Request(`https://runner.invalid/v1/runs/${run.runId}/session/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        runnerId,
      );
    expect(
      await http(new Request("https://runner.invalid/v1/runs/x/transcript/chunks"), runnerA),
    ).toBeNull();
    for (const [offset, bytes] of [
      [0, full],
      [AGENT_SESSION_CHUNK_BYTES, full],
      [2 * AGENT_SESSION_CHUNK_BYTES, tail],
    ] as const) {
      const response = (await post("chunks", chunk(1, offset, bytes)))!;
      expect(response.status).toBe(200);
    }
    expect((await post("chunks", "x".repeat(737_281)))!.status).toBe(403);
    expect((await post("chunks", chunk(1, 0, full), "A".repeat(43)))!.status).toBe(403);
    failRead = true;
    expect((await post("finish", finishFor(1, snapshot)))!.status).toBe(503);
    failRead = false;
    expect((await post("finish", { ...finishFor(1, snapshot), sha256: sha(tail) }))!.status).toBe(
      403,
    );
    const finished = (await post("finish", finishFor(1, snapshot)))!;
    expect(finished.status).toBe(200);

    const read = (await post("read", { generation: 1, snapshotGeneration: 1 }))!;
    expect(read.status).toBe(200);
    expect(read.headers.get("x-paws-session-sha256")).toBe(sha(snapshot));
    expect(Buffer.from(await read.arrayBuffer())).toEqual(snapshot);
    failRead = true;
    expect((await post("read", { generation: 1, snapshotGeneration: 1 }))!.status).toBe(503);
    failRead = false;

    work.finish(run.runId, 1);
    expect((await post("read", { generation: 1, snapshotGeneration: 1 }))!.status).toBe(409);
  });
});

describe("agent session storage on disk", () => {
  let root: string;
  beforeEach(() => {
    root = tempHome();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the key is created once in the secrets directory and is not stored in the clear", () => {
    const secrets = join(root, "secrets");
    const path = join(secrets, AGENT_SESSION_KEY_FILE);
    const key = loadAgentSessionKey(path);
    expect(key.length).toBe(32);
    expect(loadAgentSessionKey(path)).toEqual(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").includes(key.toString("base64"))).toBe(false);
  });

  test("local objects are owner-only files in an owner-only directory without links", async () => {
    const dir = join(root, "agent-sessions");
    const store = createLocalAgentSessionObjects(dir);
    const bytes = randomBytes(1024);
    await store.write("paws/agent-sessions/w/r/1/0-x", bytes);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(Buffer.from(await store.read("paws/agent-sessions/w/r/1/0-x"))).toEqual(bytes);
    await expect(store.read("paws/agent-sessions/w/r/1/missing")).rejects.toThrow();
    await expect(
      store.write("too-big", new Uint8Array(AGENT_SESSION_CHUNK_BYTES + 29)),
    ).rejects.toThrow();

    chmodSync(join(dir, files[0]!), 0o644);
    await expect(store.read("paws/agent-sessions/w/r/1/0-x")).rejects.toThrow();
    chmodSync(dir, 0o755);
    await expect(store.write("other", bytes)).rejects.toThrow("Unsafe agent session directory");

    const target = join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, "linked");
    symlinkSync(target, link);
    await expect(createLocalAgentSessionObjects(link).write("other", bytes)).rejects.toThrow();
    expect(() => createLocalAgentSessionObjects("relative")).toThrow();
  });
});

describe("agent session storage in S3", () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;
  const stored = new Map<string, Uint8Array>();
  const requests: string[] = [];
  beforeEach(() => {
    root = tempHome();
    stored.clear();
    requests.length = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (request.method === "PUT") {
          stored.set(path, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200, headers: { etag: '"fixture"' } });
        }
        const bytes = stored.get(path);
        if (request.method === "GET" && bytes) return new Response(bytes);
        return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      },
    });
  });
  afterEach(async () => {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  function s3() {
    const client = new S3Client({
      bucket: "fixture-sessions",
      endpoint: `http://127.0.0.1:${server.port}`,
      region: "fixture-region",
      accessKeyId: "fixture-key",
      secretAccessKey: "fixture-secret",
    });
    return createS3AgentSessionObjects({ client, bucket: "fixture-sessions" });
  }

  test("stores each sealed chunk as one object under its key and reads it back", async () => {
    const store = s3();
    const bytes = randomBytes(AGENT_SESSION_CHUNK_BYTES + 28);
    await store.write("paws/agent-sessions/w/r/1/0-abc", bytes);
    expect([...stored.keys()]).toEqual(["/fixture-sessions/paws/agent-sessions/w/r/1/0-abc"]);
    expect(Buffer.from(await store.read("paws/agent-sessions/w/r/1/0-abc"))).toEqual(bytes);
    await expect(store.read("paws/agent-sessions/w/r/1/missing")).rejects.toThrow();
    await expect(
      store.write("too-big", new Uint8Array(AGENT_SESSION_CHUNK_BYTES + 29)),
    ).rejects.toThrow("Agent session chunk exceeds size limit");
    expect(stored.has("/fixture-sessions/too-big")).toBe(false);

    stored.set("/fixture-sessions/oversized", new Uint8Array(AGENT_SESSION_CHUNK_BYTES + 29));
    await expect(store.read("oversized")).rejects.toThrow(
      "Agent session object exceeds size limit",
    );
    expect(() =>
      createS3AgentSessionObjects({ client: new S3Client({}), bucket: "Not A Bucket" }),
    ).toThrow();
  });

  test("writes go to S3 and chunks stored locally before S3 still read", async () => {
    const local = createLocalAgentSessionObjects(join(root, "agent-sessions"));
    const objects = withLocalAgentSessionFallback(local, s3());
    const remote = randomBytes(64);
    await objects.write("remote", remote);
    expect(stored.has("/fixture-sessions/remote")).toBe(true);
    expect(Buffer.from(await objects.read("remote"))).toEqual(remote);

    const earlier = randomBytes(64);
    await local.write("earlier", earlier);
    requests.length = 0;
    expect(Buffer.from(await objects.read("earlier"))).toEqual(earlier);
    expect(requests).toEqual([]);

    chmodSync(join(root, "agent-sessions"), 0o755);
    await expect(objects.read("earlier")).rejects.toThrow("Unsafe agent session directory");
  });

  test("a snapshot sealed through S3 stores only ciphertext there and reads back", async () => {
    const f = await fixture(root);
    try {
      const objects = withLocalAgentSessionFallback(
        createLocalAgentSessionObjects(join(root, "agent-sessions")),
        s3(),
      );
      const sessions = createAgentSessions({
        db: f.db,
        work: f.work,
        objects,
        key: randomBytes(32),
      });
      const access = f.assign(f.startRun("first"), await f.enroll("a"), 1);
      await sessions.upload(access, chunk(1, 0, full));
      await sessions.upload(access, chunk(1, AGENT_SESSION_CHUNK_BYTES, full));
      await sessions.upload(access, chunk(1, 2 * AGENT_SESSION_CHUNK_BYTES, tail));
      await sessions.finish(access, finishFor(1, snapshot));
      expect(stored.size).toBe(3);
      for (const [path, bytes] of stored) {
        expect(path.startsWith(`/fixture-sessions/paws/agent-sessions/${f.workspaceId}/`)).toBe(
          true,
        );
        expect(Buffer.from(bytes).includes(MARKER)).toBe(false);
      }
      expect(await collect(sessions.read({ ...access, generation: 1 }, 1))).toEqual(snapshot);
    } finally {
      f.db.close();
    }
  });
});
