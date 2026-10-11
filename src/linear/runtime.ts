import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { LinearCommand } from "../core";
import { acknowledgeNewSession } from "./acknowledge";
import type { TrackerAdapter } from "./adapter";
import type { ProgressUpdate } from "./types";
import { createIntakePollSource } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import { createLinearFileTransfer, type LinearFileTransfer } from "./files";
import { createLinearClient } from "./graphql";
import { createInboxStore } from "./inbox";
import {
  createLinearAuth,
  readLinearEnv,
  type EnvSource,
  type FetchLike,
  type LinearAuth,
} from "./oauth";
import {
  linearWorkIsHot,
  persistStopCommand,
  startCatchUpPoller,
  type CatchUpPoller,
} from "./poller";
import { createLinearTracker } from "./tracker";
import { downTunnel, startNgrokTunnel, type SpawnFn, type Tunnel } from "./tunnel";
import type { LinearWebhookDeps } from "./webhook";

export type LinearRunning = {
  catchUp: () => Promise<void>;
  tunnelUp: () => boolean;
  tunnelRequested: boolean;
  tunnelUrl: string | null;
  stop: () => Promise<void>;
};

export type OpenLinear = {
  webhook: LinearWebhookDeps;
  tracker: TrackerAdapter | null;
  files: LinearFileTransfer | null;
  start(port: number): LinearRunning;
};

export function linearTokenPath(secretsDir: string): string {
  return join(secretsDir, "linear-oauth.json");
}

/**
 * Build the inbox and tracker. Call `start` with the bound port to poll Linear.
 * The ngrok child starts only when `webhooks` is on (env `LINEAR_WEBHOOKS`).
 */
export function openLinear(options: {
  db: Database;
  secretsDir: string;
  env: EnvSource;
  publicUrl: string | null;
  noTunnel?: boolean;
  /** Overrides `LINEAR_WEBHOOKS`. Default is that env flag, which is off. */
  webhooks?: boolean;
  followUp?: (event: AcceptedLinearEvent, tracker: TrackerAdapter) => Promise<void>;
  progressReporter?: (event: AcceptedLinearEvent) => (update: ProgressUpdate) => Promise<void>;
  /** Applies `{ type: 'stop' }`. Default enqueues the command job for the loop to drain. */
  submitCommand?: (command: LinearCommand) => void;
  fetch?: FetchLike;
  spawn?: SpawnFn;
}): OpenLinear {
  const settings = readLinearEnv(options.env);
  const store = createInboxStore(options.db);
  const auth = createLinearAuth({
    db: options.db,
    tokenPath: linearTokenPath(options.secretsDir),
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    bootstrapAccessToken: settings.accessToken,
    bootstrapRefreshToken: settings.refreshToken,
    fetch: options.fetch,
  });
  const client = auth.hasToken() ? createLinearClient({ auth, fetch: options.fetch }) : null;
  const tracker = client === null ? null : createLinearTracker(client);
  const files =
    client === null ? null : createLinearFileTransfer({ client, auth, fetch: options.fetch });
  const onEvent =
    tracker === null ? undefined : shareEvents(tracker, options.followUp, options.progressReporter);
  let running: LinearRunning | null = null;
  return {
    webhook: { store, onEvent },
    tracker,
    files,
    start(port) {
      if (running !== null) return running;
      const webhooks = options.webhooks ?? settings.webhooks;
      const tunnel = openTunnel({
        port,
        publicUrl: options.publicUrl,
        webhooks,
        noTunnel: options.noTunnel === true || settings.noTunnel,
        authtoken: settings.ngrokAuthtoken,
        spawn: options.spawn,
      });
      const poller = startPoller({
        auth,
        onEvent,
        store,
        tunnel,
        fetchImpl: options.fetch,
        db: options.db,
        teamId: settings.teamId,
        appUserId: settings.appUserId,
        submitCommand:
          options.submitCommand ?? ((command) => persistStopCommand(options.db, command)),
      });
      running = {
        catchUp: () => poller?.pollNow() ?? Promise.resolve(),
        tunnelUp: () => tunnel.isUp(),
        tunnelRequested: tunnel.requested,
        tunnelUrl: tunnel.url,
        async stop() {
          const polling = poller?.stop();
          const events = onEvent?.close();
          tunnel.stop();
          await Promise.all([polling, events]);
        },
      };
      return running;
    },
  };
}

function shareEvents(
  tracker: TrackerAdapter,
  followUp: ((event: AcceptedLinearEvent, tracker: TrackerAdapter) => Promise<void>) | undefined,
  progressReporter:
    | ((event: AcceptedLinearEvent) => (update: ProgressUpdate) => Promise<void>)
    | undefined,
): ((event: AcceptedLinearEvent) => Promise<void>) & { close(): Promise<void> } {
  const inflight = new Map<string, Promise<void>>();
  let closed = false;
  const deliver = (event: AcceptedLinearEvent) => {
    if (closed) return Promise.reject(new Error("Linear event delivery is shutting down"));
    const existing = inflight.get(event.dedupeKey);
    if (existing !== undefined) return existing;
    const reportProgress = progressReporter?.(event);
    const acknowledger = reportProgress ? { ...tracker, postProgress: reportProgress } : tracker;
    const work = acknowledgeNewSession(
      acknowledger,
      event,
      (accepted) => followUp?.(accepted, tracker) ?? Promise.resolve(),
    ).finally(() => {
      inflight.delete(event.dedupeKey);
    });
    inflight.set(event.dedupeKey, work);
    return work;
  };
  return Object.assign(deliver, {
    async close() {
      closed = true;
      await Promise.allSettled([...inflight.values()]);
    },
  });
}

function openTunnel(options: {
  port: number;
  publicUrl: string | null;
  webhooks: boolean;
  noTunnel: boolean;
  authtoken: string | null;
  spawn: SpawnFn | undefined;
}): Tunnel {
  if (!options.webhooks || options.noTunnel) return downTunnel();
  if (options.publicUrl === null || !options.publicUrl.startsWith("https://")) return downTunnel();
  return startNgrokTunnel({
    port: options.port,
    url: options.publicUrl,
    authtoken: options.authtoken,
    spawn: options.spawn,
  });
}

function startPoller(options: {
  auth: LinearAuth;
  onEvent: ((event: AcceptedLinearEvent) => Promise<void>) | undefined;
  store: ReturnType<typeof createInboxStore>;
  tunnel: Tunnel;
  fetchImpl: FetchLike | undefined;
  db: Database;
  teamId: string | null;
  appUserId: string | null;
  submitCommand: (command: LinearCommand) => void;
}): CatchUpPoller | null {
  if (!options.auth.hasToken() || options.onEvent === undefined) return null;
  const client = createLinearClient({ auth: options.auth, fetch: options.fetchImpl });
  return startCatchUpPoller({
    source: createIntakePollSource(client, {
      teamId: options.teamId,
      appUserId: options.appUserId,
    }),
    store: options.store,
    onEvent: options.onEvent,
    db: options.db,
    hot: () => linearWorkIsHot(options.db),
    submitCommand: options.submitCommand,
    beforeDelay: () => options.tunnel.refresh(),
  });
}
