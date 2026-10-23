import type { Database } from "bun:sqlite";
import type { TaskMode } from "../core";
import { immediate } from "./tx";
import { applyWorkItemEvent, cancelAdvancingJobs, getWorkItem } from "./items";
import { enqueueOutboxOnce } from "./outbox";
import { markRun } from "./runs";
import { artifactPublicationReady, listArtifacts } from "./artifacts";
import { getLinearSessionGeneration } from "./linear-sessions";

export function getTaskMode(db: Database, itemId: string): TaskMode | null {
  return (
    db
      .query<{ mode: TaskMode }, [string]>("SELECT mode FROM work_item_task WHERE item_id = ?")
      .get(itemId)?.mode ?? null
  );
}

export function saveTaskMode(
  db: Database,
  itemId: string,
  mode: TaskMode,
  generation = 0,
  repository = false,
): TaskMode {
  return immediate(db, () => {
    db.run(
      "INSERT OR IGNORE INTO work_item_task (item_id, mode, generation, repository_context) VALUES (?, ?, ?, ?)",
      [itemId, mode, generation, repository ? 1 : 0],
    );
    const saved = getTaskMode(db, itemId);
    if (saved !== mode) throw new Error("Task mode already selected");
    return saved;
  });
}

export function taskRequiresRepository(db: Database, itemId: string): boolean {
  return (
    db
      .query<{ repository_context: number }, [string]>(
        "SELECT repository_context FROM work_item_task WHERE item_id = ?",
      )
      .get(itemId)?.repository_context === 1
  );
}

export function getTaskModeGeneration(db: Database, itemId: string): number {
  return (
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM work_item_task WHERE item_id = ?",
      )
      .get(itemId)?.generation ?? 0
  );
}

export function selectTaskModeForTurn(
  db: Database,
  itemId: string,
  mode: TaskMode,
  generation: number,
  repository = false,
): TaskMode {
  return immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (
      !item?.sessionKey ||
      item.state !== "running" ||
      item.cancelRequested ||
      getLinearSessionGeneration(db, item.sessionKey) !== generation
    )
      throw new Error("The task changed before its requested outcome could be saved");
    const saved = getTaskMode(db, itemId);
    if (saved === null) throw new Error("Task mode has not been selected");
    if (saved === "code") return saved;
    if (getTaskModeGeneration(db, itemId) >= generation)
      throw new Error("Task outcome changes require a newer accepted turn");
    db.run(
      "UPDATE work_item_task SET mode = ?, generation = ?, repository_context = ?, response = NULL WHERE item_id = ?",
      [mode, generation, repository ? 1 : 0, itemId],
    );
    return mode;
  });
}

export type ResultFinish = { runId?: string; announce?: () => void };

export function completeAnswerTask(
  db: Database,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
): void {
  completeResultTask(db, itemId, response, "answer", now, finish);
}

export function completeArtifactTask(
  db: Database,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
): void {
  immediate(db, () => {
    if (
      !artifactPublicationReady(db, itemId) ||
      !listArtifacts(db, itemId).some((artifact) => artifact.state === "uploaded")
    )
      throw new Error("Artifact completion requires a successfully uploaded deliverable");
    completeResultTask(db, itemId, response, "artifact", now, finish);
  });
}

function completeResultTask(
  db: Database,
  itemId: string,
  response: string,
  mode: "answer" | "artifact",
  now: number,
  finish: ResultFinish,
): void {
  if (!response.trim()) throw new Error("Answer completion requires a prepared response");
  immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (
      !item ||
      item.state !== "running" ||
      item.cancelRequested ||
      (finish.runId !== undefined && item.currentRunId !== finish.runId)
    )
      throw new Error("Task is no longer running");
    if (getTaskMode(db, itemId) !== mode)
      throw new Error(`Only ${mode} tasks complete at this response boundary`);
    if (!item.sessionKey) throw new Error("Answer task has no session");
    db.run("UPDATE work_item_task SET response = ? WHERE item_id = ?", [response, itemId]);
    applyWorkItemEvent(db, itemId, mode === "answer" ? "answer_completed" : "artifact_completed");
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", now);
    cancelAdvancingJobs(db, itemId, `${mode}_completed`, now);
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: item.sessionKey,
      idempotencyKey: `${mode}-completed:${itemId}`,
      payload: { sessionId: item.sessionKey, kind: "response", body: response },
      now,
    });
    finish.announce?.();
  });
}
