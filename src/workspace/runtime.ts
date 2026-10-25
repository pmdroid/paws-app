import type { Database } from "bun:sqlite";
import { MEMBERSHIP_BACKSTOP_MS } from "../db";
import type { WorkspaceAssignments } from "./assignments";
import type { OnboardingReadinessReader } from "./onboarding-page";
import type { LinearMembershipReads } from "../linear";
import type { SlackIdentityReads } from "../slack";
import { createWorkspaceAccess } from "./access";
import { issueWorkspaceBootstrap } from "./session";

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
}) {
  const installedOrganization = await options.memberships.installation(AbortSignal.timeout(10_000));
  return createWorkspaceAccess({ ...options, installedOrganization });
}

export async function issueVerifiedWorkspaceBootstrap(
  db: Database,
  memberships: LinearMembershipReads,
) {
  const installation = await memberships.installation(AbortSignal.timeout(10_000));
  return { code: issueWorkspaceBootstrap(db, installation.id), organization: installation };
}

export function startWorkspaceAccess(
  options: Parameters<typeof createWorkspaceAccessFromLinear>[0] & {
    refreshIntervalMs?: number;
    onError: () => void;
  },
) {
  let stopping = false;
  const original = createWorkspaceAccessFromLinear(options);
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
  void access.catch(options.onError);
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
    if (pending === undefined) void refresh().catch(options.onError);
  }, options.refreshIntervalMs ?? MEMBERSHIP_BACKSTOP_MS);
  timer.unref();
  return {
    access,
    refresh,
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.allSettled([pending]);
      await access.then((value) => value.stop()).catch(() => {});
    },
  };
}
