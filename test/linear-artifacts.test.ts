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
  openPawsStore,
  OutboxDispatcher,
  stopOutboxSession,
  type Db,
} from "../src/db";
import { createLinearFileTransfer } from "../src/linear";
import { createLinearArtifactPublisher, createLinearArtifactReader } from "../src/loop";
import { tempHome } from "./helpers";
import { copyMigratedPglite, tempStore } from "./pglite";

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

async function setup(
  options: { failAfterUpload?: boolean; fail?: boolean; expired?: boolean } = {},
  database?: { db: Db; close(): Promise<void> },
) {
  const { db, close } = database ?? (await tempStore());
  await insertQueuedItem(db, { id: "item", sessionKey: "session" });
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
  const publisher = (store = db) =>
    createLinearArtifactPublisher({
      store,
      files,
      secretsDir,
      itemId: "item",
      sessionId: "session",
    });
  return { db, close, publisher, secretsDir, prepares: () => prepares, uploads: () => uploads };
}

test("artifact publication persists immutable bytes privately and a durable inline image", async () => {
  const env = await setup();
  expect(await (await env.publisher()).publish(artifact, context)).toEqual({
    url: URL,
    displayName: "proof.png",
  });
  const rows = await listArtifacts(env.db, "item");
  expect(rows[0]?.state).toBe("uploaded");
  expect(await artifactPublicationReady(env.db, "item")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("private-secret");
  const directory = join(env.secretsDir, "linear-artifacts");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const filename of await readdir(directory))
    expect((await stat(join(directory, filename))).mode & 0o777).toBe(0o600);
  expect(new Uint8Array(await readFile(join(directory, `${rows[0]!.id}.bytes`)))).toEqual(bytes);
  expect((await listOutbox(env.db, "session"))[0]?.payload).toMatchObject({
    body: `![proof.png](<${URL}>)`,
  });
  expect(await (await env.publisher()).publish(artifact, context)).toMatchObject({ url: URL });
  expect(env.prepares()).toBe(1);
  expect(env.uploads()).toBe(1);
  expect(await listOutbox(env.db, "session")).toHaveLength(1);
  await env.close();
});

test("dashboard artifact reads return the private snapshot rather than mutable workspace bytes or signed manifests", async () => {
  const env = await setup();
  await (await env.publisher()).publish(artifact, context);
  const row = (await listArtifacts(env.db, "item"))[0]!;
  const read = createLinearArtifactReader({ ...env, store: env.db });
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
  await env.close();
});

test("dashboard can read a prepared artifact while publication retries without exposing upload credentials", async () => {
  const env = await setup({ fail: true });
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow();
  const row = (await listArtifacts(env.db, "item"))[0]!;
  expect(row.state).toBe("failed");
  expect(await createLinearArtifactReader({ ...env, store: env.db })(row.id)).toEqual({
    bytes,
    displayName: "proof.png",
    mimeType: "image/png",
  });
  await env.close();
});

test("restart reconciles an uploaded asset after losing the PUT response", async () => {
  const pgliteDir = join(tempHome(), "pglite");
  await copyMigratedPglite(pgliteDir);
  const opened = await openPawsStore({ url: null, pgliteDir });
  const env = await setup({ failAfterUpload: true }, { db: opened.store, close: opened.close });
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow(
    "upload request failed",
  );
  expect((await listArtifacts(env.db, "item"))[0]?.state).toBe("failed");
  expect(await artifactPublicationReady(env.db, "item")).toBe(false);
  expect(await listOutbox(env.db, "session")).toHaveLength(0);
  await env.close();
  const reopened = await openPawsStore({ url: null, pgliteDir });
  try {
    expect(await (await env.publisher(reopened.store)).publish(artifact, context)).toMatchObject({
      url: URL,
    });
    expect(env.prepares()).toBe(1);
    expect(env.uploads()).toBe(1);
    expect((await listArtifacts(reopened.store, "item"))[0]?.state).toBe("uploaded");
  } finally {
    await reopened.close();
  }
});

test("concurrent identical publications share one upload and durable result", async () => {
  const env = await setup();
  const publisher = await env.publisher();
  const results = await Promise.all([
    publisher.publish(artifact, context),
    publisher.publish(artifact, context),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(env.uploads()).toBe(1);
  await env.close();
});

test("failed uploads remain incomplete and never publish a link", async () => {
  const env = await setup({ fail: true });
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow("HTTP 503");
  expect(await artifactPublicationReady(env.db, "item")).toBe(false);
  expect(await listOutbox(env.db, "session")).toHaveLength(0);
  await env.close();
});

test("Stop fences a captured artifact callback from posting a late success", async () => {
  const env = await setup();
  const publisher = await env.publisher();
  await stopOutboxSession(env.db, "linear", "session", 1);
  await publisher.publish(artifact, context);
  expect((await listOutbox(env.db, "session"))[0]?.status).toBe("dropped");
  await env.close();
});

test("recovery refuses tampered snapshot bytes before a second upload", async () => {
  const env = await setup({ fail: true });
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow();
  const row = (await listArtifacts(env.db, "item"))[0]!;
  await writeFile(join(env.secretsDir, "linear-artifacts", `${row.id}.bytes`), "tampered");
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow("integrity");
  expect(env.uploads()).toBe(1);
  await env.close();
});

test("expired restored destinations refresh after confirming the old asset is absent", async () => {
  const env = await setup({ expired: true });
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow("HTTP 403");
  expect(await (await env.publisher()).publish(artifact, context)).toMatchObject({ url: URL });
  expect(env.prepares()).toBe(2);
  expect(await artifactPublicationReady(env.db, "item")).toBe(true);
  await env.close();
});

test("a successful replacement resolves a failed artifact at the same path", async () => {
  const options = { fail: true };
  const env = await setup(options);
  await expect((await env.publisher()).publish(artifact, context)).rejects.toThrow("HTTP 503");
  const replacementBytes = new TextEncoder().encode("replacement bytes");
  const replacement = {
    ...artifact,
    sizeBytes: replacementBytes.length,
    bytes: new Blob([replacementBytes]),
    sha256: createHash("sha256").update(replacementBytes).digest("hex"),
  };
  options.fail = false;
  await (await env.publisher()).publish(replacement, context);
  expect(await artifactPublicationReady(env.db, "item")).toBe(true);
  expect(await listArtifacts(env.db, "item")).toHaveLength(2);
  await env.close();
});

test("a pending artifact link survives final response and is delivered first", async () => {
  const env = await setup();
  await (await env.publisher()).publish(artifact, context);
  await enqueueOutbox(env.db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: "final",
    payload: { sessionId: "session", kind: "response", body: "Done" },
  });
  const pending = await listOutbox(env.db, "session");
  expect(pending[0]?.status).toBe("pending");
  expect((await claimOutboxHeads(env.db, { now: Date.now() }))[0]?.id).toBe(pending[0]?.id);
  await env.close();
});

test.each([false, true])(
  "exhausted artifact delivery cannot trap completion, final already queued: %s",
  async (finalAlreadyQueued) => {
    const env = await setup();
    try {
      await (await env.publisher()).publish(artifact, context);
      await env.db.run((q) => q.exec(q.orm.update(q.t.outbox).set({ maxAttempts: 1 })));
      const final = async () =>
        await enqueueOutbox(env.db, {
          target: "linear",
          op: "activity",
          orderingKey: "session",
          idempotencyKey: "final",
          payload: { sessionId: "session", kind: "response", body: "Done" },
        });
      if (finalAlreadyQueued) await final();
      const dispatcher = new OutboxDispatcher(env.db, { now: Date.now, mono: Date.now });
      dispatcher.setHandler(async () => {
        throw new Error("delivery exhausted");
      });
      await dispatcher.tick();
      await dispatcher.idle();
      if (!finalAlreadyQueued) await final();
      await enqueueOutbox(env.db, {
        target: "linear",
        op: "status",
        orderingKey: "session",
        idempotencyKey: "completed-status",
        payload: { sessionId: "session", stateType: "completed" },
      });
      expect((await listOutbox(env.db, "session"))[0]?.status).toBe("dead");
      const response = (await claimOutboxHeads(env.db))[0]!;
      expect(response.idempotencyKey).toBe("final");
      expect(await completeOutbox(env.db, response)).toBe(true);
      expect((await claimOutboxHeads(env.db))[0]?.idempotencyKey).toBe("completed-status");
    } finally {
      await env.close();
    }
  },
);

test("an uploaded replacement still resolves a legacy failed artifact by its exact path", async () => {
  const env = await setup();
  await saveArtifact(
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
  await markArtifact(env.db, "legacy", null);
  expect(await artifactPublicationReady(env.db, "item")).toBe(false);
  await (await env.publisher()).publish(artifact, context);
  expect(await artifactPublicationReady(env.db, "item")).toBe(true);
  await env.close();
});
