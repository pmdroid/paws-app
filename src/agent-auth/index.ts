import { randomUUID } from "node:crypto";
import {
  claimAgentAuthSteps,
  deviceAccountSteps,
  listAgentAuthSteps,
  readAgentAuthSteps,
  writeAgentAuthSteps,
  bindToOwnerRunnersSteps,
  type Db,
} from "../db";
import { readAgentCredentialSteps, writeAgentCredentialSteps } from "../credentials";
import { createCodexProvider, type AuthProvider, type Device } from "./codex";
import { createGrokProvider } from "./grok";
import { createOpencodeProvider } from "./opencode";
export { createCodexProvider } from "./codex";
export { createGrokProvider } from "./grok";
export { createOpencodeProvider } from "./opencode";
export type { AuthProvider, Device, Tokens } from "./codex";
export type { OpencodeTokens } from "./opencode";
type Provider = AuthProvider<{ expiresAt: number }>;
type Agent = "codex" | "grok" | "opencode";
type State = {
  state: "pending" | "signed-in" | "denied" | "expired";
  device?: Device;
  nextPoll: number;
  expiresAt?: number;
  failures: number;
  retryAt: number;
  lock?: string;
  lockUntil?: number;
  health?: "ok" | "auth-expired";
  version?: number;
};
export function createAgentAuth(options: {
  store: Db;
  secretsDir: string;
  providers?: Partial<Record<Agent, Provider>>;
  now?: () => number;
}) {
  const { store, secretsDir } = options;
  const now = options.now ?? Date.now;
  const providers: Record<Agent, Provider> = {
    codex: createCodexProvider(),
    grok: createGrokProvider(),
    opencode: createOpencodeProvider(),
    ...options.providers,
  };
  async function claim(id: string, raw: string, state: State) {
    if ((state.lockUntil ?? 0) > now()) return null;
    const value = JSON.stringify({ ...state, lock: randomUUID(), lockUntil: now() + 120_000 });
    return (await store.transaction((q) => claimAgentAuthSteps(q, id, raw, value))) ? value : null;
  }
  async function save(
    provider: Provider,
    id: string,
    locked: string,
    state: State,
    tokens?: { expiresAt: number },
    deviceSession = false,
  ) {
    delete state.lock;
    delete state.lockUntil;
    return await store.transaction(function* (q) {
      const previous = yield* readAgentCredentialSteps(q, secretsDir, id);
      if (tokens && state.version !== undefined && previous?.version !== state.version) {
        state.state = previous?.blob ? "signed-in" : "expired";
        state.version = previous?.version;
        state.health = "auth-expired";
        tokens = undefined;
      }
      if (tokens) state.version = (previous?.version ?? 0) + 1;
      const key = deviceSession ? "device:" + id : id;
      const claimed = yield* claimAgentAuthSteps(q, key, locked, JSON.stringify(state));
      if (!claimed) return false;
      if (tokens) {
        if (deviceSession) yield* writeAgentAuthSteps(q, id, JSON.stringify(state));
        const result = yield* writeAgentCredentialSteps(q, secretsDir, {
          accountId: id,
          runnerId: null,
          version: state.version!,
          blob: JSON.stringify(provider.credentialFiles(tokens)),
          now: now(),
        });
        if (result !== "written") throw new Error("Agent credential write conflicted");
        yield* bindToOwnerRunnersSteps(q, id, now());
      }
      return state.state;
    });
  }
  return {
    async device(workspaceId: string, id: string, start: boolean) {
      const provider = providers[await store.run((q) => deviceAccountSteps(q, workspaceId, id))];
      if (start) {
        const device = await provider.startDevice();
        const state: State = {
          state: "pending",
          device,
          nextPoll: now() + device.interval * 1000,
          failures: 0,
          retryAt: 0,
        };
        await store.transaction((q) =>
          writeAgentAuthSteps(q, "device:" + id, JSON.stringify(state)),
        );
        const { deviceId: _, ...publicDevice } = device;
        return publicDevice;
      }
      const raw = await store.run((q) => readAgentAuthSteps(q, "device:" + id));
      if (!raw) return { state: "expired" };
      const state = JSON.parse(raw) as State;
      if (state.state !== "pending") return { state: state.state };
      if (state.nextPoll > now()) return { state: "pending" };
      const locked = await claim("device:" + id, raw, state);
      if (!locked) return { state: "pending" };
      try {
        const result = await provider.pollDevice(state.device!);
        const device = {
          ...state.device!,
          interval: ("interval" in result && result.interval) || state.device!.interval,
        };
        const next: State = {
          ...state,
          device,
          state: result.state,
          nextPoll: now() + device.interval * 1000,
        };
        if (result.state !== "pending") delete next.device;
        if (result.state === "signed-in") {
          next.expiresAt = result.tokens.expiresAt;
          next.health = "ok";
        }
        const saved = await save(
          provider,
          id,
          locked,
          next,
          result.state === "signed-in" ? result.tokens : undefined,
          true,
        );
        return { state: saved || "pending" };
      } catch {
        await save(
          provider,
          id,
          locked,
          { ...state, nextPoll: now() + state.device!.interval * 1000 },
          undefined,
          true,
        );
        throw new Error("Device sign-in is unavailable");
      }
    },
    async tick() {
      for (const row of await store.run(listAgentAuthSteps)) {
        const state = JSON.parse(row.value) as State;
        const provider = providers[row.agent];
        if (
          state.state !== "signed-in" ||
          (state.expiresAt ?? Infinity) > now() + 600_000 ||
          state.retryAt > now()
        )
          continue;
        const locked = await claim(row.id, row.value, state);
        if (!locked) continue;
        try {
          const credential = await store.run((q) =>
            readAgentCredentialSteps(q, secretsDir, row.id),
          );
          if (!credential?.blob) {
            await save(provider, row.id, locked, { ...state, state: "expired" });
            continue;
          }
          state.version = credential.version;
          const tokens = await provider.refresh({
            ...provider.storedTokens(JSON.parse(credential.blob)),
            expiresAt: state.expiresAt!,
          });
          await save(
            provider,
            row.id,
            locked,
            { ...state, expiresAt: tokens.expiresAt, failures: 0, retryAt: 0, health: "ok" },
            tokens,
          );
        } catch {
          const failures = state.failures + 1;
          await save(provider, row.id, locked, {
            ...state,
            health: "auth-expired",
            failures,
            retryAt: now() + Math.min(60_000 * 2 ** Math.min(failures - 1, 10), 3_600_000),
          });
        }
      }
    },
  };
}
export { createAccountUsage } from "./account-usage";
export { createUsageReader } from "./usage";

export async function checkClaudeToken(
  token: string,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  const response = await request("https://api.anthropic.com/v1/models", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) return false;
  if (response.ok) return true;
  throw new Error(`Claude token check failed with status ${response.status}`);
}
