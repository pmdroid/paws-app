import type { Database } from "bun:sqlite";
import type { HookAgent, HookEvent, WorkspaceHook } from "../core";

type Row = {
  id: string;
  event: HookEvent;
  matcher: string | null;
  command: string;
  timeout_seconds: number;
  agents: string;
  skill: string | null;
};

/** Every registered hook, oldest first, so each agent runs them in the order they were added. */
export function listHooks(db: Database): WorkspaceHook[] {
  return db
    .query<Row, []>(
      "SELECT id,event,matcher,command,timeout_seconds,agents,skill FROM agent_hook ORDER BY created_at, rowid",
    )
    .all()
    .map((row) => ({
      id: row.id,
      event: row.event,
      matcher: row.matcher,
      command: row.command,
      timeoutSeconds: row.timeout_seconds,
      agents: JSON.parse(row.agents) as HookAgent[],
      skill: row.skill,
    }));
}

export function saveHook(db: Database, hook: WorkspaceHook, now: number): void {
  db.run(
    "INSERT INTO agent_hook(id,event,matcher,command,timeout_seconds,agents,skill,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [
      hook.id,
      hook.event,
      hook.matcher,
      hook.command,
      hook.timeoutSeconds,
      JSON.stringify(hook.agents),
      hook.skill,
      now,
    ],
  );
}

/** Removes the hook. Runs that already started keep it until they end. */
export function deleteHook(db: Database, id: string): WorkspaceHook | null {
  const hook = listHooks(db).find((entry) => entry.id === id) ?? null;
  if (hook) db.run("DELETE FROM agent_hook WHERE id=?", [id]);
  return hook;
}
