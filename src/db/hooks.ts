import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import type { HookAgent, HookEvent, WorkspaceHook } from "../core";
import { orm } from "./orm";
import { agentHook } from "./schema";

/** Every registered hook, oldest first, so each agent runs them in the order they were added. */
export function listHooks(db: Database): WorkspaceHook[] {
  return orm(db)
    .select()
    .from(agentHook)
    .orderBy(agentHook.createdAt, sql`rowid`)
    .all()
    .map((row) => ({
      id: row.id,
      event: row.event as HookEvent,
      matcher: row.matcher,
      command: row.command,
      timeoutSeconds: row.timeoutSeconds,
      agents: JSON.parse(row.agents) as HookAgent[],
      skill: row.skill,
    }));
}

export function saveHook(db: Database, hook: WorkspaceHook, now: number): void {
  orm(db)
    .insert(agentHook)
    .values({
      id: hook.id,
      event: hook.event,
      matcher: hook.matcher,
      command: hook.command,
      timeoutSeconds: hook.timeoutSeconds,
      agents: JSON.stringify(hook.agents),
      skill: hook.skill,
      createdAt: now,
    })
    .run();
}

/** Removes the hook. Runs that already started keep it until they end. */
export function deleteHook(db: Database, id: string): WorkspaceHook | null {
  const hook = listHooks(db).find((entry) => entry.id === id) ?? null;
  if (hook) orm(db).delete(agentHook).where(eq(agentHook.id, id)).run();
  return hook;
}
