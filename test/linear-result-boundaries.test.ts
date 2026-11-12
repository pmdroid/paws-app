import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  getTaskMode,
  getTaskModeGeneration,
  saveTaskMode,
  selectTaskModeForTurn,
  ensureLinearSession,
  advanceLinearSessionGeneration,
  insertQueuedItem,
  applyWorkItemEvent,
  beginImplementRun,
  completeArtifactTask,
  saveArtifact,
  markArtifact,
  getWorkItem,
  listOutbox,
  openPawsStore,
} from "../src/db";
import { tempHome } from "./helpers";
import { copyMigratedPglite, tempStore } from "./pglite";

test("only a newer accepted turn can change a non-code task outcome and code stays selected", async () => {
  const { db, close } = await tempStore();
  try {
    await ensureLinearSession(db, { sessionId: "session" });
    const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    await applyWorkItemEvent(db, item.id, "dispatched");
    await expect(selectTaskModeForTurn(db, item.id, "answer", 1)).rejects.toThrow("changed");
    const first = await advanceLinearSessionGeneration(db, "session");
    await expect(selectTaskModeForTurn(db, item.id, "answer", first)).rejects.toThrow(
      "not been selected",
    );
    await saveTaskMode(db, item.id, "answer", first);
    await expect(selectTaskModeForTurn(db, item.id, "artifact", first)).rejects.toThrow(
      "newer accepted",
    );
    const second = await advanceLinearSessionGeneration(db, "session");
    expect(await selectTaskModeForTurn(db, item.id, "artifact", second)).toBe("artifact");
    expect(await getTaskModeGeneration(db, item.id)).toBe(second);
    await expect(selectTaskModeForTurn(db, item.id, "answer", first)).rejects.toThrow("changed");
    const third = await advanceLinearSessionGeneration(db, "session");
    expect(await selectTaskModeForTurn(db, item.id, "code", third)).toBe("code");
    const fourth = await advanceLinearSessionGeneration(db, "session");
    expect(await selectTaskModeForTurn(db, item.id, "answer", fourth)).toBe("code");
    expect(await getTaskMode(db, item.id)).toBe("code");
    await applyWorkItemEvent(db, item.id, "cancel");
    await expect(selectTaskModeForTurn(db, item.id, "answer", fourth)).rejects.toThrow("changed");
  } finally {
    await close();
  }
});

test("artifact completion requires uploaded deliverables and survives database reopen", async () => {
  const pgliteDir = join(tempHome(), "pglite");
  await copyMigratedPglite(pgliteDir);
  const open = await openPawsStore({ url: null, pgliteDir });
  const db = open.store;
  const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  const run = (await beginImplementRun(db, item.id, 1)).run;
  await saveTaskMode(db, item.id, "artifact");
  await expect(completeArtifactTask(db, item.id, "Done")).rejects.toThrow("uploaded deliverable");
  await saveArtifact(
    db,
    {
      id: "artifact",
      itemId: item.id,
      runId: run.id,
      path: "report.txt",
      displayName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sha256: "digest",
      state: "pending",
      assetUrl: null,
    },
    2,
  );
  await expect(completeArtifactTask(db, item.id, "Done")).rejects.toThrow("uploaded deliverable");
  await markArtifact(db, "artifact", null);
  await expect(completeArtifactTask(db, item.id, "Done")).rejects.toThrow("uploaded deliverable");
  await markArtifact(db, "artifact", "https://uploads.linear.app/report.txt");
  await completeArtifactTask(db, item.id, "Here is the complete report.", 3);
  await open.close();
  const reopened = await openPawsStore({ url: null, pgliteDir });
  const restored = reopened.store;
  try {
    expect((await getWorkItem(restored, item.id))?.state).toBe("completed");
    expect((await listOutbox(restored, "session")).map((row) => row.payload)).toEqual([
      { sessionId: "session", kind: "response", body: "Here is the complete report." },
      { itemId: item.id, linearIssueId: item.linearIssueId, stateType: "completed" },
    ]);
    await expect(completeArtifactTask(restored, item.id, "Duplicate")).rejects.toThrow(
      "no longer running",
    );
    expect(await listOutbox(restored, "session")).toHaveLength(2);
  } finally {
    await reopened.close();
  }
});
