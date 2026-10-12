import type { LinearAccessReads, LinearSessionInstallation } from "./access";
import type { LinearInstallation } from "./administration";

export function createFakeLinearAccessReads(input: {
  installation: LinearInstallation;
  sessions?: readonly LinearSessionInstallation[];
  teams?: readonly string[];
}) {
  const state = {
    installation: input.installation,
    sessions: new Map(input.sessions?.map((session) => [session.sessionId, session])),
    teams: new Set(input.teams),
  };
  const calls: { method: "installation" | "session" | "team"; id?: string }[] = [];
  const adapter: LinearAccessReads = {
    async installation(options) {
      options?.signal?.throwIfAborted();
      calls.push({ method: "installation" });
      return structuredClone(state.installation);
    },
    async session(id, options) {
      options?.signal?.throwIfAborted();
      calls.push({ method: "session", id });
      const session = state.sessions.get(id);
      if (session === undefined) throw new Error("The fake Linear session was not configured.");
      return structuredClone(session);
    },
    async team(id, options) {
      options?.signal?.throwIfAborted();
      calls.push({ method: "team", id });
      return state.teams.has(id);
    },
  };
  return { adapter, state, calls };
}
