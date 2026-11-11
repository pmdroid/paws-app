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
  migrate,
  openDatabase,
  sqliteDb,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

test("only a newer accepted turn can change a non-code task outcome and code stays selected", async () => {
  const db = tempDb();
  try {
    await ensureLinearSession(sqliteDb(db), { sessionId: "session" });
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
    await expect(selectTaskModeForTurn(sqliteDb(db), item.id, "answer", 1)).rejects.toThrow(
      "changed",
    );
    const first = await advanceLinearSessionGeneration(sqliteDb(db), "session");
    await expect(selectTaskModeForTurn(sqliteDb(db), item.id, "answer", first)).rejects.toThrow(
      "not been selected",
    );
    await saveTaskMode(sqliteDb(db), item.id, "answer", first);
    await expect(selectTaskModeForTurn(sqliteDb(db), item.id, "artifact", first)).rejects.toThrow(
      "newer accepted",
    );
    const second = await advanceLinearSessionGeneration(sqliteDb(db), "session");
    expect(await selectTaskModeForTurn(sqliteDb(db), item.id, "artifact", second)).toBe("artifact");
    expect(await getTaskModeGeneration(sqliteDb(db), item.id)).toBe(second);
    await expect(selectTaskModeForTurn(sqliteDb(db), item.id, "answer", first)).rejects.toThrow(
      "changed",
    );
    const third = await advanceLinearSessionGeneration(sqliteDb(db), "session");
    expect(await selectTaskModeForTurn(sqliteDb(db), item.id, "code", third)).toBe("code");
    const fourth = await advanceLinearSessionGeneration(sqliteDb(db), "session");
    expect(await selectTaskModeForTurn(sqliteDb(db), item.id, "answer", fourth)).toBe("code");
    expect(await getTaskMode(sqliteDb(db), item.id)).toBe("code");
    await applyWorkItemEvent(sqliteDb(db), item.id, "cancel");
    await expect(selectTaskModeForTurn(sqliteDb(db), item.id, "answer", fourth)).rejects.toThrow(
      "changed",
    );
  } finally {
    db.close();
  }
});

test("artifact completion requires uploaded deliverables and survives database reopen", async () => {
  const file = join(tempHome(), "paws.db");
  const db = openDatabase(file);
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  const run = (await beginImplementRun(sqliteDb(db), item.id, 1)).run;
  await saveTaskMode(sqliteDb(db), item.id, "artifact");
  await expect(completeArtifactTask(sqliteDb(db), item.id, "Done")).rejects.toThrow(
    "uploaded deliverable",
  );
  await saveArtifact(
    sqliteDb(db),
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
  await expect(completeArtifactTask(sqliteDb(db), item.id, "Done")).rejects.toThrow(
    "uploaded deliverable",
  );
  await markArtifact(sqliteDb(db), "artifact", null);
  await expect(completeArtifactTask(sqliteDb(db), item.id, "Done")).rejects.toThrow(
    "uploaded deliverable",
  );
  await markArtifact(sqliteDb(db), "artifact", "https://uploads.linear.app/report.txt");
  await completeArtifactTask(sqliteDb(db), item.id, "Here is the complete report.", 3);
  db.close();
  const restored = openDatabase(file);
  try {
    expect(getWorkItem(restored, item.id)?.state).toBe("completed");
    expect((await listOutbox(sqliteDb(restored), "session")).map((row) => row.payload)).toEqual([
      { sessionId: "session", kind: "response", body: "Here is the complete report." },
      { itemId: item.id, linearIssueId: item.linearIssueId, stateType: "completed" },
    ]);
    await expect(completeArtifactTask(sqliteDb(restored), item.id, "Duplicate")).rejects.toThrow(
      "no longer running",
    );
    expect(await listOutbox(sqliteDb(restored), "session")).toHaveLength(2);
  } finally {
    restored.close();
  }
});
