import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ArtifactRejectedError,
  type ArtifactSnapshot,
  type PublishArtifactContext,
} from "../src/acp";
import {
  artifactPublicationReady,
  insertQueuedItem,
  listArtifacts,
  listEvidence,
  listOutbox,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeTracker, type LinearFileTransfer } from "../src/linear";
import { createLinearArtifactPublisher, deliverLinearOutbox } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const HEAD = "d".repeat(40);
const WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
  0x42, 0x87, 0x81, 0x04,
]);

function snapshot(bytes: Uint8Array, extra: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    path: "videos/flow.webm",
    displayName: "flow.webm",
    mimeType: "video/webm",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: new Blob([bytes]),
    evidence: { checkId: "ui-video", attempt: 2, headCommit: HEAD },
    ...extra,
  };
}

const context: PublishArtifactContext = {
  request: { path: "videos/flow.webm", checkId: "ui-video" },
  itemId: "item",
  runId: "run-7",
  worktreePath: "/unused",
  role: "implementer",
  signal: new AbortController().signal,
};

function setup(options: { publicUrl?: string | null; limits?: { video: number; image: number } }) {
  const db = tempDb();
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  const home = tempHome();
  const linearCalls: string[] = [];
  const files: LinearFileTransfer = {
    async prepareUpload() {
      linearCalls.push("prepareUpload");
      throw new Error("Linear upload is not expected");
    },
    async uploadPrepared() {
      linearCalls.push("uploadPrepared");
      throw new Error("Linear upload is not expected");
    },
    async upload() {
      linearCalls.push("upload");
      throw new Error("Linear upload is not expected");
    },
    async download() {
      linearCalls.push("download");
      throw new Error("Linear download is not expected");
    },
  };
  const publicUrl = options.publicUrl === undefined ? "https://paws.example/" : options.publicUrl;
  const publisher = createLinearArtifactPublisher({
    db,
    files,
    secretsDir: join(home, "secrets"),
    itemId: "item",
    issueId: "issue-1",
    sessionId: "session",
    ...(publicUrl === null
      ? {}
      : {
          evidence: {
            store: createEvidenceStore({
              db,
              root: join(home, "evidence"),
              ...(options.limits ? { limits: options.limits } : {}),
            }),
            publicUrl,
          },
        }),
  });
  return { db, publisher, linearCalls };
}

test("a video published with a check id is kept in Paws and Linear gets a Paws link", async () => {
  const env = setup({});
  const attempt = env.publisher.begin?.(context.request!, context);
  const published = await env.publisher.publish(snapshot(WEBM), context);
  attempt?.complete();
  const [stored] = listEvidence(env.db, "item");
  expect(stored).toMatchObject({
    runId: "run-7",
    checkId: "ui-video",
    attempt: 2,
    headCommit: HEAD,
    mediaType: "video/webm",
    displayName: "flow.webm",
  });
  expect(published).toEqual({
    url: `https://paws.example/evidence/${stored!.id}`,
    displayName: "flow.webm",
  });
  expect(env.linearCalls).toEqual([]);
  expect(listArtifacts(env.db, "item")).toEqual([]);
  expect(artifactPublicationReady(env.db, "item")).toBe(true);

  const tracker = createFakeTracker();
  for (const row of listOutbox(env.db, "session"))
    await deliverLinearOutbox(row, tracker, async () => undefined);
  expect(tracker.progress).toHaveLength(1);
  expect(tracker.progress[0]).toMatchObject({ sessionId: "session", kind: "thought" });
  expect(tracker.progress[0]?.body).toBe(
    `Video for Closeout check \`ui-video\`, attempt 2: [flow.webm](<https://paws.example/evidence/${stored!.id}>)`,
  );
  expect(tracker.attachments).toEqual([]);
});

test("a file over the evidence cap is refused with an error the agent can read", async () => {
  const env = setup({ limits: { video: 8, image: 8 } });
  const error = await env.publisher.publish(snapshot(WEBM), context).catch((caught) => caught);
  expect(error).toBeInstanceOf(ArtifactRejectedError);
  expect((error as Error).message).toContain("larger than");
  expect(listEvidence(env.db, "item")).toEqual([]);
  expect(listOutbox(env.db, "session")).toEqual([]);
});

test("a file that is not a video or screenshot is refused as evidence", async () => {
  const env = setup({});
  const error = await env.publisher
    .publish(snapshot(new TextEncoder().encode("not a video")), context)
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(ArtifactRejectedError);
  expect((error as Error).message).toContain("WebM and MP4");
  expect(env.linearCalls).toEqual([]);
});

test("evidence needs a public URL and never falls back to a Linear upload", async () => {
  const env = setup({ publicUrl: null });
  const error = await env.publisher.publish(snapshot(WEBM), context).catch((caught) => caught);
  expect(error).toBeInstanceOf(ArtifactRejectedError);
  expect(env.linearCalls).toEqual([]);
});

test("a screenshot without a check id still goes through the Linear upload", async () => {
  const env = setup({});
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const request = { path: "shot.png" };
  env.publisher.begin?.(request, { ...context, request });
  await expect(
    env.publisher.publish(
      snapshot(png, { path: "shot.png", mimeType: "image/png", evidence: undefined }),
      { ...context, request },
    ),
  ).rejects.toThrow("Linear upload is not expected");
  expect(env.linearCalls).toEqual(["prepareUpload"]);
  expect(listEvidence(env.db, "item")).toEqual([]);
  expect(artifactPublicationReady(env.db, "item")).toBe(false);
});
