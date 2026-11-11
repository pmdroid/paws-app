import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import type { HookAgent, HookEvent, WorkspaceHook } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { jsonValue, parsedJson } from "./json-text";

export function* listHooksSteps(q: Q) {
  const order = q.dialect === "sqlite" ? sql`rowid` : q.t.agentHook.id;
  const rows = yield* q.all(
    q.orm.select().from(q.t.agentHook).orderBy(q.t.agentHook.createdAt, order),
  );
  return rows.map((row): WorkspaceHook => ({
    id: row.id,
    event: row.event as HookEvent,
    matcher: row.matcher,
    command: row.command,
    timeoutSeconds: row.timeoutSeconds,
    agents: parsedJson<HookAgent[]>(q, row.agents),
    skill: row.skill,
  }));
}

export function* saveHookSteps(q: Q, hook: WorkspaceHook, now: number) {
  yield* q.exec(
    q.orm.insert(q.t.agentHook).values({
      id: hook.id,
      event: hook.event,
      matcher: hook.matcher,
      command: hook.command,
      timeoutSeconds: hook.timeoutSeconds,
      agents: jsonValue(q, hook.agents),
      skill: hook.skill,
      createdAt: now,
    }),
  );
}

export function* deleteHookSteps(q: Q, id: string) {
  const hook = (yield* listHooksSteps(q)).find((entry) => entry.id === id) ?? null;
  if (hook) yield* q.exec(q.orm.delete(q.t.agentHook).where(eq(q.t.agentHook.id, id)));
  return hook;
}

/** Every registered hook, oldest first, so each agent runs them in the order they were added. */
export function listHooks(db: Database): WorkspaceHook[] {
  return settled(sqliteDb(db).run((q) => listHooksSteps(q)));
}

export function saveHook(db: Database, hook: WorkspaceHook, now: number): void {
  settled(sqliteDb(db).run((q) => saveHookSteps(q, hook, now)));
}

/** Removes the hook. Runs that already started keep it until they end. */
export function deleteHook(db: Database, id: string): WorkspaceHook | null {
  return settled(sqliteDb(db).run((q) => deleteHookSteps(q, id)));
}
