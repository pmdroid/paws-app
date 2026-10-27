import { journalCaught, journalRejection } from "../journal";
import type { Database } from "bun:sqlite";
import { MEMBERSHIP_BACKSTOP_MS } from "../db";
import type { WorkspaceAssignments } from "./assignments";
import type { OnboardingReadinessReader } from "./onboarding-page";
import type { LinearMembershipReads } from "../linear";
import type { SlackIdentityReads } from "../slack";
import { createWorkspaceAccess } from "./access";

export async function createWorkspaceAccessFromLinear(options: {
  db: Database;
  assignments?: WorkspaceAssignments;
  onboardingReadiness?: OnboardingReadinessReader;
  createVmAvailable?: () => Promise<boolean>;
  publicUrl: string;
  clientId: string;
  memberships: LinearMembershipReads;
  slackIdentities?: SlackIdentityReads | null;
  githubAttributionClient?: { clientId: string; clientSecret: string };
  verifyTeam?: (id: string, signal: AbortSignal) => Promise<boolean>;
  readTeams?: (signal: AbortSignal) => Promise<{ id: string; name: string; key: string }[]>;
  signal?: AbortSignal;
}) {
  const timeout = AbortSignal.timeout(10_000);
  const installedOrganization = await options.memberships.installation(
    options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  );
  return createWorkspaceAccess({ ...options, installedOrganization });
}

const ACCESS_RETRY_BASE_MS = 2_000;
const ACCESS_RETRY_CAP_MS = 60_000;

export function startWorkspaceAccess(
  options: Parameters<typeof createWorkspaceAccessFromLinear>[0] & {
    refreshIntervalMs?: number;
    accessRetryBaseMs?: number;
    /** Whether a failed startup read is worth retrying; the composition passes `isTransient`. */
    retryable?: (error: unknown) => boolean;
    onError: () => void;
  },
) {
  let stopping = false;
  const stopped = new AbortController();
  /**
   * A slow or failing Linear read at startup must not exit Paws: the server answers 503 until
   * access resolves, so a retryable failure retries with backoff until it succeeds or Paws stops.
   * Any other failure, such as a missing app installation, still rejects.
   */
  async function resolveAccess() {
    for (let attempt = 1; ; attempt++) {
      try {
        return await createWorkspaceAccessFromLinear({ ...options, signal: stopped.signal });
      } catch (error) {
        if (stopping) throw new Error("Workspace access is stopping.", { cause: error });
        if (!options.retryable?.(error)) throw error;
        journalCaught(error, "workspace/runtime.startWorkspaceAccess.retry", null, "retrying");
        const delay = Math.min(
          ACCESS_RETRY_CAP_MS,
          (options.accessRetryBaseMs ?? ACCESS_RETRY_BASE_MS) * 2 ** Math.min(20, attempt - 1),
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          function done() {
            clearTimeout(timer);
            stopped.signal.removeEventListener("abort", done);
            resolve();
          }
          stopped.signal.addEventListener("abort", done, { once: true });
        });
        if (stopping) throw new Error("Workspace access is stopping.", { cause: error });
      }
    }
  }
  const original = resolveAccess();
  function accepting<T>(run: () => Promise<T>): Promise<T> {
    if (stopping) return Promise.reject(new Error("Workspace access is stopping."));
    return run();
  }
  const access = original.then((value) => ({
    ...value,
    authenticate: (request: Request) => accepting(() => value.authenticate(request)),
    repositoryTeams: (request: Request, signal: AbortSignal) =>
      accepting(() => value.repositoryTeams(request, signal)),
    handle: (request: Request) => accepting(() => value.handle(request)),
    refreshMemberships: () => accepting(() => value.refreshMemberships()),
  }));
  void access.catch(
    journalRejection("workspace/runtime.startWorkspaceAccess.access", options.onError, null),
  );
  let pending: Promise<void> | undefined;
  let requested = 0;
  function refresh(): Promise<void> {
    if (stopping) return Promise.resolve();
    requested++;
    if (pending !== undefined) return pending;
    const operation: Promise<void> = access
      .then(async (value) => {
        try {
          for (;;) {
            const generation = requested;
            try {
              await (stopping
                ? original.then((active) => active.refreshMemberships())
                : value.refreshMemberships());
            } catch (error) {
              if (generation === requested) throw error;
              journalCaught(error, "runtime.refresh.then", null);
            }
            if (generation === requested) return;
          }
        } finally {
          if (pending === operation) pending = undefined;
        }
      })
      .finally(() => {
        if (pending === operation) pending = undefined;
      });
    pending = operation;
    return operation;
  }

  const timer = setInterval(() => {
    if (pending === undefined)
      void refresh().catch(
        journalRejection("workspace/runtime.startWorkspaceAccess.refresh", options.onError, null),
      );
  }, options.refreshIntervalMs ?? MEMBERSHIP_BACKSTOP_MS);
  timer.unref();
  return {
    access,
    refresh,
    async stop() {
      stopping = true;
      stopped.abort();
      clearInterval(timer);
      await Promise.allSettled([pending]);
      await access
        .then((value) => value.stop())
        .catch((caughtError1) => {
          journalCaught(caughtError1, "runtime.stop.then", null);
        });
    },
  };
}
