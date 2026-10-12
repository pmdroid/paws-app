import { createDashboardGitHubAuth, type LoginIO } from "./login";
import { fetchGitHubAccount } from "./github-device";
import { createTokenStore, type GitHubTokenStore } from "./store";
import { DEVICE_SCOPE_MESSAGE, GITHUB_REAUTH_MESSAGE } from "./messages";

export function createVerifiedGitHubLogin(options: LoginIO & { home: string }) {
  const store = options.store ?? createTokenStore({ home: options.home });
  return {
    async linkedAccount(): Promise<number | null> {
      return (await store.load())?.id ?? null;
    },
    async check(signal: AbortSignal): Promise<{ id: number; login: string } | null> {
      const stored = await store.load();
      if (stored === null || stored.invalid) return null;
      try {
        const account = await fetchGitHubAccount({
          token: stored.accessToken,
          app: options.auth === "app",
          fetch: (url, init) => (options.fetch ?? fetch)(url, { ...init, signal }),
        });
        if (account.id !== stored.id) return null;
        const current = await store.load();
        signal.throwIfAborted();
        if (
          current?.id !== stored.id ||
          current.accessToken !== stored.accessToken ||
          current.invalid
        )
          return null;
        return { id: account.id, login: account.login };
      } catch (error) {
        if (
          error instanceof Error &&
          [GITHUB_REAUTH_MESSAGE, DEVICE_SCOPE_MESSAGE].includes(error.message)
        ) {
          signal.throwIfAborted();
          await store.update((current) => {
            signal.throwIfAborted();
            return current?.id === stored.id && current.accessToken === stored.accessToken
              ? { ...current, invalid: true }
              : null;
          });
          return null;
        }
        throw error;
      }
    },
    async begin(input: {
      signal: AbortSignal;
      acceptAccount: (id: number) => boolean;
    }): Promise<{ url: string; body: string; completed: Promise<{ id: number; login: string }> }> {
      const guarded: GitHubTokenStore = {
        get backend() {
          return store.backend;
        },
        get warning() {
          return store.warning;
        },
        load: () => store.load(),
        markInvalid: () => store.markInvalid(),
        delete: () => store.delete(),
        update: (change) => store.update(change),
        async save(token) {
          await store.update((linked) => {
            input.signal.throwIfAborted();
            if (linked?.id !== token.id || !input.acceptAccount(token.id))
              throw new Error("The GitHub account does not match this authorization request.");
            return token;
          });
        },
      };
      const flow = await createDashboardGitHubAuth({
        ...options,
        signal: input.signal,
        store: guarded,
        stdout: () => undefined,
        openBrowser: async () => undefined,
        fetch: (url, init) =>
          (options.fetch ?? fetch)(url, {
            ...init,
            signal: init?.signal ? AbortSignal.any([input.signal, init.signal]) : input.signal,
          }),
        sleep: (ms) =>
          new Promise<void>((resolve, reject) => {
            const cancelled = () => {
              clearTimeout(timer);
              reject(new Error("GitHub authorization was cancelled."));
            };
            const timer = setTimeout(() => {
              input.signal.removeEventListener("abort", cancelled);
              resolve();
            }, ms);
            input.signal.addEventListener("abort", cancelled, { once: true });
            if (input.signal.aborted) cancelled();
          }),
      }).beginDevice();
      return {
        url: flow.verificationUri,
        body: flow.userCode
          ? `Sign in to GitHub using code ${flow.userCode} to continue.`
          : "Sign in to GitHub to continue.",
        completed: flow.completed,
      };
    },
  };
}
