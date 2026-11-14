import type { ActiveGitHubApp } from "../auth";
import { createFetchGitHubClient, listAppRepositories, type GitHubWebhook } from "../github";
import { journalCaught } from "../journal";

type App = ActiveGitHubApp & { installationId: string };
type Listing = { repositories: { repository: string; private: boolean }[]; refreshedAt: number };
type Entry = { app: App; listing?: Listing; loading?: Promise<Listing> };

export type InstallationRepositoryCache = ReturnType<typeof createInstallationRepositoryCache>;

export function createInstallationRepositoryCache(
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const stale = (entry: Entry) => !entry.listing || now() - entry.listing.refreshedAt >= 600_000;
  function load(entry: Entry, force = false): Promise<Listing> {
    if (entry.loading && !force) return entry.loading;
    const http = options.fetch ?? fetch;
    const signal = AbortSignal.timeout(10_000);
    const loading = listAppRepositories({
      client: createFetchGitHubClient((url, init) =>
        http(String(url), { ...init, signal, redirect: "error" }),
      ),
      appId: entry.app.appId,
      installationId: entry.app.installationId,
      privateKeyPem: entry.app.privateKeyPem,
      signal,
    }).then((found) => {
      const repositories = found
        .map((repo) => ({
          repository: `${repo.owner}/${repo.repo}`.toLowerCase(),
          private: repo.private === true,
        }))
        .sort((a, b) => a.repository.localeCompare(b.repository));
      if (entry.loading === loading) entry.listing = { repositories, refreshedAt: now() };
      return { repositories, refreshedAt: now() };
    });
    entry.loading = loading;
    return loading.finally(() => {
      if (entry.loading === loading) entry.loading = undefined;
    });
  }
  const background = (entry: Entry, force = false) =>
    load(entry, force).then(
      () => undefined,
      (caught: unknown) =>
        journalCaught(caught, "github-installation-cache.load", null, "the cached list stays"),
    );
  return {
    list(app: App): Promise<Listing> {
      const key = `${app.appId}:${app.installationId}`;
      const entry = entries.get(key) ?? { app };
      entries.set(key, Object.assign(entry, { app }));
      if (!entry.listing) return load(entry);
      if (stale(entry)) void background(entry);
      return Promise.resolve(entry.listing);
    },
    refresh(installationId: string) {
      const changed = [...entries.values()].filter(
        (entry) => entry.app.installationId === installationId,
      );
      return Promise.all(changed.map((entry) => background(entry, true))).then(() => undefined);
    },
    sweep() {
      return Promise.all([...entries.values()].filter(stale).map((entry) => background(entry)));
    },
  };
}

export function refreshingInstallations(
  cache: InstallationRepositoryCache,
  inbox: GitHubWebhook | undefined,
): GitHubWebhook | undefined {
  if (!inbox) return inbox;
  return {
    async accept(delivery) {
      const result = await inbox.accept(delivery);
      const id = (JSON.parse(delivery.payload) as { installation?: { id?: unknown } }).installation
        ?.id;
      if (/^installation(_repositories)?$/.test(delivery.event) && Number.isSafeInteger(id))
        await cache.refresh(String(id));
      return result;
    },
  };
}
