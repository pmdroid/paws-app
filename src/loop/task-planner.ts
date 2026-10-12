import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AgentProfile } from "../config";
import {
  getLinearSession,
  getTaskClassification,
  saveTaskClassification,
  type StoredTaskClassification,
} from "../db";
import type { AgentLaunch } from "./agents";
import { classifyTask } from "./task-classifier";

export function createTaskPlanner(options: {
  db: Database;
  pawsRoot: string;
  home?: string;
  launch: AgentLaunch;
  profile: () => AgentProfile;
}) {
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
      request: (signal: AbortSignal) => Promise<string>;
    }): Promise<StoredTaskClassification> {
      const initialStopVersion = stopVersion;
      const initialSessionStop = sessionStopVersions.get(input.sessionId);
      const checkStopped = () => {
        if (
          stopVersion !== initialStopVersion ||
          sessionStopVersions.get(input.sessionId) !== initialSessionStop
        )
          throw new Error("Task classification was stopped");
      };
      const saved = getTaskClassification(options.db, input.taskKey);
      if (saved) return saved;
      let pending = active.get(input.sessionId);
      const generation = getLinearSession(options.db, input.sessionId)?.generation;
      while (pending) {
        if (pending.taskKey === input.taskKey && pending.generation === generation)
          return pending.work;
        pending.controller.abort();
        await Promise.allSettled([pending.work]);
        checkStopped();
        if (getLinearSession(options.db, input.sessionId)?.generation !== generation)
          throw new Error("The Linear request changed before classification");
        pending = active.get(input.sessionId);
      }
      const controller = new AbortController();
      const current = () => {
        checkStopped();
        controller.signal.throwIfAborted();
        const session = getLinearSession(options.db, input.sessionId);
        if (!session || session.stoppedAt !== null || session.generation !== generation)
          throw new Error("The Linear request changed during classification");
      };
      const work = (async () => {
        current();
        const request = await input.request(controller.signal);
        current();
        const classification = await classifyTask({
          itemId: createHash("sha256").update(input.taskKey).digest("hex"),
          runId: "classification",
          request,
          pawsRoot: options.pawsRoot,
          home: options.home,
          profile: options.profile(),
          signal: controller.signal,
          launch: options.launch,
        });
        current();
        saveTaskClassification(options.db, input.taskKey, classification);
        return classification;
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
    },
  };
}
