import { createHash } from "node:crypto";
import type { runAgent } from "../acp";
import type { AgentProfile } from "../config";
import {
  assertLinearSessionCleanupSteps,
  blockLinearSessionCleanup,
  enqueueOutboxOnceSteps,
  getLinearSessionSteps,
  getTaskClassificationSteps,
  saveTaskClassificationSteps,
  type Db,
  type StoredTaskClassification,
} from "../db";
import { publicToolText } from "./activity";
import type { AgentLaunch } from "./agents";
import type { PromptPart } from "./prompt-fit";
import { classifyTask } from "./task-classifier";

export function createTaskPlanner(options: {
  store: Db;
  pawsRoot: string;
  home?: string;
  launch: AgentLaunch;
  agentForSession?: (
    sessionId: string,
    onLaneWait?: (waiting: boolean) => Promise<void>,
  ) => typeof runAgent;
  profile: () => AgentProfile;
}) {
  const store = options.store;
  let stopVersion = 0;
  const sessionStopVersions = new Map<string, number>();
  const active = new Map<
    string,
    {
      taskKey: string;
      generation: number | undefined;
      controller: AbortController;
      work: Promise<StoredTaskClassification>;
    }
  >();
  return {
    async plan(input: {
      taskKey: string;
      sessionId: string;
      request: (signal: AbortSignal) => Promise<string | readonly PromptPart[]>;
      onLaneWait?: (waiting: boolean) => Promise<void>;
    }): Promise<StoredTaskClassification> {
      const initialStopVersion = stopVersion;
      const initialSessionStop = sessionStopVersions.get(input.sessionId);
      const checkStopped = async () => {
        await store.run((q) => assertLinearSessionCleanupSteps(q, input.sessionId));
        if (
          stopVersion !== initialStopVersion ||
          sessionStopVersions.get(input.sessionId) !== initialSessionStop
        )
          throw new Error("Task classification was stopped");
      };
      await checkStopped();
      const saved = await store.run((q) => getTaskClassificationSteps(q, input.taskKey));
      if (saved) return saved;
      const generation = (await store.run((q) => getLinearSessionSteps(q, input.sessionId)))
        ?.generation;
      let pending = active.get(input.sessionId);
      while (pending) {
        if (pending.taskKey === input.taskKey && pending.generation === generation)
          return pending.work;
        pending.controller.abort();
        await Promise.allSettled([pending.work]);
        await checkStopped();
        if (
          (await store.run((q) => getLinearSessionSteps(q, input.sessionId)))?.generation !==
          generation
        )
          throw new Error("The Linear request changed before classification");
        pending = active.get(input.sessionId);
      }
      const controller = new AbortController();
      const current = async () => {
        await checkStopped();
        controller.signal.throwIfAborted();
        const session = await store.run((q) => getLinearSessionSteps(q, input.sessionId));
        if (!session || session.stoppedAt !== null || session.generation !== generation)
          throw new Error("The Linear request changed during classification");
      };
      const work = (async () => {
        await current();
        const request = await input.request(controller.signal);
        await current();
        const classification = await classifyTask({
          itemId: createHash("sha256").update(input.taskKey).digest("hex"),
          runId: "classification",
          request,
          pawsRoot: options.pawsRoot,
          home: options.home,
          profile: options.profile(),
          signal: controller.signal,
          launch: options.launch,
          agentRunner: options.agentForSession?.(input.sessionId, input.onLaneWait),
          onCleanupFailure: () => blockLinearSessionCleanup(store, input.sessionId),
        });
        await current();
        const understood =
          classification.mode === "clarify" ? undefined : classification.understood;
        const stored: StoredTaskClassification = { ...classification };
        if ("understood" in stored) delete stored.understood;
        await store.transaction(function* (q) {
          yield* saveTaskClassificationSteps(q, input.taskKey, stored);
          if (understood)
            yield* enqueueOutboxOnceSteps(q, {
              target: "linear",
              op: "activity",
              orderingKey: input.sessionId,
              idempotencyKey: `understood:${input.taskKey}`,
              payload: {
                sessionId: input.sessionId,
                kind: "thought",
                body: publicToolText(understood),
                id: crypto.randomUUID(),
              },
            });
        });
        return stored;
      })().finally(() => {
        if (active.get(input.sessionId)?.controller === controller) active.delete(input.sessionId);
      });
      active.set(input.sessionId, { taskKey: input.taskKey, generation, controller, work });
      return work;
    },
    async stop(sessionId?: string): Promise<void> {
      if (sessionId)
        sessionStopVersions.set(sessionId, (sessionStopVersions.get(sessionId) ?? 0) + 1);
      else stopVersion++;
      const pending = sessionId
        ? [active.get(sessionId)].filter((value) => value !== undefined)
        : [...active.values()];
      for (const entry of pending) entry.controller.abort();
      await Promise.allSettled(pending.map((entry) => entry.work));
      await store.run((q) => assertLinearSessionCleanupSteps(q, sessionId));
    },
  };
}
