import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactSnapshot, PublishArtifactContext } from "../src/acp";
import { FakeClock } from "../src/core";
import {
  getEvidence,
  insertQueuedItem,
  listOutbox,
  migrate,
  OutboxDispatcher,
  openDatabase,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeTracker, createLinearFileTransfer } from "../src/linear";
import { createEvidenceArtifactPublisher, deliverLinearOutbox } from "../src/loop";
import { tempHome } from "./helpers";

const MB = 1024 * 1024;
const ASSET = "https://uploads.linear.app/workspace/evidence";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_HEAD = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
]);

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sized(head: Buffer, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 1);
  head.copy(buffer);
  return buffer;
}

function setup() {
  const home = tempHome();
  homes.push(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  const root = join(home, "evidence");
  const store = createEvidenceStore({ db, root });
  const uploads: string[] = [];
  const failures = { remaining: 0 };
  const files = createLinearFileTransfer({
    client: {
      async query(_query, variables) {
        uploads.push(String((variables as { filename?: string }).filename));
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: ASSET,
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "token";
      },
    },
    fetch: async () => {
      if (failures.remaining > 0) {
        failures.remaining--;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    },
    maxBytes: 50 * MB,
  });
  const publisher = createEvidenceArtifactPublisher({
    db,
    evidence: store,
    publicUrl: "https://paws.example",
    itemId: "item",
    sessionId: "session",
    uploads: true,
  });
  const context: PublishArtifactContext = {
    itemId: "item",
    runId: "run-1",
    worktreePath: home,
    role: "implementer",
    signal: new AbortController().signal,
    evidence: { checkId: "visual-proof", attempt: 1, headCommit: "a".repeat(40) },
  };
  const publish = (displayName: string, mimeType: string, bytes: Buffer) => {
    const artifact: ArtifactSnapshot = {
      path: displayName,
      displayName,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: new Blob([bytes]),
    };
    return publisher.publish(artifact, context);
  };
  const tracker = createFakeTracker();
  const clock = new FakeClock(Date.now());
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, delivery) =>
    deliverLinearOutbox(row, tracker, async () => {}, delivery, db, { files, root }),
  );
  async function deliver(rounds = 1) {
    for (let round = 0; round < rounds; round++) {
      dispatcher.tick();
      await dispatcher.idle();
      clock.advance(3_600_000);
    }
  }
  return { db, publish, tracker, uploads, failures, deliver };
}

function evidenceId(url: string): string {
  return url.split("/").at(-1)!;
}

function rows(db: Database) {
  return listOutbox(db, "session");
}

test("a published screenshot is uploaded once and its activity embeds the asset URL", async () => {
  const f = setup();
  try {
    const published = await f.publish(
      "Settings → Agents, desktop",
      "image/png",
      sized(PNG_HEAD, 64),
    );
    await f.publish("Settings → Agents, desktop", "image/png", sized(PNG_HEAD, 64));
    expect(rows(f.db).map((row) => row.op)).toEqual(["linear.evidence"]);
    expect(f.uploads).toHaveLength(0);

    await f.deliver(3);
    expect(f.uploads).toEqual(["Settings → Agents, desktop"]);
    expect(rows(f.db).map((row) => row.status)).toEqual(["sent"]);
    expect(getEvidence(f.db, evidenceId(published.url))?.assetUrl).toBe(ASSET);
    expect(f.tracker.progress).toHaveLength(1);
    expect(f.tracker.progress[0]).toMatchObject({ sessionId: "session", kind: "thought" });
    expect(f.tracker.progress[0]!.body).toBe(
      [
        "Closeout evidence for check `visual-proof`:",
        `![Settings → Agents, desktop](<${ASSET}>)`,
        `In Paws: [Settings → Agents, desktop](<${published.url}>)`,
      ].join("\n\n"),
    );
  } finally {
    f.db.close();
  }
});

test("a failed upload retries through the outbox", async () => {
  const f = setup();
  try {
    f.failures.remaining = 1;
    const published = await f.publish("clip.webm", "video/webm", sized(WEBM_HEAD, 2 * MB));
    await f.deliver();
    const [failed] = rows(f.db);
    expect(failed).toMatchObject({ status: "pending", attempts: 1 });
    expect(failed!.error).toContain("HTTP 503");
    expect(f.tracker.progress).toHaveLength(0);
    expect(getEvidence(f.db, evidenceId(published.url))?.assetUrl).toBeNull();

    await f.deliver(3);
    expect(rows(f.db).map((row) => row.status)).toEqual(["sent"]);
    expect(f.uploads).toEqual(["clip.webm", "clip.webm"]);
    expect(f.tracker.progress).toHaveLength(1);
    expect(f.tracker.progress[0]!.body).toContain(`![clip.webm](<${ASSET}>)`);
  } finally {
    f.db.close();
  }
});

test("an upload that keeps failing posts the Paws link on the last attempt", async () => {
  const f = setup();
  try {
    f.failures.remaining = 100;
    const published = await f.publish("shot.png", "image/png", sized(PNG_HEAD, 64));
    await f.deliver(10);
    expect(rows(f.db).map((row) => row.status)).toEqual(["sent"]);
    expect(f.tracker.progress.map((update) => update.body)).toEqual([
      `Closeout evidence for check \`visual-proof\`: [shot.png](<${published.url}>)\n\nPaws could not upload this file to Linear.`,
    ]);
  } finally {
    f.db.close();
  }
});

test("an oversized video posts the link and the note", async () => {
  const f = setup();
  try {
    const published = await f.publish("walkthrough.webm", "video/webm", sized(WEBM_HEAD, 51 * MB));
    expect(rows(f.db).map((row) => row.op)).toEqual(["activity"]);
    await f.deliver(3);
    expect(f.uploads).toHaveLength(0);
    expect(f.tracker.progress.map((update) => update.body)).toEqual([
      `Closeout evidence for check \`visual-proof\`: [walkthrough.webm](<${published.url}>)\n\nThis video is larger than 50 MB, so it is only in Paws.`,
    ]);
  } finally {
    f.db.close();
  }
});

test("a screenshot over 10 MB keeps only the Paws link", async () => {
  const f = setup();
  try {
    await f.publish("full-page.png", "image/png", sized(PNG_HEAD, 11 * MB));
    await f.deliver(3);
    expect(f.uploads).toHaveLength(0);
    expect(f.tracker.progress[0]!.body).toContain(
      "This image is larger than 10 MB, so it is only in Paws.",
    );
  } finally {
    f.db.close();
  }
});
