import {
  staleProviderUsageSteps,
  usageAccountsSteps,
  saveProviderUsageSteps,
  readAgentAuthSteps,
  writeAgentAuthSteps,
  type Db,
} from "../db";
import { readAgentCredentialSteps } from "../credentials";
import { createUsageReader, UsageAuthExpired } from "./usage";
export function createAccountUsage(options: {
  store: Db;
  secretsDir: string;
  now?: () => number;
  readUsage?: ReturnType<typeof createUsageReader>;
}) {
  const now = options.now ?? Date.now;
  const readUsage = options.readUsage ?? createUsageReader(undefined, now);
  const active = new Map<string, Promise<void>>();
  async function read(account: Awaited<ReturnType<typeof accounts>>[number]) {
    const startedAt = now();
    const credential = await options.store.run((q) =>
      readAgentCredentialSteps(q, options.secretsDir, account.id),
    );
    if (!credential?.blob) return;
    try {
      const limits = await readUsage(account.agent, credential.blob);
      await options.store.transaction(function* (q) {
        const current = yield* readAgentCredentialSteps(q, options.secretsDir, account.id);
        if (current?.version !== credential.version) return;
        yield* saveProviderUsageSteps(q, account, limits, startedAt);
      });
    } catch (error) {
      await options.store.transaction(function* (q) {
        const current = yield* readAgentCredentialSteps(q, options.secretsDir, account.id);
        if (current?.version !== credential.version) return;
        yield* staleProviderUsageSteps(q, account.id);
        if (!(error instanceof UsageAuthExpired)) return;
        const raw = yield* readAgentAuthSteps(q, account.id);
        yield* writeAgentAuthSteps(
          q,
          account.id,
          JSON.stringify({
            ...(raw ? JSON.parse(raw) : {}),
            health: "auth-expired",
            version: credential.version,
            failures: 1,
            retryAt: now() + 300_000,
          }),
        );
      });
    }
  }
  function accounts() {
    return options.store.run(usageAccountsSteps);
  }
  return {
    async tick(id?: string) {
      for (const account of await accounts()) {
        if ((id && account.id !== id) || !["codex", "claude"].includes(account.agent)) continue;
        const previous = active.get(account.id);
        if (previous && !id) {
          await previous;
          continue;
        }
        const pending = (previous ?? Promise.resolve()).then(() => read(account));
        active.set(account.id, pending);
        try {
          await pending;
        } finally {
          if (active.get(account.id) === pending) active.delete(account.id);
        }
      }
    },
  };
}
