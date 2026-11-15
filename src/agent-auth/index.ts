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
import { createCodexProvider, type AuthProvider, type Device, type Tokens } from "./codex";
export { createCodexProvider } from "./codex";
export type { AuthProvider, Device, Tokens } from "./codex";
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
  provider?: AuthProvider;
  now?: () => number;
}) {
  const { store, secretsDir } = options;
  const now = options.now ?? Date.now;
  const provider = options.provider ?? createCodexProvider();
  async function claim(id: string, raw: string, state: State) {
    if ((state.lockUntil ?? 0) > now()) return null;
    const value = JSON.stringify({ ...state, lock: randomUUID(), lockUntil: now() + 120_000 });
    return (await store.transaction((q) => claimAgentAuthSteps(q, id, raw, value))) ? value : null;
  }
  async function save(
    id: string,
    locked: string,
    state: State,
    tokens?: Tokens,
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
      await store.run((q) => deviceAccountSteps(q, workspaceId, id));
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
        const next: State = {
          ...state,
          state: result.state,
          nextPoll: now() + state.device!.interval * 1000,
        };
        if (result.state !== "pending") delete next.device;
        if (result.state === "signed-in") {
          next.expiresAt = result.tokens.expiresAt;
          next.health = "ok";
        }
        const saved = await save(
          id,
          locked,
          next,
          result.state === "signed-in" ? result.tokens : undefined,
          true,
        );
        return { state: saved || "pending" };
      } catch {
        await save(
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
            await save(row.id, locked, { ...state, state: "expired" });
            continue;
          }
          state.version = credential.version;
          const files = JSON.parse(credential.blob) as { data: string }[];
          const previous = JSON.parse(Buffer.from(files[0]!.data, "base64").toString()) as {
            tokens: Omit<Tokens, "expiresAt">;
          };
          const tokens = await provider.refresh({
            ...previous.tokens,
            expiresAt: state.expiresAt!,
          });
          await save(
            row.id,
            locked,
            { ...state, expiresAt: tokens.expiresAt, failures: 0, retryAt: 0, health: "ok" },
            tokens,
          );
        } catch {
          const failures = state.failures + 1;
          await save(row.id, locked, {
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
