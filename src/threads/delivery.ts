import {
  enqueueOutboxOnceSteps,
  primaryThreadContextSteps,
  stopOutboxSession,
  type Db,
  type OutboxDelivery,
  type OutboxRow,
  type Q,
  type ThreadScope,
  type ThreadTaskRecord,
} from "../db";
import type { ThreadDestination, ThreadEffect, ThreadSurface } from "./surface";

type ThreadOutboxPayload = {
  workspaceId: string;
  installationId: string;
  taskId: string;
  effect: ThreadEffect;
};

export const threadOrderingKey = (taskId: string) => `thread:${taskId}`;

export function* enqueueThreadEffectSteps(
  q: Q,
  task: ThreadTaskRecord,
  effect: ThreadEffect,
  delivery: OutboxDelivery = "ordered",
) {
  const payload: ThreadOutboxPayload = {
    workspaceId: task.workspaceId,
    installationId: task.installationId,
    taskId: task.id,
    effect,
  };
  return yield* enqueueOutboxOnceSteps(q, {
    target: task.surface,
    op: `thread.${effect.kind}`,
    orderingKey: threadOrderingKey(task.id),
    idempotencyKey: `thread:${task.id}:${effect.effectKey}`,
    payload,
    delivery,
  });
}

export async function enqueueThreadEffect(
  store: Db,
  task: ThreadTaskRecord,
  effect: ThreadEffect,
  delivery?: OutboxDelivery,
): Promise<number> {
  return store.transaction((q) => enqueueThreadEffectSteps(q, task, effect, delivery));
}

export async function stopThreadDelivery(store: Db, task: ThreadTaskRecord, now = Date.now()) {
  return stopOutboxSession(store, task.surface, threadOrderingKey(task.id), now);
}

export async function deliverThreadEffect(
  store: Db,
  surfaces: readonly ThreadSurface[],
  row: OutboxRow,
): Promise<string | null> {
  const surface = surfaces.find((candidate) => candidate.kind === row.target);
  if (surface === undefined) return null;
  const payload = row.payload as ThreadOutboxPayload;
  const scope: ThreadScope = {
    workspaceId: payload.workspaceId,
    surface: surface.kind,
    installationId: payload.installationId,
  };
  const primary = await store.run((q) => primaryThreadContextSteps(q, scope, payload.taskId));
  if (primary === null) throw new Error(`Thread task ${payload.taskId} has no destination.`);
  const { context } = primary;
  const destination: ThreadDestination = {
    surface: surface.kind,
    installationId: context.installationId,
    kind: context.kind,
    channelId: context.channelId,
    threadId: context.threadId,
    privateMember: context.privateMember,
  };
  const effect = payload.effect;
  const earlier = await surface.delivered(destination, effect.effectKey);
  if (earlier !== null) return earlier;
  if (effect.kind === "react" && surface.react) return surface.react(destination, effect);
  if (effect.kind === "code_view" && context.kind === "code_channel" && surface.showCodeView)
    return surface.showCodeView(destination, effect);
  const text =
    effect.kind === "post"
      ? effect.text
      : effect.kind === "code_view"
        ? effect.fallbackText
        : `:${effect.emoji}:`;
  return surface.post(destination, { effectKey: effect.effectKey, text });
}
