import { createFindingIssueAdapter, type FindingIssueAdapter } from "./finding-group-issues";
import {
  createLinearImprovementDelivery,
  createLinearImprovementIssueLookup,
  type ImprovementLinear,
} from "./improvement-issues";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { IN_FLIGHT_ITEM_STATES, type LinearCommand } from "../core";
import { sessionHasItemInStates, type Db } from "../db";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import { createIntakePollSource } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import { createLinearFileTransfer, type LinearFileTransfer } from "./files";
import { callerClient, createLinearClient, defaultCallerClient } from "./graphql";
import {
  createLinearLedger,
  type LinearLedger,
  type LinearSharedBudget,
  type LinearUsage,
} from "./budget";
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
import type { LinearWebhookDeps } from "./webhook";
import { createLinearAccessReads, type LinearAccessReads } from "./access";
import { createLinearIssueLifecycle, type LinearIssueLifecycle } from "./issue-lifecycle";
import type { IssueStartReads } from "./issue-start";
import { createLinearMembershipReads, type LinearMembershipReads } from "./membership";

export type LinearRunning = {
  catchUp: () => Promise<void>;
  pollDue: () => Promise<void>;
  stop: () => Promise<void>;
};

export type OpenLinear = {
  findingIssues: FindingIssueAdapter | null;
  improvementIssues: ReturnType<typeof createLinearImprovementIssueLookup> | null;
  improvementDelivery: ImprovementLinear | null;
  memberships: LinearMembershipReads | null;
  webhook: LinearWebhookDeps;
  tracker: TrackerAdapter | null;
  startSession: ReturnType<typeof createSessionStarter> | null;
  files: LinearFileTransfer | null;
  access: LinearAccessReads | null;
  issueLifecycle: LinearIssueLifecycle | null;
  usage(): Promise<LinearUsage>;
  start(): Promise<LinearRunning>;
};

export function linearTokenPath(secretsDir: string): string {
  return join(secretsDir, "linear-oauth.json");
}

/**
 * Build the inbox and tracker. Call `start` to poll Linear.
 */
export async function openLinear(options: {
  db: Database | Db;
  store: Db;
  secretsDir: string;
  env: EnvSource;
  signal?: AbortSignal;
  isAuthorized?: () => Promise<boolean>;
  followUp?: (
    event: AcceptedLinearEvent,
    tracker: TrackerAdapter | null,
  ) => Promise<void | boolean>;
  beforeEvent?: (event: AcceptedLinearEvent, request?: TrackerRequestOptions) => Promise<boolean>;
  progressReporter?: (event: AcceptedLinearEvent) => TrackerAdapter["postProgress"];
  /** Applies `{ type: 'stop' }`. Default enqueues the command job for the loop to drain. */
  submitCommand?: (command: LinearCommand) => Promise<void>;
  countItemRequest?: (itemId: string, caller: string) => void | Promise<void>;
  budget?: LinearSharedBudget;
  fetch?: FetchLike;
}): Promise<OpenLinear> {
  const stopping = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopping.signal])
    : stopping.signal;
  const settings = readLinearEnv(options.env);
  const store = createInboxStore(options.store);
  const accessAllowed = options.isAuthorized ?? (async () => true);
  const auth = await createLinearAuth({
    db: options.db,
    secretsDir: options.secretsDir,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    bootstrapAccessToken: settings.accessToken,
    bootstrapRefreshToken: settings.refreshToken,
    isAuthorized: accessAllowed,
    fetch: options.fetch,
  });
  const ledger = createLinearLedger({
    countItem: options.countItemRequest,
    shared: options.budget,
  });
  const client = (await auth.hasToken())
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
          sessionBusy: (sessionId) => sessionHasItemInFlight(options.store, sessionId),
          signal,
          ledger,
        });
  const onEvent = intake?.onEvent;
  let running: Promise<LinearRunning> | null = null;
  return {
    findingIssues:
      client === null
        ? null
        : createFindingIssueAdapter(defaultCallerClient(client, "finding-groups")),
    improvementIssues:
      client === null
        ? null
        : createLinearImprovementIssueLookup(defaultCallerClient(client, "finding-groups")),
    improvementDelivery:
      client === null
        ? null
        : createLinearImprovementDelivery(defaultCallerClient(client, "finding-groups")),
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
    usage: async () => ({
      ...ledger.usage(),
      lastCatchUpMs: await store.getCursor(CATCH_UP_CURSOR),
    }),
    start() {
      running ??= startRunning();
      return running;
    },
  };

  async function startRunning(): Promise<LinearRunning> {
    const poller = (await accessAllowed())
      ? await startPoller({
          auth,
          onEvent,
          intake: intake?.queue,
          store,
          fetchImpl: options.fetch,
          ledger,
          db: options.store,
          teamId: settings.teamId,
          appUserId: settings.appUserId,
          submitCommand:
            options.submitCommand ??
            (async (command) => await persistStopCommand(options.store, command)),
        })
      : null;
    if (poller !== null) intake?.queue.wake();
    return {
      async catchUp() {
        await poller?.pollNow();
        intake?.queue.wake();
        await intake?.queue.idle();
      },
      async pollDue() {
        await poller?.pollDue();
      },
      async stop() {
        stopping.abort();
        const polling = poller?.stop();
        const queued = intake?.queue.stop();
        await Promise.all([polling, queued]);
        await onEvent?.close();
      },
    };
  }
}

async function startPoller(options: {
  auth: LinearAuth;
  onEvent: ((event: AcceptedLinearEvent) => Promise<void | boolean>) | undefined;
  intake: IntakeQueue | undefined;
  store: ReturnType<typeof createInboxStore>;
  fetchImpl: FetchLike | undefined;
  ledger: LinearLedger;
  db: Db;
  teamId: string | null;
  appUserId: string | null;
  submitCommand: (command: LinearCommand) => Promise<void>;
}): Promise<CatchUpPoller | null> {
  if (!(await options.auth.hasToken()) || options.onEvent === undefined) return null;
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
    timer: false,
  });
}

/** The session already has an item running, verifying, waiting for an answer or merging. */
export function sessionHasItemInFlight(db: Db, sessionId: string): Promise<boolean> {
  return sessionHasItemInStates(db, sessionId, IN_FLIGHT_ITEM_STATES);
}
