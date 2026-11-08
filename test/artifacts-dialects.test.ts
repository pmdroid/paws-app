import { afterEach, expect, test } from "bun:test";
import {
  artifactAttachmentRequestedSteps,
  artifactPublicationReadySteps,
  beginArtifactAttemptSteps,
  completeArtifactAttemptSteps,
  getArtifactSteps,
  listArtifactsSteps,
  markArtifactSteps,
  requestArtifactAttachmentSteps,
  saveArtifactSteps,
  type Db,
  type StoredArtifact,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await insertWorkItem(handle.db, "a");
  return handle.db;
}

function artifact(id: string, sha256: string): StoredArtifact {
  return {
    id,
    itemId: "a",
    runId: "r",
    path: "out/shot.png",
    displayName: "shot.png",
    mimeType: "image/png",
    sizeBytes: 3,
    sha256,
    state: "pending",
    assetUrl: null,
  };
}

forEachDialect((open) => {
  test("an artifact is saved once, marked and listed", async () => {
    const db = await connect(open);
    const first = artifact("x1", "s1");
    expect(await db.run((q) => saveArtifactSteps(q, first, 1))).toEqual(first);
    expect(await db.run((q) => saveArtifactSteps(q, { ...first, id: "x2" }, 2))).toEqual(first);
    await db.run((q) => markArtifactSteps(q, "x1", "https://asset"));
    const uploaded = { ...first, state: "uploaded" as const, assetUrl: "https://asset" };
    expect(await db.run((q) => getArtifactSteps(q, "x1"))).toEqual(uploaded);
    expect(await db.run((q) => getArtifactSteps(q, "x2"))).toBeNull();
    await db.run((q) => markArtifactSteps(q, "x1", null));
    expect(await db.run((q) => listArtifactsSteps(q, "a"))).toEqual([
      { ...first, state: "failed" },
    ]);
  });

  test("publication waits for attempts and the newest request of each artifact", async () => {
    const db = await connect(open);
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(true);
    expect(await db.run((q) => beginArtifactAttemptSteps(q, "a", "h"))).toBe(1);
    expect(await db.run((q) => beginArtifactAttemptSteps(q, "a", "h"))).toBe(2);
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(false);
    await db.run((q) => completeArtifactAttemptSteps(q, "a", "h", 2));
    await db.run((q) => completeArtifactAttemptSteps(q, "a", "h", 1));
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(true);

    await db.run((q) => saveArtifactSteps(q, { ...artifact("x1", "s1"), identityHash: "h" }, 1));
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(false);
    await db.run((q) => saveArtifactSteps(q, { ...artifact("x2", "s2"), identityHash: "h" }, 2));
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(false);
    await db.run((q) => markArtifactSteps(q, "x2", "https://asset"));
    expect(await db.run((q) => artifactPublicationReadySteps(q, "a"))).toBe(true);
  });

  test("an attachment is requested per attempt", async () => {
    const db = await connect(open);
    await db.run((q) => beginArtifactAttemptSteps(q, "a", "h"));
    expect(await db.run((q) => artifactAttachmentRequestedSteps(q, "a", "h"))).toBe(false);
    await db.run((q) => requestArtifactAttachmentSteps(q, "a", "h"));
    expect(await db.run((q) => artifactAttachmentRequestedSteps(q, "a", "h"))).toBe(true);
    expect(await db.run((q) => artifactAttachmentRequestedSteps(q, "a", "other"))).toBe(false);
  });
});
