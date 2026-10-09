import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { acknowledgeNewSession } from "./acknowledge";
import type { TrackerAdapter } from "./adapter";
import { createLinearCatchUpSource } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import { createLinearClient } from "./graphql";
import { createInboxStore } from "./inbox";
import { createLinearAuth, readLinearEnv, type EnvSource, type LinearAuth } from "./oauth";
import { startCatchUpPoller, type CatchUpPoller } from "./poller";
import { createLinearTracker } from "./tracker";
import { downTunnel, startNgrokTunnel, type SpawnFn, type Tunnel } from "./tunnel";
import type { LinearWebhookDeps } from "./webhook";

export type LinearRunning = {
  catchUp: () => Promise<void>;
  tunnelUp: () => boolean;
  tunnelRequested: boolean;
  tunnelUrl: string | null;
  stop: () => void;
};

export type OpenLinear = {
  webhook: LinearWebhookDeps;
  tracker: TrackerAdapter | null;
  start(port: number): LinearRunning;
};

export function linearTokenPath(secretsDir: string): string {
  return join(secretsDir, "linear-oauth.json");
}

/** Build the webhook handler. Call `start` with the bound port to launch the tunnel and poller. */
export function openLinear(options: {
  db: Database;
  secretsDir: string;
  env: EnvSource;
  publicUrl: string | null;
  noTunnel?: boolean;
  followUp?: (event: AcceptedLinearEvent, tracker: TrackerAdapter) => Promise<void>;
  fetch?: typeof fetch;
  spawn?: SpawnFn;
}): OpenLinear {
  const settings = readLinearEnv(options.env);
  const store = createInboxStore(options.db);
  const auth = createLinearAuth({
    tokenPath: linearTokenPath(options.secretsDir),
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    bootstrapAccessToken: settings.accessToken,
    bootstrapRefreshToken: settings.refreshToken,
    fetch: options.fetch,
  });
  const tracker = auth.hasToken()
    ? createLinearTracker(createLinearClient({ auth, fetch: options.fetch }))
    : null;
  const onEvent = tracker === null ? undefined : shareEvents(tracker, options.followUp);
  let running: LinearRunning | null = null;
  return {
    webhook: { store, onEvent },
    tracker,
    start(port) {
      if (running !== null) return running;
      const tunnel = openTunnel({
        port,
        publicUrl: options.publicUrl,
        noTunnel: options.noTunnel === true || settings.noTunnel,
        authtoken: settings.ngrokAuthtoken,
        spawn: options.spawn,
      });
      const poller = startPoller(auth, onEvent, store, tunnel, options.fetch);
      running = {
        catchUp: () => poller?.pollNow() ?? Promise.resolve(),
        tunnelUp: () => tunnel.isUp(),
        tunnelRequested: tunnel.requested,
        tunnelUrl: tunnel.url,
        stop() {
          poller?.stop();
          tunnel.stop();
        },
      };
      return running;
    },
  };
}

function shareEvents(
  tracker: TrackerAdapter,
  followUp: ((event: AcceptedLinearEvent, tracker: TrackerAdapter) => Promise<void>) | undefined,
): (event: AcceptedLinearEvent) => Promise<void> {
  const inflight = new Map<string, Promise<void>>();
  return (event) => {
    const existing = inflight.get(event.dedupeKey);
    if (existing !== undefined) return existing;
    const work = acknowledgeNewSession(
      tracker,
      event,
      (accepted) => followUp?.(accepted, tracker) ?? Promise.resolve(),
    ).finally(() => {
      inflight.delete(event.dedupeKey);
    });
    inflight.set(event.dedupeKey, work);
    return work;
  };
}

function openTunnel(options: {
  port: number;
  publicUrl: string | null;
  noTunnel: boolean;
  authtoken: string | null;
  spawn: SpawnFn | undefined;
}): Tunnel {
  if (options.noTunnel) return downTunnel();
  if (options.publicUrl === null || !options.publicUrl.startsWith("https://")) return downTunnel();
  return startNgrokTunnel({
    port: options.port,
    url: options.publicUrl,
    authtoken: options.authtoken,
    spawn: options.spawn,
  });
}

function startPoller(
  auth: LinearAuth,
  onEvent: ((event: AcceptedLinearEvent) => Promise<void>) | undefined,
  store: ReturnType<typeof createInboxStore>,
  tunnel: Tunnel,
  fetchImpl: typeof fetch | undefined,
): CatchUpPoller | null {
  if (!auth.hasToken() || onEvent === undefined) return null;
  return startCatchUpPoller({
    source: createLinearCatchUpSource(createLinearClient({ auth, fetch: fetchImpl })),
    store,
    onEvent,
    tunnelUp: () => tunnel.isUp(),
    beforeDelay: () => tunnel.refresh(),
  });
}
