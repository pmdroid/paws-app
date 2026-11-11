import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import {
  authorizeHostedGitHubUser,
  createWorkspaceGitHubActivation,
  githubAppAuthorization,
  hash,
  newGitHubOAuthSecret,
  verifyHostedGitHubRepositories,
  type ActiveGitHubApp,
} from "../auth";
import {
  advanceGithubConnectionSteps,
  auditWorkspaceAccessSteps,
  claimGithubOAuthSteps,
  completeGithubOAuthSteps,
  deleteGithubOAuthSteps,
  emitJobReady,
  enqueueJobSteps,
  ensureGithubConnectionSteps,
  expiredGithubOAuthSteps,
  failGithubOAuthSteps,
  githubConnectionSteps,
  githubOAuthStateExistsSteps,
  insertGithubOAuthSteps,
  latestCompleteGithubOAuthSteps,
  updateGithubOAuthIntentSteps,
  listWorkspaceRepositoriesSteps,
  replaceWorkspaceRepositoriesSteps,
  type Db,
  type Q,
} from "../db";
import { readWorkspaceJson, requestWorkspaceSessionSteps, validWorkspaceCsrf } from "../workspace";
import { discoverGitHubInstallation } from "./github-connect-status";
import { githubRepositoryChoices } from "./github-repository-choices";
import { dashboardUrl } from "../dashboard-links";

const START = "/api/workspaces/github-setup";
const CALLBACK = "/auth/github-app/callback";
const KIND = "repository-setup";
type Pending = {
  state_hash: string;
  secret_id: string;
  expected_generation: number;
  intent: string;
  expires_at: number;
  status: string;
};
type Secret = {
  app: ActiveGitHubApp;
  verifier: string;
  user?: { id: number; login: string; token: string };
};

export function createGitHubRepositorySetup(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  teams: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ id: string; name: string; key: string }[]>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const activation = createWorkspaceGitHubActivation(store, options.home, options.env);
  const origin = new URL(options.origin).origin;
  if (!origin.startsWith("https://")) throw new Error("GitHub setup requires HTTPS.");
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== START && url.pathname !== CALLBACK) return null;
    const state = url.searchParams.get("state");
    if (
      url.pathname === CALLBACK &&
      (!state ||
        state.length > 128 ||
        !(await store.run((q) => githubOAuthStateExistsSteps(q, hash(state), KIND))))
    )
      return null;
    const access = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
    const denied = () =>
      reply(
        {
          code: access?.principal.role === "admin" ? "reauth_required" : "admin_required",
          error:
            access?.principal.role === "admin"
              ? "Sign in again to set up GitHub repositories."
              : "Ask a workspace admin to set up GitHub repositories.",
        },
        403,
      );
    function* permittedSteps(q: Q) {
      const current = yield* requestWorkspaceSessionSteps(q, request, now());
      return (
        access &&
        current?.session.tokenHash === access.session.tokenHash &&
        current.principal.workspaceId === access.principal.workspaceId &&
        current.principal.role === "admin"
      );
    }
    const permitted = () => store.run(permittedSteps);
    const selected = url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host) ||
      !(await permitted()) ||
      (selected !== null && selected !== access!.principal.workspaceId)
    )
      return denied();
    if (
      (url.pathname === CALLBACK && request.method !== "GET") ||
      (url.pathname === START && !["GET", "POST", "PUT"].includes(request.method))
    )
      return reply({ error: "Method not allowed" }, 405);
    if (
      !["GET"].includes(request.method) &&
      (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access!.session))
    )
      return denied();
    const workspaceId = access!.principal.workspaceId;
    const userId = access!.principal.userId;
    const sessionHash = access!.session.tokenHash;
    function* scopeSteps(q: Q) {
      return JSON.stringify(yield* listWorkspaceRepositoriesSteps(q, workspaceId));
    }
    const scope = () => store.run(scopeSteps);
    const listed = () => store.run((q) => listWorkspaceRepositoriesSteps(q, workspaceId));
    const requester = { workspaceId, userId, sessionHash };
    function* generationSteps(q: Q) {
      return (yield* githubConnectionSteps(q, workspaceId))?.generation ?? 0;
    }
    const generation = () => store.run(generationSteps);
    const find = () => store.run((q) => latestCompleteGithubOAuthSteps(q, requester, KIND, now()));
    function* unchangedSteps(q: Q, pending: Pending, secret: Secret) {
      const row = yield* latestCompleteGithubOAuthSteps(q, requester, KIND, now());
      return Boolean(
        (yield* permittedSteps(q)) &&
        row?.state_hash === pending.state_hash &&
        row.secret_id === pending.secret_id &&
        row.expected_generation === pending.expected_generation &&
        row.intent === pending.intent &&
        pending.expires_at > now() &&
        (yield* generationSteps(q)) === pending.expected_generation &&
        JSON.parse(pending.intent).scope === (yield* scopeSteps(q)) &&
        JSON.stringify(activation.template()) === JSON.stringify(secret.app),
      );
    }
    const unchanged = (pending: Pending, secret: Secret) =>
      store.run((q) => unchangedSteps(q, pending, secret));
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    try {
      for (const expired of await store.run((q) =>
        expiredGithubOAuthSteps(q, workspaceId, KIND, now()),
      )) {
        activation.remove(expired.secret_id);
        await store.run((q) => deleteGithubOAuthSteps(q, expired.state_hash));
      }
      if (url.pathname === CALLBACK) {
        const code = url.searchParams.get("code");
        if (!state || !code || code.length > 4096 || url.searchParams.has("error"))
          return reply({ error: "GitHub sign-in was not completed. Start again." }, 400);
        const pending = await store.run((q) =>
          claimGithubOAuthSteps(q, hash(state), requester, now()),
        );
        if (!pending) return denied();
        const secret = activation.read<Secret>(pending.secret_id);
        let grantId: string | undefined;
        try {
          const user = await authorizeHostedGitHubUser({
            ...secret,
            code,
            redirectUri: origin + CALLBACK,
            signal,
            fetch: http,
          });
          await discoverGitHubInstallation(secret.app, [], signal, http);
          if (
            !(await permitted()) ||
            pending.expires_at <= now() ||
            (await generation()) !== pending.expected_generation ||
            JSON.parse(pending.intent).scope !== (await scope()) ||
            JSON.stringify(activation.template()) !== JSON.stringify(secret.app)
          )
            return denied();
          grantId = randomUUID();
          activation.save(grantId, { ...secret, user });
          const granted = grantId;
          if (!(await store.run((q) => completeGithubOAuthSteps(q, pending.state_hash, granted))))
            throw new Error("GitHub setup changed. Start again.");
          grantId = undefined;
          return new Response(null, {
            status: 303,
            headers: {
              location: dashboardUrl(origin, "/settings/integrations"),
              "cache-control": "no-store",
            },
          });
        } finally {
          activation.remove(pending.secret_id);
          if (grantId) activation.remove(grantId);
          await store.run((q) => failGithubOAuthSteps(q, pending.state_hash, true));
        }
      }
      if (request.method === "POST") {
        const body = await readWorkspaceJson(request);
        if (!record(body) || Object.keys(body).length)
          return reply({ error: "Invalid GitHub sign-in request." }, 400);
        const app = activation.template();
        const secret = newGitHubOAuthSecret();
        activation.save(secret.id, { app, verifier: secret.verifier });
        try {
          await store.transaction(function* (q) {
            if (!(yield* permittedSteps(q)))
              throw new Error("Workspace access changed. Sign in again.");
            yield* insertGithubOAuthSteps(q, {
              ...requester,
              stateHash: hash(secret.state),
              secretId: secret.id,
              expectedGeneration: yield* generationSteps(q),
              intent: JSON.stringify({ kind: KIND, scope: yield* scopeSteps(q) }),
              expiresAt: now() + 600_000,
            });
          });
        } catch (error) {
          activation.remove(secret.id);
          throw error;
        }
        return reply({
          authorizationUrl: githubAppAuthorization({
            clientId: app.clientId,
            redirectUri: origin + CALLBACK,
            state: secret.state,
            verifier: secret.verifier,
          }),
        });
      }
      const pending = await find();
      if (!pending)
        return request.method === "PUT"
          ? reply(
              {
                error: "Sign in with GitHub before saving repositories.",
                code: "github_signin_required",
              },
              409,
            )
          : reply({ signedIn: false, mappings: await listed() });
      const secret = activation.read<Secret>(pending.secret_id);
      if (!secret.user || !(await unchanged(pending, secret)))
        return reply(
          {
            error: "Workspace access changed. Sign in with GitHub again.",
            code: "github_signin_required",
          },
          409,
        );
      const body = request.method === "PUT" ? await readWorkspaceJson(request) : null;
      const selection =
        request.method === "PUT" && record(body)
          ? body.installationId
          : url.searchParams.get("installationId");
      if (selection !== null && (typeof selection !== "string" || !/^[1-9][0-9]*$/.test(selection)))
        return reply({ error: "Choose a GitHub account." }, 400);
      const [choices, teams] = await Promise.all([
        githubRepositoryChoices(
          secret.app,
          secret.user.token,
          selection as string | null,
          signal,
          http,
        ),
        options.teams(request, signal),
      ]);
      if (!(await unchanged(pending, secret))) return denied();
      if (request.method === "GET")
        return reply({
          signedIn: true,
          setupId: pending.state_hash,
          login: secret.user.login,
          ...choices,
          teams,
          mappings: await listed(),
        });
      if (choices.missingPermissions.length)
        return reply(
          {
            code: "github_permissions_required",
            error: "Approve the required GitHub App permissions before saving repository access.",
          },
          409,
        );
      if (
        !record(body) ||
        Object.keys(body).some((key) => !["installationId", "mappings", "setupId"].includes(key)) ||
        body.setupId !== pending.state_hash ||
        !Array.isArray(body.mappings) ||
        body.mappings.length > 100 ||
        !choices.installationId
      )
        return reply({ error: "Choose repositories and their Linear teams." }, 400);
      const mappings: { repository: string; teamId: string }[] = [];
      const seen = new Set<string>();
      for (const entry of body.mappings) {
        if (
          !record(entry) ||
          Object.keys(entry).length !== 2 ||
          typeof entry.repository !== "string" ||
          typeof entry.teamId !== "string" ||
          !choices.repositories.some((repo) => repo.repository === entry.repository) ||
          !teams.some((team) => team.id === entry.teamId)
        )
          return reply({ error: "Choose an available repository and Linear team." }, 400);
        const key = `${entry.repository}:${entry.teamId}`;
        if (seen.has(key))
          return reply({ error: "Choose each repository and team only once." }, 400);
        seen.add(key);
        mappings.push({ repository: entry.repository, teamId: entry.teamId });
      }
      const repositories = [...new Set(mappings.map((entry) => entry.repository))].sort();
      await verifyHostedGitHubRepositories({
        app: secret.app,
        user: secret.user,
        installationId: choices.installationId,
        repositories,
        signal,
        fetch: http,
      });
      const currentTeams = await options.teams(request, signal);
      if (mappings.some((entry) => !currentTeams.some((team) => team.id === entry.teamId)))
        return reply({ error: "Linear team access changed. Refresh and try again." }, 409);
      signal.throwIfAborted();
      const activeId = randomUUID();
      activation.save(activeId, { ...secret.app, installationId: choices.installationId });
      let committed = false;
      try {
        const job = { ready: false };
        const result = await store.transaction(function* (q) {
          if (!(yield* unchangedSteps(q, pending, secret))) return denied();
          yield* q.transaction((savepoint) =>
            replaceWorkspaceRepositoriesSteps(savepoint, {
              workspaceId,
              actorId: userId,
              repositories: mappings,
              now: now(),
            }),
          );
          yield* ensureGithubConnectionSteps(q, workspaceId);
          if (
            !(yield* advanceGithubConnectionSteps(q, {
              workspaceId,
              expectedGeneration: pending.expected_generation,
              secretId: activeId,
              actorId: userId,
              installationId: choices.installationId,
              repositories,
            }))
          )
            throw new Error("A newer GitHub connection is active. Refresh and try again.");
          yield* updateGithubOAuthIntentSteps(
            q,
            pending.state_hash,
            pending.expected_generation + 1,
            JSON.stringify({ kind: KIND, scope: yield* scopeSteps(q) }),
          );
          yield* auditWorkspaceAccessSteps(q, {
            workspaceId,
            userId,
            action: "github.connect.activated",
            subject: `${secret.app.appId}:${choices.installationId}:${secret.user!.id}`,
            now: now(),
          });
          yield* enqueueJobSteps(q, { queue: "github.auth.recover", now: now() });
          job.ready = true;
          return reply({ ok: true });
        });
        if (job.ready) emitJobReady(store);
        committed = result.status === 200;
        return result;
      } finally {
        if (!committed) activation.remove(activeId);
      }
    } catch (caughtError1) {
      journalCaught(caughtError1, "github-repository-setup.createGitHubRepositorySetup.all", null);
      return reply(
        { error: "GitHub setup could not be completed. Refresh or sign in with GitHub again." },
        409,
      );
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
