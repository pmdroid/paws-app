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
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

test("only a newer accepted turn can change a non-code task outcome and code stays selected", () => {
  const db = tempDb();
  try {
    ensureLinearSession(db, { sessionId: "session" });
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    applyWorkItemEvent(db, item.id, "dispatched");
    expect(() => selectTaskModeForTurn(db, item.id, "answer", 1)).toThrow("changed");
    const first = advanceLinearSessionGeneration(db, "session");
    expect(() => selectTaskModeForTurn(db, item.id, "answer", first)).toThrow("not been selected");
    saveTaskMode(db, item.id, "answer", first);
    expect(() => selectTaskModeForTurn(db, item.id, "artifact", first)).toThrow("newer accepted");
    const second = advanceLinearSessionGeneration(db, "session");
    expect(selectTaskModeForTurn(db, item.id, "artifact", second)).toBe("artifact");
    expect(getTaskModeGeneration(db, item.id)).toBe(second);
    expect(() => selectTaskModeForTurn(db, item.id, "answer", first)).toThrow("changed");
    const third = advanceLinearSessionGeneration(db, "session");
    expect(selectTaskModeForTurn(db, item.id, "code", third)).toBe("code");
    const fourth = advanceLinearSessionGeneration(db, "session");
    expect(selectTaskModeForTurn(db, item.id, "answer", fourth)).toBe("code");
    expect(getTaskMode(db, item.id)).toBe("code");
    applyWorkItemEvent(db, item.id, "cancel");
    expect(() => selectTaskModeForTurn(db, item.id, "answer", fourth)).toThrow("changed");
  } finally {
    db.close();
  }
});

test("artifact completion requires uploaded deliverables and survives database reopen", () => {
  const file = join(tempHome(), "paws.db");
  const db = openDatabase(file);
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  const run = beginImplementRun(db, item.id, 1).run;
  saveTaskMode(db, item.id, "artifact");
  expect(() => completeArtifactTask(db, item.id, "Done")).toThrow("uploaded deliverable");
  saveArtifact(
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
  expect(() => completeArtifactTask(db, item.id, "Done")).toThrow("uploaded deliverable");
  markArtifact(db, "artifact", null);
  expect(() => completeArtifactTask(db, item.id, "Done")).toThrow("uploaded deliverable");
  markArtifact(db, "artifact", "https://uploads.linear.app/report.txt");
  completeArtifactTask(db, item.id, "Here is the complete report.", 3);
  db.close();
  const restored = openDatabase(file);
  try {
    expect(getWorkItem(restored, item.id)?.state).toBe("completed");
    expect(listOutbox(restored, "session").map((row) => row.payload)).toEqual([
      { sessionId: "session", kind: "response", body: "Here is the complete report." },
    ]);
    expect(() => completeArtifactTask(restored, item.id, "Duplicate")).toThrow("no longer running");
    expect(listOutbox(restored, "session")).toHaveLength(1);
  } finally {
    restored.close();
  }
});
