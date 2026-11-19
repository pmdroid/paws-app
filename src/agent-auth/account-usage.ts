import {
  staleProviderUsageSteps,
  usageAccountsSteps,
  saveProviderUsageSteps,
  readAgentAuthSteps,
  writeAgentAuthSteps,
  type Db,
} from "../db";
import { readAgentCredentialSteps } from "../credentials";
import {
  createUsageReader,
  UsageAuthExpired,
  UsageCredentialExpired,
  UsageUnavailable,
} from "./usage";
export function createAccountUsage(options: {
  store: Db;
  secretsDir: string;
  now?: () => number;
  readUsage?: ReturnType<typeof createUsageReader>;
  refresh?: (accountId: string) => Promise<boolean>;
}) {
  const now = options.now ?? Date.now;
  const readUsage = options.readUsage ?? createUsageReader(undefined, now);
  const active = new Map<string, Promise<void>>();
  async function read(account: Awaited<ReturnType<typeof accounts>>[number], refreshed = false) {
    const startedAt = now();
    const credential = await options.store.run((q) =>
      readAgentCredentialSteps(q, options.secretsDir, account.id),
    );
    if (!credential?.blob) return;
    const files: { path: string }[] = JSON.parse(credential.blob);
    if (files.some((file) => file.path === ".paws/api-key.json")) return;
    try {
      const limits = await readUsage(account.agent, credential.blob);
      await options.store.transaction(function* (q) {
        const current = yield* readAgentCredentialSteps(q, options.secretsDir, account.id);
        if (current?.version !== credential.version) return;
        yield* saveProviderUsageSteps(q, account, limits, startedAt);
      });
    } catch (error) {
      const expired = error instanceof UsageAuthExpired || error instanceof UsageCredentialExpired;
      if (
        expired &&
        !refreshed &&
        account.agent === "grok" &&
        options.refresh &&
        (await options.refresh(account.id))
      )
        return read(account, true);
      await options.store.transaction(function* (q) {
        const current = yield* readAgentCredentialSteps(q, options.secretsDir, account.id);
        if (current?.version !== credential.version) return;
        yield* staleProviderUsageSteps(
          q,
          account,
          error instanceof UsageUnavailable
            ? error.message
            : expired
              ? "Sign in again to see usage"
              : "Usage unavailable",
          now(),
        );
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
      const failures: unknown[] = [];
      for (const account of await accounts()) {
        if (
          (id && account.id !== id) ||
          !["codex", "claude", "grok", "opencode"].includes(account.agent)
        )
          continue;
        const previous = active.get(account.id);
        if (previous && !id) {
          await previous;
          continue;
        }
        const pending = (previous ?? Promise.resolve()).then(() => read(account));
        active.set(account.id, pending);
        try {
          await pending;
        } catch (error) {
          failures.push(error);
        } finally {
          if (active.get(account.id) === pending) active.delete(account.id);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Provider usage poll failed");
    },
  };
}
