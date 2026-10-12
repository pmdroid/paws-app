import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactSnapshot, PublishArtifactContext } from "../src/acp";
import {
  artifactPublicationReady,
  claimOutboxHeads,
  completeOutbox,
  enqueueOutbox,
  insertQueuedItem,
  listArtifacts,
  listOutbox,
  saveArtifact,
  markArtifact,
  OutboxDispatcher,
  stopOutboxSession,
} from "../src/db";
import { createLinearFileTransfer } from "../src/linear";
import { createLinearArtifactPublisher, createLinearArtifactReader } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const URL = "https://uploads.linear.app/workspace/proof.png";
const SIGNED = "https://storage.example/upload?signature=private-secret";
const bytes = new TextEncoder().encode("snapshot bytes");
const artifact: ArtifactSnapshot = {
  path: "proof.png",
  displayName: "proof.png",
  mimeType: "image/png",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: new Blob([bytes]),
};
const context: PublishArtifactContext = {
  itemId: "ENG-1",
  runId: "run-1",
  worktreePath: "/unused",
  role: "implementer",
  signal: new AbortController().signal,
};

function setup(options: { failAfterUpload?: boolean; fail?: boolean; expired?: boolean } = {}) {
  const db = tempDb();
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  const secretsDir = join(tempHome(), "secrets");
  let prepares = 0;
  let uploads = 0;
  let stored: Uint8Array | null = null;
  let lostResponse = options.failAfterUpload;
  const files = createLinearFileTransfer({
    client: {
      async query() {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: `${SIGNED}&attempt=${++prepares}`,
              assetUrl: URL,
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only-token";
      },
    },
    fetch: async (url, request) => {
      if (request?.method === "PUT") {
        uploads++;
        if (options.fail) return new Response(null, { status: 503 });
        if (options.expired && String(url).includes("attempt=1"))
          return new Response(null, { status: 403 });
        stored = new Uint8Array(request.body as Uint8Array);
        if (lostResponse) {
          lostResponse = false;
          throw new Error("lost response private-secret");
        }
        return new Response(null, { status: 200 });
      }
      return stored === null ? new Response(null, { status: 404 }) : new Response(stored);
    },
  });
  const publisher = () =>
    createLinearArtifactPublisher({ db, files, secretsDir, itemId: "item", sessionId: "session" });
  return { db, publisher, secretsDir, prepares: () => prepares, uploads: () => uploads };
}

test("artifact publication persists immutable bytes privately and a durable inline image", async () => {
  const env = setup();
  expect(await env.publisher().publish(artifact, context)).toEqual({
    url: URL,
    displayName: "proof.png",
  });
  const rows = listArtifacts(env.db, "item");
  expect(rows[0]?.state).toBe("uploaded");
  expect(artifactPublicationReady(env.db, "item")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private-secret");
  const directory = join(env.secretsDir, "linear-artifacts");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const filename of await readdir(directory))
    expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o600);
  expect(new Uint8Array(await readFile(join(directory, `${rows[0]!.id}.bytes`)))).toEqual(bytes);
  expect(listOutbox(env.db, "session")[0]?.payload).toMatchObject({
    body: `![proof.png](<${URL}>)`,
  });
  expect(await env.publisher().publish(artifact, context)).toMatchObject({ url: URL });
  expect(env.prepares()).toBe(1);
  expect(env.uploads()).toBe(1);
  expect(listOutbox(env.db, "session")).toHaveLength(1);
  env.db.close();
});

test("dashboard artifact reads return the private snapshot rather than mutable workspace bytes or signed manifests", async () => {
  const env = setup();
  await env.publisher().publish(artifact, context);
  const row = listArtifacts(env.db, "item")[0]!;
  const read = createLinearArtifactReader(env);
  expect(await read(row.id)).toEqual({ bytes, displayName: "proof.png", mimeType: "image/png" });
  expect(await read("../../secrets")).toBeNull();
  expect(await read(crypto.randomUUID())).toBeNull();
  expect(JSON.stringify(await read(row.id))).not.toContain("private-secret");
  const path = join(env.secretsDir, "linear-artifacts", `${row.id}.bytes`);
  await writeFile(path, new Uint8Array(bytes.length));
  await expect(read(row.id)).rejects.toThrow("integrity");
  await writeFile(path, bytes);
  await chmod(path, 0o644);
  await expect(read(row.id)).rejects.toThrow("invalid");
  await chmod(path, 0o600);
  await unlink(path);
  await symlink(join(env.secretsDir, "linear-artifacts", `${row.id}.upload`), path);
  await expect(read(row.id)).rejects.toThrow();
  env.db.close();
});

test("dashboard can read a prepared artifact while publication retries without exposing upload credentials", async () => {
  const env = setup({ fail: true });
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow();
  const row = listArtifacts(env.db, "item")[0]!;
  expect(row.state).toBe("failed");
  expect(await createLinearArtifactReader(env)(row.id)).toEqual({
    bytes,
    displayName: "proof.png",
    mimeType: "image/png",
  });
  env.db.close();
});

test("restart reconciles an uploaded asset after losing the PUT response", async () => {
  const env = setup({ failAfterUpload: true });
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow("upload request failed");
  expect(listArtifacts(env.db, "item")[0]?.state).toBe("failed");
  expect(artifactPublicationReady(env.db, "item")).toBe(false);
  expect(listOutbox(env.db, "session")).toHaveLength(0);
  expect(await env.publisher().publish(artifact, context)).toMatchObject({ url: URL });
  expect(env.prepares()).toBe(1);
  expect(env.uploads()).toBe(1);
  expect(listArtifacts(env.db, "item")[0]?.state).toBe("uploaded");
  env.db.close();
});

test("concurrent identical publications share one upload and durable result", async () => {
  const env = setup();
  const publisher = env.publisher();
  const results = await Promise.all([
    publisher.publish(artifact, context),
    publisher.publish(artifact, context),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(env.uploads()).toBe(1);
  env.db.close();
});

test("failed uploads remain incomplete and never publish a link", async () => {
  const env = setup({ fail: true });
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow("HTTP 503");
  expect(artifactPublicationReady(env.db, "item")).toBe(false);
  expect(listOutbox(env.db, "session")).toHaveLength(0);
  env.db.close();
});

test("Stop fences a captured artifact callback from posting a late success", async () => {
  const env = setup();
  const publisher = env.publisher();
  stopOutboxSession(env.db, "linear", "session", 1);
  await publisher.publish(artifact, context);
  expect(listOutbox(env.db, "session")[0]?.status).toBe("dropped");
  env.db.close();
});

test("recovery refuses tampered snapshot bytes before a second upload", async () => {
  const env = setup({ fail: true });
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow();
  const row = listArtifacts(env.db, "item")[0]!;
  await writeFile(join(env.secretsDir, "linear-artifacts", `${row.id}.bytes`), "tampered");
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow("integrity");
  expect(env.uploads()).toBe(1);
  env.db.close();
});

test("expired restored destinations refresh after confirming the old asset is absent", async () => {
  const env = setup({ expired: true });
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow("HTTP 403");
  expect(await env.publisher().publish(artifact, context)).toMatchObject({ url: URL });
  expect(env.prepares()).toBe(2);
  expect(artifactPublicationReady(env.db, "item")).toBe(true);
  env.db.close();
});

test("a successful replacement resolves a failed artifact at the same path", async () => {
  const options = { fail: true };
  const env = setup(options);
  await expect(env.publisher().publish(artifact, context)).rejects.toThrow("HTTP 503");
  const replacementBytes = new TextEncoder().encode("replacement bytes");
  const replacement = {
    ...artifact,
    sizeBytes: replacementBytes.length,
    bytes: new Blob([replacementBytes]),
    sha256: createHash("sha256").update(replacementBytes).digest("hex"),
  };
  options.fail = false;
  await env.publisher().publish(replacement, context);
  expect(artifactPublicationReady(env.db, "item")).toBe(true);
  expect(listArtifacts(env.db, "item")).toHaveLength(2);
  env.db.close();
});

test("a pending artifact link survives final response and is delivered first", async () => {
  const env = setup();
  await env.publisher().publish(artifact, context);
  enqueueOutbox(env.db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: "final",
    payload: { sessionId: "session", kind: "response", body: "Done" },
  });
  const pending = listOutbox(env.db, "session");
  expect(pending[0]?.status).toBe("pending");
  expect(claimOutboxHeads(env.db, { now: Date.now() })[0]?.id).toBe(pending[0]?.id);
  env.db.close();
});

test.each([false, true])(
  "exhausted artifact delivery cannot trap completion, final already queued: %s",
  async (finalAlreadyQueued) => {
    const env = setup();
    try {
      await env.publisher().publish(artifact, context);
      env.db.run("UPDATE outbox SET max_attempts = 1");
      const final = () =>
        enqueueOutbox(env.db, {
          target: "linear",
          op: "activity",
          orderingKey: "session",
          idempotencyKey: "final",
          payload: { sessionId: "session", kind: "response", body: "Done" },
        });
      if (finalAlreadyQueued) final();
      const dispatcher = new OutboxDispatcher(env.db, { now: Date.now, mono: Date.now });
      dispatcher.setHandler(async () => {
        throw new Error("delivery exhausted");
      });
      dispatcher.tick();
      await dispatcher.idle();
      if (!finalAlreadyQueued) final();
      enqueueOutbox(env.db, {
        target: "linear",
        op: "status",
        orderingKey: "session",
        idempotencyKey: "completed-status",
        payload: { sessionId: "session", stateType: "completed" },
      });
      expect(listOutbox(env.db, "session")[0]?.status).toBe("dead");
      const response = claimOutboxHeads(env.db)[0]!;
      expect(response.idempotencyKey).toBe("final");
      expect(completeOutbox(env.db, response)).toBe(true);
      expect(claimOutboxHeads(env.db)[0]?.idempotencyKey).toBe("completed-status");
    } finally {
      env.db.close();
    }
  },
);

test("an uploaded replacement still resolves a legacy failed artifact by its exact path", async () => {
  const env = setup();
  saveArtifact(
    env.db,
    {
      id: "legacy",
      itemId: "item",
      runId: "old-run",
      path: artifact.path,
      displayName: artifact.displayName,
      mimeType: artifact.mimeType,
      sizeBytes: 0,
      sha256: "legacy",
      state: "failed",
      assetUrl: null,
    },
    1,
  );
  markArtifact(env.db, "legacy", null);
  expect(artifactPublicationReady(env.db, "item")).toBe(false);
  await env.publisher().publish(artifact, context);
  expect(artifactPublicationReady(env.db, "item")).toBe(true);
  env.db.close();
});
