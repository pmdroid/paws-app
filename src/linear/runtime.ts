import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { LinearCommand } from "../core";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import { createIntakePollSource } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import { createLinearFileTransfer, type LinearFileTransfer } from "./files";
import { callerClient, createLinearClient, defaultCallerClient } from "./graphql";
import { createLinearLedger, type LinearLedger, type LinearUsage } from "./budget";
import { createInboxStore } from "./inbox";
import { createLinearIntake, type IntakeQueue } from "./intake-queue";
import {
  createLinearAuth,
  readLinearEnv,
  type EnvSource,
  type FetchLike,
  type LinearAuth,
} from "./oauth";
import {
  CATCH_UP_CURSOR,
  persistStopCommand,
  startCatchUpPoller,
  type CatchUpPoller,
} from "./poller";
import { createLinearTracker } from "./tracker";
import { createSessionStarter } from "./start-session";
import { downTunnel, startNgrokTunnel, type SpawnFn, type Tunnel } from "./tunnel";
import type { LinearWebhookDeps } from "./webhook";
import { createLinearAccessReads, type LinearAccessReads } from "./access";
import { createLinearIssueLifecycle, type LinearIssueLifecycle } from "./issue-lifecycle";
import type { IssueStartReads } from "./issue-start";
import { createLinearMembershipReads, type LinearMembershipReads } from "./membership";

export type LinearRunning = {
  catchUp: () => Promise<void>;
  tunnelUp: () => boolean;
  tunnelRequested: boolean;
  tunnelUrl: string | null;
  stop: () => Promise<void>;
};

export type OpenLinear = {
  memberships: LinearMembershipReads | null;
  webhook: LinearWebhookDeps;
  tracker: TrackerAdapter | null;
  startSession: ReturnType<typeof createSessionStarter> | null;
  files: LinearFileTransfer | null;
  access: LinearAccessReads | null;
  issueLifecycle: LinearIssueLifecycle | null;
  usage(): LinearUsage;
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
  signal?: AbortSignal;
  isAuthorized?: () => boolean;
  /** Overrides `LINEAR_WEBHOOKS`. Default is that env flag, which is off. */
  webhooks?: boolean;
  followUp?: (
    event: AcceptedLinearEvent,
    tracker: TrackerAdapter | null,
  ) => Promise<void | boolean>;
  beforeEvent?: (event: AcceptedLinearEvent, request?: TrackerRequestOptions) => Promise<boolean>;
  progressReporter?: (event: AcceptedLinearEvent) => TrackerAdapter["postProgress"];
  /** Applies `{ type: 'stop' }`. Default enqueues the command job for the loop to drain. */
  submitCommand?: (command: LinearCommand) => void;
  countItemRequest?: (itemId: string) => void;
  fetch?: FetchLike;
  spawn?: SpawnFn;
}): OpenLinear {
  const stopping = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopping.signal])
    : stopping.signal;
  const settings = readLinearEnv(options.env);
  const store = createInboxStore(options.db);
  const accessAllowed = options.isAuthorized ?? (() => true);
  const auth = createLinearAuth({
    db: options.db,
    tokenPath: linearTokenPath(options.secretsDir),
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    bootstrapAccessToken: settings.accessToken,
    bootstrapRefreshToken: settings.refreshToken,
    isAuthorized: accessAllowed,
    fetch: options.fetch,
  });
  const ledger = createLinearLedger({ countItem: options.countItemRequest });
  const client = auth.hasToken()
    ? createLinearClient({ auth, fetch: options.fetch, ledger })
    : null;
  const starts: IssueStartReads = new Map();
  const tracker = client === null ? null : createLinearTracker(client, starts);
  const files =
    client === null
      ? null
      : createLinearFileTransfer({
          client: defaultCallerClient(client, "file-transfer"),
          auth,
          fetch: options.fetch,
          // Closeout videos embed in Linear up to 50 MB.
          maxBytes: 50 * 1024 * 1024,
        });
  const intake =
    tracker === null && options.beforeEvent === undefined
      ? undefined
      : createLinearIntake({
          store,
          tracker,
          followUp: options.followUp,
          beforeEvent: options.beforeEvent,
          progressReporter: options.progressReporter,
          signal,
          ledger,
        });
  const onEvent = intake?.onEvent;
  let running: LinearRunning | null = null;
  return {
    memberships: client === null ? null : createLinearMembershipReads(callerClient(client, "auth")),
    webhook: { store, onEvent, intake: intake?.queue },
    tracker,
    startSession:
      client === null || onEvent === undefined
        ? null
        : createSessionStarter({
            client: defaultCallerClient(client, "session-start"),
            store,
            appUserId: settings.appUserId,
            onEvent,
          }),
    files,
    access:
      client === null
        ? null
        : createLinearAccessReads(callerClient(client, "task-access"), settings.clientId),
    issueLifecycle: client === null ? null : createLinearIssueLifecycle(client, starts),
    usage: () => ({ ...ledger.usage(), lastCatchUpMs: store.getCursor(CATCH_UP_CURSOR) }),
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
      const poller = accessAllowed()
        ? startPoller({
            auth,
            onEvent,
            intake: intake?.queue,
            store,
            tunnel,
            fetchImpl: options.fetch,
            ledger,
            db: options.db,
            teamId: settings.teamId,
            appUserId: settings.appUserId,
            submitCommand:
              options.submitCommand ?? ((command) => persistStopCommand(options.db, command)),
          })
        : null;
      if (poller !== null) intake?.queue.wake();
      running = {
        async catchUp() {
          await poller?.pollNow();
          intake?.queue.wake();
          await intake?.queue.idle();
        },
        tunnelUp: () => tunnel.isUp(),
        tunnelRequested: tunnel.requested,
        tunnelUrl: tunnel.url,
        async stop() {
          stopping.abort();
          const polling = poller?.stop();
          const queued = intake?.queue.stop();
          tunnel.stop();
          await Promise.all([polling, queued]);
          await onEvent?.close();
        },
      };
      return running;
    },
  };
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
  onEvent: ((event: AcceptedLinearEvent) => Promise<void | boolean>) | undefined;
  intake: IntakeQueue | undefined;
  store: ReturnType<typeof createInboxStore>;
  tunnel: Tunnel;
  fetchImpl: FetchLike | undefined;
  ledger: LinearLedger;
  db: Database;
  teamId: string | null;
  appUserId: string | null;
  submitCommand: (command: LinearCommand) => void;
}): CatchUpPoller | null {
  if (!options.auth.hasToken() || options.onEvent === undefined) return null;
  const client = createLinearClient({
    auth: options.auth,
    fetch: options.fetchImpl,
    ledger: options.ledger,
  });
  return startCatchUpPoller({
    source: createIntakePollSource(callerClient(client, "poller"), {
      teamId: options.teamId,
      appUserId: options.appUserId,
    }),
    store: options.store,
    onEvent: options.onEvent,
    intake: options.intake,
    db: options.db,
    submitCommand: options.submitCommand,
    beforeDelay: () => options.tunnel.refresh(),
  });
}
