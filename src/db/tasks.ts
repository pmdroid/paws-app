import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { TaskMode } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
import { workItemTask } from "./schema";
import { immediate } from "./tx";
import { applyWorkItemEvent, cancelAdvancingJobs, getWorkItem } from "./items";
import { enqueueOutboxOnce } from "./outbox";
import { markRun } from "./runs";
import { artifactPublicationReady, listArtifacts } from "./artifacts";
import { getLinearSessionGeneration } from "./linear-sessions";
import { enqueueIssueStatus } from "./linear-delegation";

type TaskRow = typeof workItemTask.$inferSelect;

function* taskColumnSteps<K extends "mode" | "generation" | "repositoryContext">(
  q: Q,
  itemId: string,
  column: K,
) {
  const { workItemTask: task } = q.t;
  const row = yield* q.one(
    q.orm.select({ value: task[column] }).from(task).where(eq(task.itemId, itemId)),
  );
  return row?.value as TaskRow[K] | undefined;
}

export function* getTaskModeSteps(q: Q, itemId: string) {
  return ((yield* taskColumnSteps(q, itemId, "mode")) as TaskMode | undefined) ?? null;
}

export function getTaskMode(db: Database, itemId: string): TaskMode | null {
  return settled(sqliteDb(db).run((q) => getTaskModeSteps(q, itemId)));
}

export function* saveTaskModeSteps(
  q: Q,
  itemId: string,
  mode: TaskMode,
  generation = 0,
  repository = false,
) {
  yield* q.exec(
    q.orm
      .insert(q.t.workItemTask)
      .values({ itemId, mode, generation, repositoryContext: repository ? 1 : 0 })
      .onConflictDoNothing(),
  );
  const saved = yield* getTaskModeSteps(q, itemId);
  if (saved !== mode) throw new Error("Task mode already selected");
  return saved;
}

export function saveTaskMode(
  db: Database,
  itemId: string,
  mode: TaskMode,
  generation = 0,
  repository = false,
): TaskMode {
  return settled(
    sqliteDb(db).transaction((q) => saveTaskModeSteps(q, itemId, mode, generation, repository)),
  );
}

export function* taskRequiresRepositorySteps(q: Q, itemId: string) {
  return (yield* taskColumnSteps(q, itemId, "repositoryContext")) === 1;
}

export function taskRequiresRepository(db: Database, itemId: string): boolean {
  return settled(sqliteDb(db).run((q) => taskRequiresRepositorySteps(q, itemId)));
}

export function* getTaskModeGenerationSteps(q: Q, itemId: string) {
  return (yield* taskColumnSteps(q, itemId, "generation")) ?? 0;
}

export function getTaskModeGeneration(db: Database, itemId: string): number {
  return settled(sqliteDb(db).run((q) => getTaskModeGenerationSteps(q, itemId)));
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
    orm(db)
      .update(workItemTask)
      .set({ mode, generation, repositoryContext: repository ? 1 : 0, response: null })
      .where(eq(workItemTask.itemId, itemId))
      .run();
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
    orm(db).update(workItemTask).set({ response }).where(eq(workItemTask.itemId, itemId)).run();
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
    // An answer does not finish the issue; a delivered artifact does.
    if (mode === "artifact") enqueueIssueStatus(db, getWorkItem(db, itemId)!, "completed", now);
    finish.announce?.();
  });
}
