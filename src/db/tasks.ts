import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { TaskMode } from "../core";
import { settled, sqliteDb, type Q, type Db, type Steps } from "./db";
import { workItemTask } from "./schema";
import { applyWorkItemEventSteps, cancelAdvancingJobsSteps, getWorkItemSteps } from "./items";
import { enqueueOutboxOnceSteps } from "./outbox";
import { markRunSteps } from "./runs";
import { artifactPublicationReadySteps, listArtifactsSteps } from "./artifacts";
import { getLinearSessionGenerationSteps } from "./linear-sessions";
import { enqueueIssueStatusSteps } from "./linear-delegation";

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

export async function saveTaskMode(
  store: Db,
  itemId: string,
  mode: TaskMode,
  generation = 0,
  repository = false,
): Promise<TaskMode> {
  return store.transaction((q) => saveTaskModeSteps(q, itemId, mode, generation, repository));
}

export function* taskRequiresRepositorySteps(q: Q, itemId: string) {
  return (yield* taskColumnSteps(q, itemId, "repositoryContext")) === 1;
}

export async function taskRequiresRepository(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => taskRequiresRepositorySteps(q, itemId));
}

export function* getTaskModeGenerationSteps(q: Q, itemId: string) {
  return (yield* taskColumnSteps(q, itemId, "generation")) ?? 0;
}

export async function getTaskModeGeneration(store: Db, itemId: string): Promise<number> {
  return store.run((q) => getTaskModeGenerationSteps(q, itemId));
}

export function* selectTaskModeForTurnSteps(
  q: Q,
  itemId: string,
  mode: TaskMode,
  generation: number,
  repository = false,
) {
  const item = yield* getWorkItemSteps(q, itemId);
  if (
    !item?.sessionKey ||
    item.state !== "running" ||
    item.cancelRequested ||
    (yield* getLinearSessionGenerationSteps(q, item.sessionKey)) !== generation
  )
    throw new Error("The task changed before its requested outcome could be saved");
  const saved = yield* getTaskModeSteps(q, itemId);
  if (saved === null) throw new Error("Task mode has not been selected");
  if (saved === "code") return saved;
  if ((yield* getTaskModeGenerationSteps(q, itemId)) >= generation)
    throw new Error("Task outcome changes require a newer accepted turn");
  const { workItemTask: task } = q.t;
  yield* q.exec(
    q.orm
      .update(task)
      .set({ mode, generation, repositoryContext: repository ? 1 : 0, response: null })
      .where(eq(task.itemId, itemId)),
  );
  return mode;
}

export async function selectTaskModeForTurn(
  store: Db,
  itemId: string,
  mode: TaskMode,
  generation: number,
  repository = false,
): Promise<TaskMode> {
  return store.transaction((q) =>
    selectTaskModeForTurnSteps(q, itemId, mode, generation, repository),
  );
}

export type ResultFinish = { runId?: string; announce?: (q: Q) => Steps<void> };

export function* completeAnswerTaskSteps(
  q: Q,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
) {
  yield* completeResultTaskSteps(q, itemId, response, "answer", now, finish);
}

export async function completeAnswerTask(
  store: Db,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
): Promise<void> {
  await store.transaction((q) => completeAnswerTaskSteps(q, itemId, response, now, finish));
}

export function* completeArtifactTaskSteps(
  q: Q,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
) {
  if (
    !(yield* artifactPublicationReadySteps(q, itemId)) ||
    !(yield* listArtifactsSteps(q, itemId)).some((artifact) => artifact.state === "uploaded")
  )
    throw new Error("Artifact completion requires a successfully uploaded deliverable");
  yield* completeResultTaskSteps(q, itemId, response, "artifact", now, finish);
}

export async function completeArtifactTask(
  store: Db,
  itemId: string,
  response: string,
  now = Date.now(),
  finish: ResultFinish = {},
): Promise<void> {
  await store.transaction((q) => completeArtifactTaskSteps(q, itemId, response, now, finish));
}

function* completeResultTaskSteps(
  q: Q,
  itemId: string,
  response: string,
  mode: "answer" | "artifact",
  now: number,
  finish: ResultFinish,
) {
  if (!response.trim()) throw new Error("Answer completion requires a prepared response");
  const item = yield* getWorkItemSteps(q, itemId);
  if (
    !item ||
    item.state !== "running" ||
    item.cancelRequested ||
    (finish.runId !== undefined && item.currentRunId !== finish.runId)
  )
    throw new Error("Task is no longer running");
  if ((yield* getTaskModeSteps(q, itemId)) !== mode)
    throw new Error(`Only ${mode} tasks complete at this response boundary`);
  if (!item.sessionKey) throw new Error("Answer task has no session");
  const { workItemTask: task } = q.t;
  yield* q.exec(q.orm.update(task).set({ response }).where(eq(task.itemId, itemId)));
  yield* applyWorkItemEventSteps(
    q,
    itemId,
    mode === "answer" ? "answer_completed" : "artifact_completed",
  );
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", now);
  yield* cancelAdvancingJobsSteps(q, itemId, `${mode}_completed`, now);
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: item.sessionKey,
    idempotencyKey: `${mode}-completed:${itemId}`,
    payload: { sessionId: item.sessionKey, kind: "response", body: response },
    now,
  });
  // An answer does not finish the issue; a delivered artifact does.
  if (mode === "artifact")
    yield* enqueueIssueStatusSteps(q, (yield* getWorkItemSteps(q, itemId))!, "completed", now);
  if (finish.announce) yield* finish.announce(q);
}
